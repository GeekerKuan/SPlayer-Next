import type { TogetherControl, TogetherSnapshot } from "@shared/types/together";
import type { SocialResult } from "@shared/types/social";

interface Options {
  publish: (snapshot: TogetherSnapshot, localSeek?: boolean, seekEcho?: boolean) => void;
  send: (input: TogetherControl) => Promise<SocialResult<TogetherSnapshot>>;
  refresh: () => Promise<SocialResult<TogetherSnapshot>>;
}
interface SeekIntent {
  id: number;
  roomId: string;
  songId: string;
  positionMs: number;
  playing: boolean;
  startedAt: number;
  serverSeq: number;
}

/** 前端只保护本机拖动和过滤旧回声，协议、命令序列与切歌顺序仍由主进程维护。 */
export class TogetherControls {
  private server: TogetherSnapshot | null = null;
  private seek: SeekIntent | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private disposed = false;
  private job: {
    id: number;
    roomId: string;
    timer: ReturnType<typeof setTimeout>;
    seek?: SeekIntent;
    resolve: (result: SocialResult<TogetherSnapshot>) => void;
  } | null = null;

  constructor(private options: Options) {}

  private clearSeek(): void {
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.seek = null;
  }
  private project(snapshot: TogetherSnapshot): TogetherSnapshot {
    const intent = this.seek;
    if (!intent) return snapshot;
    const duration = snapshot.songs.find((s) => s.id === intent.songId)?.durationMs || 86400000;
    return {
      ...snapshot,
      progressMs: Math.min(
        duration,
        intent.positionMs + (intent.playing ? Date.now() - intent.startedAt : 0),
      ),
      playing: intent.playing,
    };
  }

  /** 新的远端切歌、播放态变化或不匹配的新序列优先，不能被本机拖动保护吞掉。 */
  ingest(snapshot: TogetherSnapshot, acknowledgedSeek?: SeekIntent): void {
    if (this.disposed) return;
    if (
      this.server?.roomId === snapshot.roomId &&
      this.server.mode === snapshot.mode &&
      (snapshot.commandSeq || 0) < (this.server.commandSeq || 0)
    )
      return;
    const intent = this.seek;
    const owned = snapshot.mode === "native" && snapshot.playbackOwned && snapshot.connected;
    const echoIntent = intent || acknowledgedSeek;
    const elapsed = echoIntent?.playing ? Date.now() - echoIntent.startedAt : 0;
    const seekEcho = !!(
      owned &&
      echoIntent &&
      snapshot.roomId === echoIntent.roomId &&
      snapshot.songId === echoIntent.songId &&
      snapshot.playing === echoIntent.playing &&
      snapshot.progressMs >= echoIntent.positionMs - 1000 &&
      snapshot.progressMs <= echoIntent.positionMs + elapsed + 1000 &&
      (acknowledgedSeek ||
        (snapshot.commandSeq || 0) > echoIntent.serverSeq ||
        (snapshot.playbackRevision || 0) > (this.server?.playbackRevision || 0))
    );
    if (intent) {
      const elapsed = intent.playing ? Date.now() - intent.startedAt : 0;
      const echo =
        snapshot.progressMs >= intent.positionMs - 1000 &&
        snapshot.progressMs <= intent.positionMs + elapsed + 1000;
      if (
        !owned ||
        snapshot.roomId !== intent.roomId ||
        snapshot.songId !== intent.songId ||
        ((snapshot.commandSeq || 0) > intent.serverSeq &&
          (!echo || snapshot.playing !== intent.playing))
      )
        this.clearSeek();
    }
    if (this.job && snapshot.roomId !== this.job.roomId)
      this.finish(this.job.id, { ok: false, error: "cancelled" }, false);
    this.server = snapshot;
    this.options.publish(this.project(snapshot), false, seekEcho);
  }

  private async reconcile(id: number, roomId: string): Promise<void> {
    try {
      const result = await this.options.refresh();
      if (!this.disposed && this.serial === id && this.server?.roomId === roomId && result.ok)
        this.ingest(result.data);
    } catch {
      /* 读取失败不拿缓存强行回退，下一次真实状态更新继续校准。 */
    }
  }

  control(input: TogetherControl): Promise<SocialResult<TogetherSnapshot>> {
    if (this.disposed) return Promise.resolve({ ok: false, error: "cancelled" });
    if (this.job) return Promise.resolve({ ok: false, error: "rate-limited" });
    const snapshot = this.server;
    if (
      input.action === "seek" &&
      (!Number.isFinite(input.positionMs) ||
        input.positionMs < 0 ||
        input.positionMs >
          (snapshot?.songs.find((s) => s.id === snapshot.songId)?.durationMs || 86400000))
    ) {
      return Promise.resolve({ ok: false, error: "invalid-position" });
    }
    const id = ++this.serial;
    if (input.action === "seek") this.clearSeek();
    if (
      input.action === "seek" &&
      snapshot?.mode === "native" &&
      snapshot.playbackOwned &&
      snapshot.connected
    ) {
      this.seek = {
        id,
        roomId: snapshot.roomId,
        songId: snapshot.songId,
        positionMs: input.positionMs,
        playing: snapshot.playing,
        startedAt: Date.now(),
        serverSeq: snapshot.commandSeq || 0,
      };
      this.options.publish(this.project(snapshot), true);
      // 与观察到的官方客户端回声窗口一致；到期只读核验，不重发控制。
      this.seekTimer = setTimeout(() => {
        this.clearSeek();
        void this.reconcile(id, snapshot.roomId);
      }, 5000);
    }
    const promise = new Promise<SocialResult<TogetherSnapshot>>((resolve) => {
      this.job = {
        id,
        roomId: snapshot?.roomId || "",
        seek: this.seek?.id === id ? this.seek : undefined,
        resolve,
        timer: setTimeout(() => {
          this.finish(id, { ok: false, error: "operation-unknown" });
        }, 15000),
      };
    });
    void this.options.send(input).then(
      (result) => this.finish(id, result),
      () => this.finish(id, { ok: false, error: "operation-unknown" }),
    );
    return promise;
  }

  private finish(id: number, result: SocialResult<TogetherSnapshot>, refresh = true): void {
    const job = this.job;
    if (!job || job.id !== id) return;
    clearTimeout(job.timer);
    this.job = null;
    if (result.ok) this.ingest(result.data, job.seek);
    else {
      this.clearSeek();
      if (refresh && !this.disposed) void this.reconcile(id, job.roomId);
    }
    job.resolve(result);
  }

  /** 应用卸载或取消订阅时结清等待者，移除全部截止定时器，丢弃迟到响应。 */
  dispose(): void {
    this.disposed = true;
    this.serial++;
    this.clearSeek();
    if (this.job) this.finish(this.job.id, { ok: false, error: "cancelled" }, false);
    this.server = null;
  }
}
