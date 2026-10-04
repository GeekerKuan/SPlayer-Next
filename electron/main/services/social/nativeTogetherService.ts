import type {
  TogetherControl,
  TogetherPlaybackEnd,
  TogetherSnapshot,
  TogetherSong,
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
}

interface PendingEnd extends TogetherPlaybackEnd {
  at: number;
  candidate?: string;
  sent: boolean;
  failed?: boolean;
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
  constructor(private options: Options) {}

  snapshot(): TogetherSnapshot {
    return structuredClone({
      ...this.state,
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
    this.ordinaryQueue = false;
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
    const keep = new Set([...this.state.songs.map((s) => s.id), ...unique]);
    for (const key of this.metadata.keys()) if (!keep.has(key)) this.metadata.delete(key);
    while (this.metadata.size > 600) this.metadata.delete(this.metadata.keys().next().value!);
    return unique.map(
      (id) => this.metadata.get(id) || { id, name: id, artists: "", durationMs: 0 },
    );
  }
  private async read(): Promise<void> {
    const status = parseRoomResponse(roomStatusSchema, await this.call("roomStatus")).data;
    const info = status.inRoom ? status.roomInfo : null;
    if (!info) {
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
    this.ordinaryQueue = rawMode === undefined || rawMode === null || rawMode === "";
    const changedRoom = this.state.roomId !== info.roomId;
    if (changedRoom) {
      this.metadata.clear();
      this.clientSeq = 0;
      this.commandAt = 0;
    }
    this.versions = playlist.playlist.version;
    this.playMode = playlist.playlist.playMode;
    this.randomList = playlist.playlist.randomList?.result || [];
    const ids = playlist.playlist.displayList.result;
    const recommendations = playlist.playlist.displayList.rcmdSongIds || [];
    const all = await this.songs([...ids, ...recommendations]);
    const songs = ids.map((id) => all.find((s) => s.id === id)!);
    const command = playlist.playCommand;
    const newer = !!command && (changedRoom || command.serverSeq > (this.state.commandSeq || 0));
    if (newer && command) {
      this.commandAt = Date.now();
      this.commandProgress = command.progress;
    }
    const songId = newer && command ? command.targetSongId : changedRoom ? "" : this.state.songId;
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
      recommendationMode: playlist.playlist.listMode,
      recommendations: recommendations.map((id) => all.find((s) => s.id === id)!),
      updatedAt: Date.now(),
      ...(!this.ownedRoom ? { error: "room-not-owned" } : {}),
    };
    this.options.ownership(this.ownedRoom, this.ownedRoom ? songId : "");
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
            const notQueued = (song: TogetherSong): boolean =>
              !this.state.songs.some((queued) => queued.id === song.id);
            candidate = this.state.recommendations?.find(notQueued);
            if (!candidate)
              candidate = decodeRecommendations(await this.call("recommendations")).find(notQueued);
            if (candidate && !this.metadata.has(candidate.id)) await this.songs([candidate.id]);
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
              await this.read();
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
  private async mutation(operation: () => Promise<void>): Promise<TogetherSnapshot> {
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
      await this.read();
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
    requireRoomResult(
      await this.call("roomCommand", {
        roomId: this.ownedRoom,
        commandInfo: JSON.stringify({
          commandType,
          playStatus,
          progress: Math.round(progress),
          formerSongId: this.state.songId || target,
          targetSongId: target,
          clientSeq: ++this.clientSeq,
        }),
      }),
    );
    this.commandAt = Date.now();
    this.commandProgress = progress;
    this.state = {
      ...this.state,
      songId: target,
      playing: playStatus === "PLAY",
      progressMs: progress,
      playbackRevision: (this.state.playbackRevision || 0) + 1,
    };
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
      await this.command(input);
    });
  }
  private async addSong(songId: string): Promise<void> {
    this.requireOwned();
    if (this.state.songs.some((s) => s.id === songId)) throw new Error("already-in-queue");
    if (this.state.songs.length >= 500) throw new Error("queue-full");
    const versions = this.versions.map((v) => ({
      ...v,
      version: String(v.userId) === this.accountId ? v.version + 1 : v.version,
    }));
    // Windows 透传已有 version，仅在缺少本机项时用数字 UID 建立新项。
    if (!versions.some((v) => String(v.userId) === this.accountId))
      versions.push({ userId: Number(this.accountId), version: 1 });
    requireRoomResult(
      await this.call("roomAdd", {
        roomId: this.ownedRoom,
        playlistParam: JSON.stringify({
          commandType: "ADD",
          version: versions,
          playMode: this.playMode,
          anchorSongId: this.state.songId,
          anchorPosition: this.state.songs.findIndex((s) => s.id === this.state.songId),
          randomList: [songId],
          displayList: [songId],
        }),
      }),
    );
  }
  add(songId: string): Promise<TogetherSnapshot> {
    if (!/^[1-9]\d{0,19}$/.test(songId)) throw new Error("invalid-song");
    return this.mutation(async () => {
      this.requireOwned();
      if (!this.metadata.has(songId)) await this.songs([songId]);
      if (!this.metadata.has(songId)) throw new Error("invalid-song");
      if (this.state.songs.some((song) => song.id === songId)) return;
      await this.addSong(songId);
    }).then((next) => {
      if (!next.songs.some((song) => song.id === songId)) throw new Error("room-operation-failed");
      return next;
    });
  }
  async recommendations(): Promise<TogetherSong[]> {
    await this.account();
    if (this.state.recommendations?.length) {
      return structuredClone(this.state.recommendations);
    }
    const songs = decodeRecommendations(await this.call("recommendations"));
    return songs;
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
    const candidate = useCurrent ? current.songId : (await this.recommendations())[0]?.id;
    if (!candidate) throw new Error("no-room-song");
    if (!this.state.songs.some((song) => song.id === candidate)) {
      await this.addSong(candidate);
      await this.read();
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
