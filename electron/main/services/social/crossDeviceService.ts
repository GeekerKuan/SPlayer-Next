import { randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  CrossDevicePlayback,
  CrossDeviceSnapshot,
  CrossDeviceSource,
} from "@shared/types/crossDevice";
import type { NativeTransport } from "./netease-native/transport";
import { decodeRecentSongs, decodeRelaySongs } from "./netease-native/recentCodec";

export const relayMode = z.enum(["order", "random", "single_loop", "list_loop"]);
const songId = z.string().regex(/^[1-9]\d{0,19}$/);
export const relaySource = z
  .object({
    songIds: z.array(songId).min(1).max(1000),
    currentId: songId,
    playMode: relayMode,
  })
  .strict()
  .refine((value) => value.songIds.includes(value.currentId));

/** 原生跨端通道：只缓存当前账号，所有请求随停用、换账号和窗口销毁取消。 */
export class CrossDeviceService {
  private token = "";
  private abort = new AbortController();
  private snapshot: CrossDeviceSnapshot = { accountId: "", records: [], canResume: false };
  private refreshedAt = 0;
  private offerCheckedAt = 0;
  private configCheckedAt = 0;
  private offerRetryAt = 0;
  private offerVersion = 0;
  private pending: Promise<CrossDeviceSnapshot> | null = null;
  private offer: Record<string, unknown> | null = null;
  private sessionId = "";
  private sourceKey = "";
  private stateKey = "";
  private publishJob: Promise<void> | null = null;
  private serverEnabled: boolean | null = null;
  private snapshotSize = 1000;
  private latestSource: CrossDeviceSource | null = null;

  constructor(
    private readonly options: {
      transport: NativeTransport;
      token: () => string;
      enabled: () => boolean;
      playbackAllowed: () => boolean;
    },
  ) {}

  /** 账号的响应和续播凭据不能跨账号留存。 */
  cancel(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.token = "";
    this.pending = null;
    this.offer = null;
    this.refreshedAt = 0;
    this.offerCheckedAt = this.configCheckedAt = this.offerRetryAt = 0;
    this.offerVersion++;
    this.sessionId = this.sourceKey = this.stateKey = "";
    this.latestSource = null;
    this.publishJob = null;
    this.serverEnabled = null;
    this.snapshotSize = 1000;
    this.snapshot = { accountId: "", records: [], canResume: false };
  }

  private context(): AbortSignal {
    const token = this.options.token();
    if (token !== this.token) {
      this.cancel();
      this.token = token;
    }
    if (!this.options.enabled()) throw new Error("disabled");
    if (!token) throw new Error("auth-required");
    return this.abort.signal;
  }

  async refresh(): Promise<CrossDeviceSnapshot> {
    const signal = this.context();
    if (this.pending) return this.pending;
    // 历史缓存不应遮住新设备的续播入口；焦点读取限频，不增加后台轮询。
    if (
      Date.now() < this.offerRetryAt ||
      (this.offerCheckedAt && Date.now() - this.offerCheckedAt < 10_000)
    )
      return this.snapshot;
    const offerVersion = this.offerVersion;
    const job = (async () => {
      let accountId = this.snapshot.accountId;
      let records = this.snapshot.records;
      if (!accountId || Date.now() - this.refreshedAt >= 60_000) {
        const account = await this.options.transport.call("account", {}, signal);
        accountId = z
          .object({
            account: z.object({ id: z.union([z.number(), z.string()]).transform(String) }),
          })
          .parse(account).account.id;
        const recent = await this.options.transport.call("recentSongs", { limit: 300 }, signal);
        signal.throwIfAborted();
        records = decodeRecentSongs(recent);
        this.refreshedAt = Date.now();
      }
      let offer: Record<string, unknown> | null = null;
      let resumeError: string | undefined;
      // 最近播放成功时，续播入口异常不应把已取得的历史一起丢掉。
      try {
        if (this.serverEnabled === null || Date.now() - this.configCheckedAt >= 60_000) {
          const config = await this.options.transport.call("relayConfig", {}, signal);
          signal.throwIfAborted();
          this.serverEnabled = (config.data as { enable?: boolean } | undefined)?.enable === true;
          const size = (config.data as { snapshotSize?: unknown } | undefined)?.snapshotSize;
          if (typeof size === "number" && Number.isInteger(size) && size > 0)
            this.snapshotSize = Math.min(size, 1000);
          this.configCheckedAt = Date.now();
        }
        if (this.serverEnabled) {
          const position = await this.options.transport.call(
            "relayPosition",
            {
              positionCode: "multi_terminal_reconnect_info",
              extJson: JSON.stringify({
                interactRecords: [],
                preData: [],
                states: { relayInfo: { current: '{"needCheck":true}', prev: "" } },
              }),
            },
            signal,
          );
          const value = (
            position.data as { commonResourceList?: { generalizedObject?: unknown }[] } | undefined
          )?.commonResourceList?.[0]?.generalizedObject;
          const parsed = z
            .object({ deviceId: z.string().min(1).max(256) })
            .passthrough()
            .safeParse(value);
          if (parsed.success && JSON.stringify(parsed.data).length <= 16_000) offer = parsed.data;
        }
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : "offline";
        if (["auth-required", "account-changed", "disabled"].includes(message)) throw error;
        resumeError = /^(rate-limited|api-\d+|http-\d+|request-timeout|offline)$/.test(message)
          ? message
          : "offline";
        if (message === "rate-limited") this.offerRetryAt = Date.now() + 60_000;
      }
      signal.throwIfAborted();
      // 领取过程中开始的旧读取不能重新启用已经消费的邀请入口。
      if (offerVersion === this.offerVersion) this.offer = offer;
      this.snapshot = { accountId, records, canResume: !!this.offer, resumeError };
      this.offerCheckedAt = Date.now();
      return this.snapshot;
    })();
    this.pending = job;
    try {
      return await job;
    } finally {
      if (this.pending === job) this.pending = null;
    }
  }

  /** 只有用户点击才领取服务端会话；歌曲按 Windows 端行为从头播放。 */
  async resume(): Promise<CrossDevicePlayback> {
    const signal = this.context();
    if (!this.options.playbackAllowed()) throw new Error("already-in-room");
    const offer = this.offer;
    if (!offer) throw new Error("no-resume");
    this.offerVersion++;
    this.offer = null;
    this.snapshot = { ...this.snapshot, canResume: false };
    const raw = await this.options.transport.call(
      "relayPull",
      { ...offer, targetDeviceId: offer.deviceId },
      signal,
    );
    const data = z
      .object({
        data: z.object({
          relayMode: z.enum(["source", "snapshot"]),
          sourceId: z.union([z.string(), z.number()]).optional(),
          sourceType: z.string().optional(),
          resources: z
            .array(
              z.object({
                id: z.union([z.string(), z.number()]).transform(String),
                type: z.string(),
              }),
            )
            .max(1000)
            .optional(),
          currentPlayState: z.object({
            resourceId: z.union([z.string(), z.number()]).transform(String),
            resourceType: z.string(),
          }),
          playMode: relayMode,
        }),
      })
      .parse(raw).data;
    if (data.currentPlayState.resourceType !== "song") throw new Error("unsupported-resume");
    let ids: string[];
    if (data.relayMode === "source") {
      if (data.sourceType !== "playlist" || !songId.safeParse(String(data.sourceId)).success)
        throw new Error("unsupported-resume");
      const playlist = await this.options.transport.call(
        "relayPlaylist",
        { id: data.sourceId, n: 1000, s: 0 },
        signal,
      );
      ids = z
        .object({
          playlist: z.object({
            trackIds: z
              .array(z.object({ id: z.union([z.string(), z.number()]).transform(String) }))
              .max(100_000),
          }),
        })
        .parse(playlist)
        .playlist.trackIds.slice(0, 1000)
        .map((track) => track.id);
    } else
      ids = (data.resources ?? []).filter((item) => item.type === "song").map((item) => item.id);
    ids = [...new Set(ids)].filter((id) => songId.safeParse(id).success).slice(0, 1000);
    if (!ids.includes(data.currentPlayState.resourceId))
      ids = [data.currentPlayState.resourceId, ...ids].slice(0, 1000);
    const tracks = [] as CrossDevicePlayback["tracks"];
    for (let offset = 0; offset < ids.length; offset += 300) {
      const batch = ids.slice(offset, offset + 300);
      const songs = await this.options.transport.call(
        "roomSongs",
        { c: JSON.stringify(batch.map((id) => ({ id }))) },
        signal,
      );
      tracks.push(...decodeRelaySongs(songs));
    }
    const byId = new Map(tracks.map((track) => [track.id, track]));
    const ordered = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const index = ordered.findIndex((track) => track.id === data.currentPlayState.resourceId);
    if (index < 0) throw new Error("unsupported-resume");
    signal.throwIfAborted();
    if (!this.options.playbackAllowed()) throw new Error("already-in-room");
    return { tracks: ordered, index, playMode: data.playMode };
  }

  /** 只提交曲目、队列与模式变化，歌曲不建立周期进度上报计时器。 */
  async publish(input: CrossDeviceSource): Promise<void> {
    const signal = this.context();
    if (!this.options.playbackAllowed()) return;
    this.latestSource = input;
    if (this.publishJob) return this.publishJob;
    const job = (async () => {
      if (this.serverEnabled === null) {
        const config = await this.options.transport.call("relayConfig", {}, signal);
        signal.throwIfAborted();
        this.serverEnabled = (config.data as { enable?: boolean } | undefined)?.enable === true;
        this.configCheckedAt = Date.now();
        const size = (config.data as { snapshotSize?: unknown } | undefined)?.snapshotSize;
        if (typeof size === "number" && Number.isInteger(size) && size > 0)
          this.snapshotSize = Math.min(size, 1000);
      }
      if (!this.serverEnabled) {
        this.latestSource = null;
        return;
      }
      while (this.latestSource && !signal.aborted) {
        const source = this.latestSource;
        this.latestSource = null;
        if (!this.options.playbackAllowed()) break;
        const sourceKey = JSON.stringify(source.songIds);
        const stateKey = `${source.currentId}:${source.playMode}`;
        const newSource = sourceKey !== this.sourceKey;
        let sessionId = newSource ? randomBytes(9).toString("base64url") : this.sessionId;
        const uploadSource = async (retransmit: boolean): Promise<void> => {
          const current = source.songIds.indexOf(source.currentId);
          const ids = retransmit
            ? source.songIds.slice(
                Math.max(0, current - Math.floor(this.snapshotSize / 2)),
                Math.min(source.songIds.length, current + Math.ceil(this.snapshotSize / 2)),
              )
            : source.songIds;
          await this.options.transport.call(
            "relaySubmitSource",
            {
              songListSubmitReq: JSON.stringify({
                retransmit,
                sessionId,
                initResId: source.currentId,
                playMode: source.playMode,
                resources: ids.map((id) => ({ id, type: "song" })),
              }),
            },
            signal,
          );
          signal.throwIfAborted();
          this.sessionId = sessionId;
          this.sourceKey = sourceKey;
          this.stateKey = "";
        };
        try {
          if (newSource) await uploadSource(false);
          if (newSource || stateKey !== this.stateKey) {
            await this.options.transport.call(
              "relaySubmitState",
              {
                playStateSubmitReq: JSON.stringify({
                  resource: { id: source.currentId, type: "song" },
                  progress: 0,
                  sessionId,
                  playMode: source.playMode,
                }),
              },
              signal,
            );
            signal.throwIfAborted();
            this.stateKey = stateKey;
          }
        } catch (error) {
          // Windows 端收到明确的 10001 才以新会话补传快照；超时和未知结果不能重放。
          if (!(error instanceof Error) || error.message !== "api-10001") throw error;
          signal.throwIfAborted();
          if (!this.options.playbackAllowed()) break;
          sessionId = randomBytes(9).toString("base64url");
          await uploadSource(true);
          this.stateKey = stateKey;
        }
      }
    })();
    this.publishJob = job;
    try {
      await job;
    } finally {
      if (this.publishJob === job) this.publishJob = null;
    }
  }
}
