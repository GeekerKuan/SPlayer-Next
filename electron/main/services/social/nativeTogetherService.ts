import type {
  TogetherControl,
  TogetherPlaybackEnd,
  TogetherSnapshot,
  TogetherSong,
  TogetherFriendPage,
  TogetherQueueEdit,
} from "@shared/types/together";
import type { SocialSnapshot } from "@shared/types/social";
import type { NativeOperation, NativeTransport } from "./netease-native/transport";
import { decodeRecommendations } from "./netease-native/desktopActions";
import {
  decodeRoomSongs,
  requireRoomResult,
  roomInfoSchema,
  roomPlaylistSchema,
  roomStatusSchema,
  parseRoomResponse,
} from "./netease-native/roomCodec";
import { emptyTogetherSnapshot } from "./togetherService";
import { isTogetherShortLink } from "../../../../shared/utils/togetherLink";

interface Options {
  diagnostic?: (fields: {
    acknowledged?: boolean;
    confirmationAttempt?: number;
    confirmed?: boolean;
  }) => void;
  loadResume?: () => Promise<{ accountId: string; roomId: string; joinedAt: number } | null>;
  saveResume?: (
    value: { accountId: string; roomId: string; joinedAt: number } | null,
  ) => Promise<void>;
  account: () => Promise<SocialSnapshot>;
  transport: NativeTransport;
  update: (snapshot: TogetherSnapshot) => void;
  ownership: (roomId: string, songId: string) => void;
  halt: () => void;
  playback: () => {
    songId: string;
    playing: boolean;
    progressMs: number;
    ready: boolean;
    finished: boolean;
  };
  autoRecommend: () => boolean;
  songSource?: () => "recommended" | "room" | "history";
}

interface PendingEnd extends TogetherPlaybackEnd {
  at: number;
  candidate?: string;
  sent: boolean;
  failed?: boolean;
}

interface PendingPlayback {
  roomId: string;
  songId: string;
  playing: boolean;
  progressMs: number;
  at: number;
  serverSeq: number;
  until: number;
  songs?: TogetherSong[];
}
interface PendingQueue {
  roomId: string;
  kind: "ADD" | "DELETE" | "REPLACE";
  ids: string[];
  versions: { userId: string | number; version: number; outerId?: string | null }[];
  until: number;
}

/** 独立 HTTP 房间不依赖 CDP；应用拥有已加入房间，页面卸载仅停止页面订阅。 */
export class NativeTogetherService {
  private state: TogetherSnapshot = {
    ...emptyTogetherSnapshot(),
    mode: "native",
    playbackOwned: false,
    commandSeq: 0,
  };
  private accountId = "";
  private ownedRoom = "";
  private creatorId = "";
  private controller = new AbortController();
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private pollFinished: Promise<void> | null = null;
  private active = false;
  private failures = 0;
  private lastHeartbeat = 0;
  private lastMutation = 0;
  private clientSeq = 0;
  private versions: { userId: string | number; version: number; outerId?: string | null }[] = [];
  private playMode = "ORDER_LOOP";
  private ordinaryQueue = false;
  private randomList: string[] = [];
  private metadata = new Map<string, TogetherSong>();
  private commandAt = 0;
  private commandProgress = 0;
  private pendingEnd: PendingEnd | null = null;
  private pendingPlayback: PendingPlayback | null = null;
  private pendingQueue: PendingQueue | null = null;
  private tailAttempt: { roomId: string; songId: string; candidate?: string } | null = null;
  private recommendationCache: { key: string; at: number; songs: TogetherSong[] } | null = null;
  private recommendationJob: { key: string; promise: Promise<TogetherSong[]> } | null = null;
  private historyIds: string[] = [];
  private friendPages = new Map<string, { at: number; promise: Promise<TogetherFriendPage> }>();
  constructor(private options: Options) {}

  snapshot(): TogetherSnapshot {
    return structuredClone({
      ...this.state,
      ...(this.pendingPlayback
        ? {
            songId: this.pendingPlayback.songId,
            playing: this.pendingPlayback.playing,
            progressMs: Math.min(
              (this.pendingPlayback.songs || this.state.songs).find(
                (s) => s.id === this.pendingPlayback!.songId,
              )?.durationMs || 86400000,
              this.pendingPlayback.progressMs +
                (this.pendingPlayback.playing
                  ? Math.max(0, Date.now() - this.pendingPlayback.at)
                  : 0),
            ),
            songs: this.pendingPlayback.songs || this.state.songs,
          }
        : {}),
      awaitingNext: !!this.pendingEnd,
      ...(this.pendingEnd?.failed ? { error: "room-next-unconfirmed" } : {}),
    });
  }
  private publish(): TogetherSnapshot {
    const next = this.snapshot();
    this.options.update(next);
    return next;
  }
  private async account(): Promise<void> {
    const epoch = this.epoch;
    const current = await this.options.account();
    if (epoch !== this.epoch) throw new Error("cancelled");
    if (!current.accountId || current.status === "auth-required") throw new Error("auth-required");
    if (this.accountId && this.accountId !== current.accountId) {
      this.stop();
      throw new Error("account-changed");
    }
    this.accountId = current.accountId;
  }
  private async call(
    operation: NativeOperation,
    data: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const epoch = this.epoch;
    await this.account();
    if (epoch !== this.epoch) throw new Error("cancelled");
    const result = await this.options.transport.call(operation, data, this.controller.signal);
    if (epoch !== this.epoch) throw new Error("cancelled");
    return result;
  }
  async connect(): Promise<TogetherSnapshot> {
    if (this.pollFinished) await this.pollFinished;
    if (this.busy) throw new Error("rate-limited");
    this.active = true;
    this.busy = true;
    const epoch = this.epoch;
    try {
      await this.read();
      if (this.state.roomId && !this.ownedRoom) {
        const resume = await this.options.loadResume?.();
        if (epoch !== this.epoch) throw new Error("cancelled");
        if (resume?.accountId === this.accountId && resume.roomId === this.state.roomId) {
          await this.adoptRoom(resume.roomId);
          await this.read();
        }
      }
      this.schedule();
      return this.publish();
    } catch (error) {
      if (epoch === this.epoch) this.active = !!this.ownedRoom;
      throw error;
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  /** 离开页面不撤销用户已加入的房间，也不停止音频和心跳。 */
  detach(): void {
    if (!this.ownedRoom) this.stop();
  }
  stop(forget = false): void {
    const owned = !!this.ownedRoom;
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
    this.busy = false;
    this.accountId = "";
    this.ownedRoom = "";
    this.metadata.clear();
    this.versions = [];
    this.clientSeq = 0;
    this.lastHeartbeat = 0;
    this.commandAt = 0;
    this.pendingEnd = null;
    this.pendingPlayback = null;
    this.pendingQueue = null;
    this.ordinaryQueue = false;
    this.tailAttempt = null;
    this.recommendationCache = null;
    this.recommendationJob = null;
    this.friendPages.clear();
    this.historyIds = [];
    this.state = {
      ...emptyTogetherSnapshot(),
      mode: "native",
      playbackOwned: false,
      commandSeq: 0,
    };
    this.options.ownership("", "");
    if (owned) this.options.halt();
    if (forget) void this.options.saveResume?.(null).catch(() => {});
    this.publish();
  }
  private async songs(ids: string[]): Promise<TogetherSong[]> {
    const unique = [...new Set(ids)].slice(0, 600);
    const missing = unique.filter((id) => !this.metadata.has(id));
    if (missing.length) {
      const body = await this.call("roomSongs", {
        c: JSON.stringify(missing.map((id) => ({ id }))),
        ids: JSON.stringify(missing),
      });
      for (const song of decodeRoomSongs(body)) this.metadata.set(song.id, song);
    }
    // 保留有限详情缓存，写前刷新不丢弃刚校验的待加歌曲，避免写后重复拉详情。
    while (this.metadata.size > 600) this.metadata.delete(this.metadata.keys().next().value!);
    return unique.map(
      (id) => this.metadata.get(id) || { id, name: id, artists: "", durationMs: 0 },
    );
  }
  private async read(): Promise<void> {
    const status = parseRoomResponse(roomStatusSchema, await this.call("roomStatus")).data;
    const info = status.inRoom ? status.roomInfo : null;
    if (!info) {
      this.pendingPlayback = null;
      this.pendingQueue = null;
      this.pendingEnd = null;
      this.ordinaryQueue = false;
      if (this.ownedRoom) this.options.halt();
      this.ownedRoom = "";
      this.options.ownership("", "");
      this.state = {
        ...emptyTogetherSnapshot(),
        connected: true,
        mode: "native",
        playbackOwned: false,
        commandSeq: 0,
        updatedAt: Date.now(),
      };
      this.versions = [];
      this.metadata.clear();
      return;
    }
    this.creatorId = info.creatorId;
    if (!info.roomUsers.some((u) => u.userId === this.accountId))
      throw new Error("account-mismatch");
    if (this.ownedRoom && this.ownedRoom !== info.roomId) {
      this.ownedRoom = "";
      this.options.halt();
      this.options.ownership("", "");
    }
    const playlistBody = await this.call("roomPlaylist", { roomId: info.roomId });
    const playlist = parseRoomResponse(roomPlaylistSchema, playlistBody).data;
    // 解码器兼容未知模式，但自动补歌只允许已观察的普通列表，避免污染未来模式。
    const rawMode = (playlistBody.data as { playlist?: { listMode?: unknown } })?.playlist
      ?.listMode;
    const heartMode = info.openHeartRcmd === true || playlist.playlist.listMode === "heart";
    this.ordinaryQueue =
      !heartMode && (rawMode === undefined || rawMode === null || rawMode === "");
    if (heartMode !== (this.state.recommendationMode === "heart")) {
      // 服务端负责两份列表切换；不能将旧 ADD 投影或末曲续歌带入新模式。
      this.pendingQueue = null;
      this.pendingPlayback = null;
      this.pendingEnd = null;
      this.tailAttempt = null;
    }
    const changedRoom = this.state.roomId !== info.roomId;
    if (changedRoom) {
      this.pendingPlayback = null;
      this.pendingQueue = null;
      this.metadata.clear();
      this.clientSeq = 0;
      this.commandAt = 0;
    }
    this.versions = playlist.playlist.version;
    this.playMode = playlist.playlist.playMode;
    this.randomList = playlist.playlist.randomList?.result || [];
    let ids = playlist.playlist.displayList.result;
    let queueError = "";
    const queued = this.pendingQueue;
    if (queued) {
      const confirmed =
        queued.kind === "ADD"
          ? queued.ids.every((id) => ids.includes(id))
          : queued.kind === "DELETE"
            ? queued.ids.every((id) => !ids.includes(id))
            : queued.ids.filter((id) => ids.includes(id)).join(",") ===
              ids.filter((id) => queued.ids.includes(id)).join(",");
      if (queued.roomId !== info.roomId || confirmed || Date.now() >= queued.until) {
        this.pendingQueue = null;
        if (!confirmed && queued.roomId === info.roomId) queueError = "room-add-unconfirmed";
      } else {
        // 仅覆盖本次增删；保留其他成员新加的曲目。未确认前不叠加第二份列表写请求。
        ids =
          queued.kind === "ADD"
            ? [...ids, ...queued.ids.filter((id) => !ids.includes(id))]
            : queued.kind === "DELETE"
              ? ids.filter((id) => !queued.ids.includes(id))
              : [
                  ...queued.ids.filter((id) => ids.includes(id)),
                  ...ids.filter((id) => !queued.ids.includes(id)),
                ];
        this.versions = queued.versions.map((local) => {
          const remote = this.versions.find((v) => String(v.userId) === String(local.userId));
          return remote && remote.version > local.version ? remote : local;
        });
      }
    }
    const recommendations = playlist.playlist.displayList.rcmdSongIds || [];
    const all = await this.songs([...ids, ...recommendations]);
    const byId = new Map(all.map((song) => [song.id, song]));
    const songs = ids.map((id) => byId.get(id)!);
    const command = playlist.playCommand;
    const intent = this.pendingPlayback;
    let reconcile = false;
    if (
      intent &&
      (intent.roomId !== info.roomId ||
        Date.now() >= intent.until ||
        (command && command.serverSeq > intent.serverSeq))
    ) {
      const echo =
        command &&
        command.targetSongId === intent.songId &&
        (command.playStatus === "PLAY") === intent.playing &&
        Math.abs(command.progress - intent.progressMs) <= 3000;
      if (echo) {
        // 本机已继续播放，不将 ACK 中请求时刻的位置重新写回播放器。
        this.commandProgress =
          intent.progressMs + (intent.playing ? Math.max(0, Date.now() - intent.at) : 0);
        this.commandAt = Date.now();
      } else reconcile = true;
      this.pendingPlayback = null;
    }
    const newer =
      !!command && (changedRoom || reconcile || command.serverSeq > (this.state.commandSeq || 0));
    if (newer && command && (!intent || reconcile)) {
      this.commandAt = Date.now();
      this.commandProgress = command.progress;
    }
    const songId = newer && command ? command.targetSongId : changedRoom ? "" : this.state.songId;
    if (
      this.tailAttempt &&
      (this.tailAttempt.roomId !== info.roomId || this.tailAttempt.songId !== songId)
    )
      this.tailAttempt = null;
    const playing =
      newer && command ? command.playStatus === "PLAY" : changedRoom ? false : this.state.playing;
    const progressMs = playing
      ? this.commandProgress + Math.max(0, Date.now() - this.commandAt)
      : this.commandProgress;
    this.clientSeq = Math.max(this.clientSeq, command?.clientSeq || 0);
    this.state = {
      connected: true,
      mode: "native",
      playbackOwned: this.ownedRoom === info.roomId,
      status:
        info.roomUsers.length < 2
          ? "waiting"
          : info.creatorId === this.accountId
            ? "togetherOwner"
            : "together",
      roomId: info.roomId,
      creatorId: info.creatorId,
      members: info.roomUsers.map((u) => ({
        id: u.userId,
        name: u.nickname || u.userId,
        avatar: u.avatarUrl,
      })),
      effectiveDurationMs: info.effectiveDurationMs,
      songs,
      songId,
      playing,
      progressMs: Math.min(songs.find((s) => s.id === songId)?.durationMs || 86400000, progressMs),
      commandSeq:
        command?.serverSeq && newer ? command.serverSeq : changedRoom ? 0 : this.state.commandSeq,
      playbackRevision: changedRoom ? 1 : (this.state.playbackRevision || 0) + (newer ? 1 : 0),
      playMode: playlist.playlist.playMode,
      recommendationMode: heartMode ? "heart" : undefined,
      recommendations: recommendations.map((id) => byId.get(id)!),
      updatedAt: Date.now(),
      ...(queueError ? { error: queueError } : !this.ownedRoom ? { error: "room-not-owned" } : {}),
    };
    this.options.ownership(this.ownedRoom, this.ownedRoom ? this.snapshot().songId : "");
    if (this.pendingEnd && !this.matchesEnd(this.pendingEnd)) this.pendingEnd = null;
  }
  private schedule(delayMs?: number): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(
      async () => {
        this.timer = null;
        const epoch = this.epoch;
        if (!this.busy) {
          let finish!: () => void;
          this.pollFinished = new Promise((resolve) => {
            finish = resolve;
          });
          this.busy = true;
          try {
            await this.read();
            await this.extendPlayingTail();
            await this.continueEnded();
            if (this.ownedRoom && Date.now() - this.lastHeartbeat >= 20000) await this.heartbeat();
            this.failures = 0;
            this.publish();
          } catch (error) {
            if (epoch !== this.epoch) return;
            const message = error instanceof Error ? error.message : "offline";
            if (
              [
                "auth-required",
                "account-changed",
                "account-mismatch",
                "api-488",
                "room-expired",
              ].includes(message)
            ) {
              this.stop();
              this.state = { ...this.state, status: "timeout", error: message };
              this.publish();
              return;
            }
            this.failures = Math.min(4, this.failures + 1);
            if (this.failures === 3 && this.ownedRoom) this.options.halt();
            this.state = { ...this.state, connected: false, error: message };
            this.publish();
          } finally {
            if (epoch === this.epoch) this.busy = false;
            finish();
            this.pollFinished = null;
          }
        }
        if (epoch === this.epoch) this.schedule();
      },
      delayMs ?? Math.min(15000, 2000 * 2 ** this.failures),
    );
    this.timer.unref?.();
  }
  private requireOwned(): void {
    if (!this.ownedRoom || this.ownedRoom !== this.state.roomId) throw new Error("room-not-owned");
  }
  /** 自然结束仍由原播放器结算统计/定时关闭；主进程核对真实引擎与房间版本。 */
  notifyEnded(input: TogetherPlaybackEnd): void {
    if (this.pendingEnd || !this.active || !this.matchesEnd(input)) return;
    const playback = this.options.playback();
    if (!playback.finished || playback.songId !== input.songId) return;
    this.pendingEnd = { ...input, at: Date.now(), sent: false };
    this.publish();
    if (!this.busy) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.schedule(0);
    }
  }
  private matchesEnd(input: TogetherPlaybackEnd): boolean {
    return (
      !!this.ownedRoom &&
      this.ownedRoom === input.roomId &&
      this.state.roomId === input.roomId &&
      this.state.songId === input.songId &&
      this.state.commandSeq === input.commandSeq &&
      this.state.playing
    );
  }
  /** 房主先行；四秒无新指令时，仅最小 UID 房员接续，不伪造服务器角色迁移。 */
  private canContinue(end: PendingEnd): boolean {
    if (this.pendingEnd !== end || !this.matchesEnd(end)) return false;
    if (this.creatorId === this.accountId) return true;
    if (Date.now() - end.at < 4000) return false;
    const peers = this.state.members
      .map((member) => member.id)
      .filter((id) => id !== this.creatorId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    return peers[0] === this.accountId;
  }
  /** 使用既有轮询串行续歌，不重放结果未知的 ADD/NEXT，也不替换整队列。 */
  private async continueEnded(): Promise<void> {
    const end = this.pendingEnd;
    if (!end || end.sent || !this.canContinue(end)) return;
    if (
      !end.candidate &&
      this.tailAttempt?.candidate &&
      this.tailAttempt.roomId === end.roomId &&
      this.tailAttempt.songId === end.songId
    )
      end.candidate = this.tailAttempt.candidate;
    try {
      if (
        !end.candidate &&
        this.options.autoRecommend() &&
        this.ordinaryQueue &&
        this.playMode !== "SINGLE_LOOP" &&
        this.state.songs.length < 500
      ) {
        const order =
          this.playMode === "RANDOM" && this.randomList.length
            ? this.randomList
            : this.state.songs.map((song) => song.id);
        if (order.at(-1) === end.songId) {
          let candidate: TogetherSong | undefined;
          let valid = false;
          try {
            candidate = await this.tailRecommendation();
            valid = !!candidate && this.metadata.has(candidate.id);
          } catch (error) {
            if (
              this.controller.signal.aborted ||
              /cancelled|account-|auth-required/.test(error instanceof Error ? error.message : "")
            )
              throw error;
            // 推荐读取失败仍可续播原列表；不把推荐故障当作房间失效。
          }
          await this.read();
          if (!this.canContinue(end)) return;
          const currentOrder =
            this.playMode === "RANDOM" && this.randomList.length
              ? this.randomList
              : this.state.songs.map((song) => song.id);
          if (
            candidate &&
            valid &&
            currentOrder.at(-1) === end.songId &&
            this.state.songs.length < 500 &&
            this.ordinaryQueue &&
            this.playMode !== "SINGLE_LOOP" &&
            this.options.autoRecommend()
          ) {
            // 发送前保存候选；未知结果只读确认，不再次发送相同 ADD。
            end.candidate = candidate.id;
            if (!this.state.songs.some((song) => song.id === candidate.id)) {
              await this.addSong(candidate.id);
            }
          }
        }
      }
      if (!this.canContinue(end)) return;
      if (end.candidate && !this.state.songs.some((song) => song.id === end.candidate)) {
        end.failed = true;
        return;
      }
      // 必须在 await 前标记，迟到响应与重复 ended 不能重发切歌。
      end.sent = true;
      await this.command(
        this.playMode === "SINGLE_LOOP"
          ? { action: "goto", songId: end.songId }
          : { action: "next" },
      );
      await this.read();
    } catch (error) {
      if (this.pendingEnd === end) end.failed = true;
      throw error;
    }
  }
  /** 末曲开始播放后由本机房主补一首；沿用原轮询，不增加周期请求或多房员抢写。 */
  private async extendPlayingTail(): Promise<void> {
    const { roomId, songId } = this.state;
    const eligible = (): boolean =>
      this.ownedRoom === roomId &&
      this.creatorId === this.accountId &&
      this.state.roomId === roomId &&
      this.state.songId === songId &&
      this.state.playing &&
      !this.pendingEnd &&
      this.options.autoRecommend() &&
      this.ordinaryQueue &&
      this.playMode !== "SINGLE_LOOP" &&
      this.state.songs.length < 500 &&
      (this.playMode === "RANDOM" && this.randomList.length
        ? this.randomList
        : this.state.songs.map((song) => song.id)
      ).at(-1) === songId;
    if (!eligible() || (this.tailAttempt?.roomId === roomId && this.tailAttempt.songId === songId))
      return;
    const attempt = { roomId, songId, candidate: undefined as string | undefined };
    this.tailAttempt = attempt;
    try {
      const candidate = await this.tailRecommendation();
      if (!candidate) return;
      await this.read();
      if (!eligible() || this.tailAttempt !== attempt) return;
      // 在 await 写请求前记录，结束事件和未知响应不得再次提交同一首。
      attempt.candidate = candidate.id;
      if (!this.state.songs.some((song) => song.id === candidate.id))
        await this.addSong(candidate.id);
    } catch (error) {
      const code = error instanceof Error ? error.message : "offline";
      if (/cancelled|account-|auth-required|room-changed|room-expired/.test(code)) throw error;
      this.state = { ...this.state, error: code };
    }
  }
  /** 房间候选耗尽后读取短时缓存的个人推荐，先验证详情，不替换整队列。 */
  private async tailRecommendation(): Promise<TogetherSong | undefined> {
    const queued = new Set(this.state.songs.map((song) => song.id));
    const notQueued = (song: TogetherSong): boolean => !queued.has(song.id);
    const source = this.options.songSource?.() || "room";
    if (source === "history") {
      const id = this.historyIds.find((id) => !queued.has(id));
      if (!id) return;
      await this.songs([id]);
      return this.metadata.get(id);
    }
    let candidate = source === "room" ? this.state.recommendations?.find(notQueued) : undefined;
    if (!candidate) candidate = (await this.personalRecommendations()).find(notQueued);
    if (candidate && !this.metadata.has(candidate.id)) await this.songs([candidate.id]);
    return candidate && this.metadata.has(candidate.id) ? candidate : undefined;
  }
  private async heartbeat(adoptingRoom?: string): Promise<void> {
    if (adoptingRoom) {
      if (adoptingRoom !== this.state.roomId) throw new Error("room-changed");
    } else this.requireOwned();
    const playback = this.options.playback();
    const matches = playback.ready && playback.songId === this.state.songId;
    if (!this.state.songId) return;
    const result = await this.call("roomHeartbeat", {
      roomId: adoptingRoom || this.ownedRoom,
      songId: this.state.songId,
      playStatus: (adoptingRoom || !matches ? this.state.playing : playback.playing)
        ? "PLAY"
        : "PAUSE",
      progress: Math.max(
        1,
        Math.round(adoptingRoom || !matches ? this.state.progressMs : playback.progressMs),
      ),
    });
    try {
      requireRoomResult(result);
    } catch {
      throw new Error("room-expired");
    }
    this.lastHeartbeat = Date.now();
  }
  /** 接管确认使用房间状态，避免尚未切换的本机音频污染首轮心跳。 */
  private async adoptRoom(roomId: string): Promise<void> {
    await this.heartbeat(roomId);
    await this.read();
    if (this.state.roomId !== roomId) throw new Error("room-changed");
    this.ownedRoom = roomId;
    this.options.halt();
    const epoch = this.epoch;
    await this.options.saveResume?.({
      accountId: this.accountId,
      roomId,
      joinedAt: Date.now(),
    });
    if (epoch !== this.epoch) throw new Error("cancelled");
  }
  private async mutation(
    operation: () => Promise<void>,
    readAfter = true,
  ): Promise<TogetherSnapshot> {
    const waitingEpoch = this.epoch;
    if (this.pollFinished) await this.pollFinished;
    if (waitingEpoch !== this.epoch) throw new Error("cancelled");
    if (this.busy || Date.now() - this.lastMutation < 500) throw new Error("rate-limited");
    this.busy = true;
    this.lastMutation = Date.now();
    const epoch = this.epoch;
    try {
      await operation();
      if (epoch !== this.epoch) throw new Error("cancelled");
      if (readAfter) await this.read();
      if (epoch !== this.epoch) throw new Error("cancelled");
      this.active = true;
      this.schedule();
      return this.publish();
    } catch (error) {
      if (epoch === this.epoch) {
        const message = error instanceof Error ? error.message : "offline";
        if (["room-expired", "api-488", "auth-required", "account-mismatch"].includes(message))
          this.stop(true);
        else if (this.ownedRoom) {
          this.active = true;
          this.schedule();
        }
        this.state = { ...this.state, error: message };
        this.publish();
      }
      throw error;
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  private async command(
    input: TogetherControl,
    initial?: { playing: boolean; progressMs: number },
  ): Promise<void> {
    this.requireOwned();
    const list = this.state.songs;
    let target = this.state.songId;
    if (input.action === "goto") target = input.songId;
    if (input.action === "next" || input.action === "previous") {
      const order =
        this.playMode === "RANDOM" && this.randomList.length
          ? this.randomList
          : list.map((s) => s.id);
      const index = order.indexOf(target);
      target =
        order[(index + (input.action === "next" ? 1 : order.length - 1)) % order.length] || "";
    }
    if (!list.some((s) => s.id === target)) throw new Error("invalid-song");
    const playback = this.options.playback();
    // 仅本账号新建房间的首个 GOTO 可携带普通播放进度；接管/入房不传 initial。
    const progress =
      initial && input.action === "goto"
        ? initial.progressMs
        : input.action === "seek"
          ? input.positionMs
          : ["next", "previous", "goto"].includes(input.action)
            ? 0
            : playback.ready && playback.songId === target
              ? playback.progressMs
              : this.state.progressMs;
    if (progress > (list.find((s) => s.id === target)?.durationMs || 86400000))
      throw new Error("invalid-position");
    const commandType = {
      pause: "PAUSE",
      resume: "PLAY",
      next: "NEXT",
      previous: "PREVIOUS",
      seek: "PROGRESS",
      goto: "GOTO",
    }[input.action];
    const playStatus =
      initial && input.action === "goto"
        ? initial.playing
          ? "PLAY"
          : "PAUSE"
        : input.action === "pause"
          ? "PAUSE"
          : input.action === "seek"
            ? this.state.playing
              ? "PLAY"
              : "PAUSE"
            : "PLAY";
    const previous = this.state;
    const formerSongId = previous.songId || target;
    const existing = this.pendingPlayback;
    const intent: PendingPlayback =
      existing && existing.songId === target && input.action === "goto"
        ? existing
        : {
            roomId: this.ownedRoom,
            songId: target,
            playing: playStatus === "PLAY",
            progressMs: progress,
            at: Date.now(),
            serverSeq: this.state.commandSeq || 0,
            until: Date.now() + 15000,
          };
    this.pendingPlayback = intent;
    this.state = {
      ...this.state,
      songId: target,
      playing: intent.playing,
      progressMs: intent.progressMs,
      playbackRevision: (this.state.playbackRevision || 0) + 1,
    };
    this.options.ownership(this.ownedRoom, target);
    this.publish();
    try {
      requireRoomResult(
        await this.call("roomCommand", {
          roomId: this.ownedRoom,
          commandInfo: JSON.stringify({
            commandType,
            playStatus,
            progress: Math.round(progress),
            formerSongId,
            targetSongId: target,
            clientSeq: ++this.clientSeq,
          }),
        }),
      );
      this.commandAt = intent.at;
      this.commandProgress = intent.progressMs;
      intent.songs = undefined;
    } catch (error) {
      if (this.pendingPlayback === intent) {
        this.pendingPlayback = null;
        this.state = previous;
        this.options.ownership(this.ownedRoom, previous.songId);
      }
      throw error;
    }
  }
  control(input: TogetherControl): Promise<TogetherSnapshot> {
    const end = this.pendingEnd;
    // 手动操作先取消等待，正在读推荐的后台任务不能抢在用户请求前切歌。
    this.pendingEnd = null;
    return this.mutation(async () => {
      if (end?.sent && this.state.songId !== end.songId) {
        if (input.action === "next") return;
        if (input.action === "seek") throw new Error("cancelled");
      }
      const cachedOrder =
        this.playMode === "RANDOM" && this.randomList.length
          ? this.randomList
          : this.state.songs.map((song) => song.id);
      if (
        input.action === "next" &&
        this.options.autoRecommend() &&
        this.ordinaryQueue &&
        this.playMode !== "SINGLE_LOOP" &&
        cachedOrder.at(-1) === this.state.songId
      ) {
        this.requireOwned();
        const roomId = this.ownedRoom;
        await this.read();
        this.requireOwned();
        if (this.ownedRoom !== roomId) throw new Error("room-changed");
        const order =
          this.playMode === "RANDOM" && this.randomList.length
            ? this.randomList
            : this.state.songs.map((song) => song.id);
        if (
          order.at(-1) === this.state.songId &&
          this.options.autoRecommend() &&
          this.ordinaryQueue &&
          this.playMode !== "SINGLE_LOOP"
        ) {
          const tail = this.tailAttempt;
          const cachedCandidate =
            tail?.candidate && tail.roomId === this.ownedRoom && tail.songId === this.state.songId
              ? tail.candidate
              : undefined;
          const songId = this.state.songId;
          const candidate = cachedCandidate ?? (await this.tailRecommendation())?.id;
          if (!cachedCandidate) {
            // 推荐读取期间对方可能切换心动模式；重读后不能把旧候选插入新列表。
            await this.read();
            this.requireOwned();
            if (this.ownedRoom !== roomId) throw new Error("room-changed");
            if (
              !this.ordinaryQueue ||
              this.state.songId !== songId ||
              !this.options.autoRecommend() ||
              this.playMode === "SINGLE_LOOP"
            ) {
              await this.command(input);
              return;
            }
          }
          if (!candidate) throw new Error("no-room-song");
          if (!this.state.songs.some((song) => song.id === candidate)) {
            if (tail?.candidate === candidate) throw new Error("room-add-unconfirmed");
            this.tailAttempt = { roomId: this.ownedRoom, songId: this.state.songId, candidate };
            await this.addSong(candidate);
          }
          await this.command(input);
          return;
        }
      }
      await this.command(input);
    });
  }
  /** 复用 Windows 列表上报，受理不等于最终确认；由现有轮询在截止窗口内回收。 */
  private async reportQueue(
    kind: PendingQueue["kind"],
    ids: string[],
    optimistic = true,
  ): Promise<void> {
    if (this.pendingQueue) throw new Error("rate-limited");
    const versions = this.versions.map((v) => ({
      ...v,
      version: String(v.userId) === this.accountId ? v.version + 1 : v.version,
    }));
    if (!versions.some((v) => String(v.userId) === this.accountId))
      versions.push({ userId: Number(this.accountId), version: 1 });
    const body = await this.call("roomAdd", {
      roomId: this.ownedRoom,
      playlistParam: JSON.stringify({
        commandType: kind,
        version: versions,
        playMode: this.playMode,
        anchorSongId: kind === "ADD" ? this.state.songId : "",
        anchorPosition:
          kind === "ADD" ? this.state.songs.findIndex((s) => s.id === this.state.songId) : -1,
        randomList:
          kind === "REPLACE" && this.playMode === "RANDOM"
            ? [
                ...this.randomList.filter((id) => ids.includes(id)),
                ...ids.filter((id) => !this.randomList.includes(id)),
              ]
            : ids,
        displayList: ids,
      }),
    });
    const ack = (body.data as { result?: unknown } | undefined)?.result;
    this.options.diagnostic?.({ acknowledged: typeof ack === "boolean" ? ack : undefined });
    // 官方 Windows 列表上报按 code=200 或 data.result 接受；此规则不扩展到控制/心跳。
    if (body.code !== 200 && ack !== true) throw new Error("room-operation-failed");
    this.versions = versions;
    if (!optimistic) return;
    this.pendingQueue = { roomId: this.ownedRoom, kind, ids, versions, until: Date.now() + 15000 };
    const list = this.state.songs;
    this.state = {
      ...this.state,
      songs:
        kind === "ADD"
          ? [
              ...list,
              ...ids
                .filter((id) => !list.some((s) => s.id === id))
                .map((id) => this.metadata.get(id)!),
            ]
          : kind === "DELETE"
            ? list.filter((s) => !ids.includes(s.id))
            : ids.map((id) => list.find((s) => s.id === id)!),
      updatedAt: Date.now(),
    };
  }

  /** 单曲与播放全部共用一次操作：本地先播放，增量 ADD 后仅发送一条 GOTO。 */
  play(input: string[], startIndex: number): Promise<TogetherSnapshot> {
    if (
      !input.length ||
      input.length > 500 ||
      input.some((id) => !/^[1-9]\d{0,19}$/.test(id)) ||
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex >= input.length
    )
      throw new Error("invalid-song");
    const target = input[startIndex];
    const ids = [...new Set(input)];
    this.pendingEnd = null;
    return this.mutation(async () => {
      this.requireOwned();
      const roomId = this.ownedRoom;
      const capacity = new Set([...this.state.songs.map((s) => s.id), ...ids]).size;
      if (capacity > 500) throw new Error("queue-full");
      await this.songs(ids);
      if (ids.some((id) => !this.metadata.has(id))) throw new Error("invalid-song");
      await this.read();
      this.requireOwned();
      if (roomId !== this.ownedRoom) throw new Error("room-changed");
      const missing = ids.filter((id) => !this.state.songs.some((s) => s.id === id));
      if (missing.length + this.state.songs.length > 500) throw new Error("queue-full");
      if (missing.length && this.pendingQueue) throw new Error("rate-limited");
      const playback = this.options.playback();
      const keepCurrent =
        playback.ready && playback.songId === target && this.state.songId === target;
      const intent: PendingPlayback = {
        roomId,
        songId: target,
        playing: true,
        progressMs: keepCurrent ? playback.progressMs : 0,
        at: Date.now(),
        serverSeq: this.state.commandSeq || 0,
        until: Date.now() + 15000,
        songs: [...this.state.songs, ...missing.map((id) => this.metadata.get(id)!)],
      };
      this.pendingPlayback = intent;
      this.options.ownership(roomId, target);
      this.publish();
      try {
        if (missing.length) await this.addSong(missing, false);
        await this.command(keepCurrent ? { action: "resume" } : { action: "goto", songId: target });
      } catch (error) {
        if (this.pendingPlayback === intent) this.pendingPlayback = null;
        this.options.ownership(this.ownedRoom, this.state.songId);
        throw error;
      }
    });
  }

  /** 本地队列使用曲目 ID 和相对位置修改房间；清空时保留服务端当前曲。 */
  editQueue(input: TogetherQueueEdit): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      this.requireOwned();
      const roomId = this.ownedRoom;
      await this.read();
      this.requireOwned();
      if (roomId !== this.ownedRoom) throw new Error("room-changed");
      if (input.action === "clear") {
        const ids = this.state.songs
          .filter((s) => s.id !== this.snapshot().songId)
          .map((s) => s.id);
        if (ids.length) await this.reportQueue("DELETE", ids);
      } else if (input.action === "remove") {
        if (!this.state.songs.some((s) => s.id === input.songId)) return;
        if (this.snapshot().songId === input.songId) throw new Error("room-current-song");
        await this.reportQueue("DELETE", [input.songId]);
      } else {
        if (input.beforeId === input.songId) return;
        const ids = this.state.songs.map((s) => s.id);
        if (!ids.includes(input.songId) || (input.beforeId && !ids.includes(input.beforeId)))
          throw new Error("invalid-song");
        const reordered = ids.filter((id) => id !== input.songId);
        reordered.splice(
          input.beforeId ? reordered.indexOf(input.beforeId) : reordered.length,
          0,
          input.songId,
        );
        if (ids.join(",") !== reordered.join(",")) await this.reportQueue("REPLACE", reordered);
      }
    }, false);
  }

  /** 官方安卓开关只报告本账号意愿；服务端替换/恢复列表，本机不另发 REPLACE。 */
  setHeartRecommendation(enabled: boolean): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      this.requireOwned();
      const roomId = this.ownedRoom;
      await this.read();
      this.requireOwned();
      if (roomId !== this.ownedRoom) throw new Error("room-changed");
      if ((this.state.recommendationMode === "heart") === enabled) return;
      if (this.pendingQueue || this.pendingPlayback) throw new Error("rate-limited");
      this.pendingEnd = null;
      this.tailAttempt = null;
      const body = await this.call("roomHeart", { roomId, status: enabled ? 1 : 0 });
      if ((body.data as { success?: unknown } | undefined)?.success !== true)
        throw new Error("heart-recommendation-unavailable");
      await this.read();
      this.requireOwned();
      if (this.ownedRoom !== roomId) throw new Error("room-changed");
      if ((this.state.recommendationMode === "heart") !== enabled)
        throw new Error("heart-change-unconfirmed");
    }, false);
  }

  private async addSong(input: string | string[], confirm = true): Promise<void> {
    this.requireOwned();
    const songIds = Array.isArray(input) ? input : [input];
    const roomId = this.ownedRoom;
    const epoch = this.epoch;
    if (songIds.some((id) => this.state.songs.some((s) => s.id === id)))
      throw new Error("already-in-queue");
    if (this.state.songs.length + songIds.length > 500) throw new Error("queue-full");
    try {
      await this.reportQueue("ADD", songIds, !confirm);
      if (!confirm) return;
    } catch (error) {
      const code = error instanceof Error ? error.message : "offline";
      if (!["operation-unknown", "room-operation-failed"].includes(code)) throw error;
      // 未知写请求只读核验，不能重放 ADD。
    }
    for (const [attempt, wait] of [0, 300, 900].entries()) {
      if (wait) {
        const signal = this.controller.signal;
        await new Promise<void>((resolve, reject) => {
          signal.throwIfAborted();
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, wait);
          const cancel = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(new Error("cancelled"));
          };
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
      if (epoch !== this.epoch) throw new Error("cancelled");
      await this.read();
      this.requireOwned();
      if (this.ownedRoom !== roomId) throw new Error("room-changed");
      const queued = new Set(this.state.songs.map((song) => song.id));
      const confirmed = songIds.every((id) => queued.has(id));
      this.options.diagnostic?.({ confirmationAttempt: attempt + 1, confirmed });
      if (confirmed) return;
    }
    throw new Error("room-add-unconfirmed");
  }
  add(songId: string): Promise<TogetherSnapshot> {
    return this.addMany([songId]);
  }
  /** 一次增量加入整份歌单；不逐曲提交，不截断容量超限的歌单。 */
  addMany(input: string[]): Promise<TogetherSnapshot> {
    if (!input.length || input.length > 500 || input.some((id) => !/^[1-9]\d{0,19}$/.test(id)))
      throw new Error("invalid-song");
    const ids = [...new Set(input)];
    return this.mutation(async () => {
      this.requireOwned();
      const roomId = this.ownedRoom;
      const knownQueue = new Set(this.state.songs.map((song) => song.id));
      const candidates = ids.filter((id) => !knownQueue.has(id));
      if (!candidates.length) return;
      await this.songs(candidates);
      if (candidates.some((id) => !this.metadata.has(id))) throw new Error("invalid-song");
      // 其他成员可能已改列表；发送前刷新版本向量，不用上一次轮询的旧 version。
      await this.read();
      this.requireOwned();
      if (this.ownedRoom !== roomId) throw new Error("room-changed");
      const queued = new Set(this.state.songs.map((song) => song.id));
      const missing = candidates.filter((id) => !queued.has(id));
      if (missing.length) await this.addSong(missing, false);
      // 已受理的列表由现有轮询核验，不在交互路径连续拉取确认。
    }, false);
  }
  /** 播放历史复用渲染端原生缓存，仅接收有限的网易云曲目 ID，不主动拉取远端历史。 */
  setHistoryCandidates(ids: string[]): void {
    this.requireOwned();
    if (ids.length > 500 || ids.some((id) => !/^[1-9]\d{0,19}$/.test(id)))
      throw new Error("invalid-song");
    this.historyIds = [...new Set(ids)];
  }
  async recommendations(): Promise<TogetherSong[]> {
    await this.account();
    return this.personalRecommendations();
  }
  /** 好友分页只在邀请选择器主动请求时读取；缓存/单飞共享，最多十页，不后台遍历。 */
  async friends(kind: "following" | "followers", offset: number): Promise<TogetherFriendPage> {
    if (!Number.isInteger(offset) || offset < 0 || offset > 400 || offset % 100)
      throw new Error("invalid-input");
    await this.account();
    const key = `${this.accountId}:${kind}:${offset}`;
    const cached = this.friendPages.get(key);
    if (cached && Date.now() - cached.at < 60000) return structuredClone(await cached.promise);
    const promise = this.call(
      kind === "following" ? "userFollows" : "userFollowers",
      kind === "following"
        ? { userId: this.accountId, offset, limit: 100, order: true }
        : { userId: this.accountId, offset, limit: 100, time: "0", getcounts: "true" },
    ).then((body) => {
      const raw = kind === "following" ? body.follow : body.followeds;
      if (!Array.isArray(raw)) throw new Error("invalid-response");
      const items: TogetherFriendPage["items"] = [];
      for (const value of raw.slice(0, 100)) {
        if (!value || typeof value !== "object") continue;
        const friend = value as Record<string, unknown>;
        const id = String(friend.userId);
        if (!/^[1-9]\d{0,19}$/.test(id) || id === this.accountId) continue;
        items.push({
          id,
          name: typeof friend.nickname === "string" ? friend.nickname.slice(0, 100) : id,
          mutual: friend.mutual === true,
        });
      }
      return { items, more: body.more === true && raw.length > 0 && offset < 400 };
    });
    this.friendPages.set(key, { at: Date.now(), promise });
    while (this.friendPages.size > 10)
      this.friendPages.delete(this.friendPages.keys().next().value!);
    try {
      return structuredClone(await promise);
    } catch (error) {
      this.friendPages.delete(key);
      throw error;
    }
  }
  /** 个人推荐兜底与房间候选分开，候选全部已入队时仍能读取个人推荐。 */
  private async personalRecommendations(): Promise<TogetherSong[]> {
    await this.account();
    const key = `${this.accountId}:${this.state.roomId}`;
    if (this.recommendationCache?.key === key && Date.now() - this.recommendationCache.at < 60000)
      return structuredClone(this.recommendationCache.songs);
    if (this.recommendationJob?.key === key)
      return structuredClone(await this.recommendationJob.promise);
    const epoch = this.epoch;
    const promise = this.call("recommendations").then((raw) => {
      if (epoch !== this.epoch || key !== `${this.accountId}:${this.state.roomId}`)
        throw new Error("cancelled");
      const songs = decodeRecommendations(raw);
      this.recommendationCache = { key, at: Date.now(), songs };
      return songs;
    });
    this.recommendationJob = { key, promise };
    try {
      return structuredClone(await promise);
    } finally {
      if (this.recommendationJob?.promise === promise) this.recommendationJob = null;
    }
  }
  async accept(peerId: string, messageId: string): Promise<TogetherSnapshot> {
    const snapshot = await this.options.account();
    const message = snapshot.messages[peerId]?.find((m) => m.id === messageId);
    if (
      message?.kind !== "invite" ||
      !message.invite ||
      message.senderId !== peerId ||
      message.invite.inviterId !== peerId ||
      Date.now() - message.time > 600000
    )
      throw new Error("invitation-expired");
    const invite = message.invite;
    return this.mutation(async () => {
      await this.read();
      if (this.state.roomId) throw new Error("already-in-room");
      const result = await this.call("roomAccept", {
        refer: "inbox_invite",
        roomId: invite.roomId,
        inviterId: invite.inviterId,
      });
      if (!result.data || typeof result.data !== "object") throw new Error("room-operation-failed");
      await this.read();
      if (this.state.roomId !== invite.roomId) throw new Error("room-operation-failed");
      await this.adoptRoom(invite.roomId);
    });
  }
  create(peerId?: string): Promise<TogetherSnapshot> {
    return this.mutation(() => this.createRoom(peerId));
  }
  private async createRoom(peerId?: string): Promise<void> {
    const epoch = this.epoch;
    await this.read();
    if (this.state.roomId) throw new Error("already-in-room");
    if (peerId === this.accountId) throw new Error("invalid-input");
    const result = await this.call("roomCreate", { refer: "songplay_more" });
    const data = result.data as { roomInfo?: unknown } | undefined;
    const info = parseRoomResponse(roomInfoSchema, data?.roomInfo);
    if (
      info.creatorId !== this.accountId ||
      !info.roomUsers.some((member) => member.userId === this.accountId)
    )
      throw new Error("account-mismatch");
    this.ownedRoom = info.roomId;
    // 引擎 stop 会清空位置，必须在停机前取一次完整快照；不留定时器或待用进度。
    const current = this.options.playback();
    this.options.halt();
    await this.read();
    if (this.state.roomId !== info.roomId || this.creatorId !== this.accountId)
      throw new Error("room-changed");
    const useCurrent = current.ready && /^[1-9]\d{0,19}$/.test(current.songId);
    const candidate = useCurrent
      ? current.songId
      : ((this.options.songSource?.() || "room") === "room"
          ? this.state.recommendations?.[0]?.id
          : undefined) || (await this.personalRecommendations())[0]?.id;
    if (!candidate) throw new Error("no-room-song");
    if (!this.state.songs.some((song) => song.id === candidate)) {
      await this.addSong(candidate);
    }
    if (this.state.roomId !== info.roomId || this.creatorId !== this.accountId)
      throw new Error("room-changed");
    const duration = this.state.songs.find((song) => song.id === candidate)?.durationMs || 86400000;
    await this.command(
      { action: "goto", songId: candidate },
      {
        playing: useCurrent ? current.playing : true,
        progressMs:
          useCurrent && Number.isFinite(current.progressMs)
            ? Math.min(duration, Math.max(0, current.progressMs))
            : 0,
      },
    );
    await this.read();
    // 首次心跳沿用刚确认的房间进度，不采样已 stop 的普通引擎。
    await this.heartbeat(info.roomId);
    await this.options.saveResume?.({
      accountId: this.accountId,
      roomId: this.ownedRoom,
      joinedAt: Date.now(),
    });
    if (epoch !== this.epoch) throw new Error("cancelled");
    if (peerId)
      requireRoomResult(
        await this.call("roomInvite", { roomId: this.ownedRoom, acceptorId: peerId }),
      );
  }
  /** 只替换用户刚确认的外部房间；退出结果未知时绝不创建或重放写请求。 */
  replace(expectedRoomId: string): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      await this.read();
      if (this.state.roomId !== expectedRoomId) throw new Error("room-changed");
      if (this.ownedRoom) throw new Error("already-in-room");
      await this.call("roomLeave", { roomId: expectedRoomId });
      await this.read();
      if (this.state.roomId) throw new Error("room-operation-failed");
      await this.options.saveResume?.(null);
      await this.createRoom();
    });
  }
  /** 显式接管当前账号的现存房间，首轮播放沿用服务端状态，随后由既有心跳维护。 */
  takeOver(expectedRoomId: string): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      await this.read();
      if (this.state.roomId !== expectedRoomId) throw new Error("room-changed");
      if (!this.state.members.some((member) => member.id === this.accountId))
        throw new Error("account-mismatch");
      if (this.ownedRoom) throw new Error("already-in-room");
      await this.adoptRoom(expectedRoomId);
    });
  }
  closeExternal(expectedRoomId: string): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      await this.read();
      if (this.state.roomId !== expectedRoomId) throw new Error("room-changed");
      if (this.ownedRoom) throw new Error("already-in-room");
      await this.call("roomLeave", { roomId: expectedRoomId });
      await this.read();
      if (this.state.roomId) throw new Error("room-operation-failed");
      await this.options.saveResume?.(null);
    });
  }
  /** 分享链接遵循官方外部邀请路径，房间存在时绝不自动退出或替换。 */
  joinLink(invite: { roomId: string; inviterId: string }): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      await this.read();
      if (this.state.roomId) throw new Error("already-in-room");
      if (invite.inviterId === this.accountId) throw new Error("invalid-input");
      await this.call("roomAccept", { ...invite, refer: "third_party_invite" });
      await this.read();
      if (
        this.state.roomId !== invite.roomId ||
        !this.state.members.some((member) => member.id === this.accountId)
      )
        throw new Error("room-operation-failed");
      await this.adoptRoom(invite.roomId);
    });
  }
  async invitationLink(): Promise<string> {
    await this.connect();
    this.requireOwned();
    if (this.creatorId !== this.accountId) throw new Error("room-invite-owner-only");
    const roomId = this.ownedRoom;
    const epoch = this.epoch;
    const url = `https://st.music.163.com/listen-together/share/?${new URLSearchParams({ roomId, inviterId: this.accountId, songId: this.state.songId })}`;
    let link = url;
    try {
      const raw = await this.call("shortLink", { url });
      const short = (raw.data as { shortUrl?: unknown } | undefined)?.shortUrl;
      if (typeof short === "string" && isTogetherShortLink(short)) link = short;
    } catch (error) {
      // 短链失败仍可复制官方 H5 地址，不重复提交，也不影响房间心跳。
      if (
        error instanceof Error &&
        ["account-changed", "auth-required", "cancelled"].includes(error.message)
      )
        throw error;
    }
    if (epoch !== this.epoch || roomId !== this.ownedRoom) throw new Error("cancelled");
    return link;
  }
  invite(peerId: string): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      this.requireOwned();
      if (this.creatorId !== this.accountId) throw new Error("room-invite-owner-only");
      if (peerId === this.accountId) throw new Error("invalid-input");
      requireRoomResult(
        await this.call("roomInvite", { roomId: this.ownedRoom, acceptorId: peerId }),
      );
    });
  }
  leave(): Promise<TogetherSnapshot> {
    return this.mutation(async () => {
      this.requireOwned();
      const roomId = this.ownedRoom;
      await this.call("roomLeave", { roomId });
      await this.read();
      if (this.state.roomId === roomId) throw new Error("room-operation-failed");
      this.ownedRoom = "";
      this.options.ownership("", "");
      this.options.halt();
      await this.options.saveResume?.(null);
    });
  }
}
