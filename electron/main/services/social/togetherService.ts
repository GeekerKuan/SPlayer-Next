import type { TogetherControl, TogetherSnapshot, TogetherSong } from "@shared/types/together";
import type { SocialSnapshot } from "@shared/types/social";
import type { NativeTransport } from "./netease-native/transport";
import { connectDesktopCdp } from "./netease-native/desktopCdp";
import {
  desktopActionExpression,
  togetherSnapshotSchema,
  decodeRecommendations,
} from "./netease-native/desktopActions";

type Connection = Awaited<ReturnType<typeof connectDesktopCdp>>;
export const emptyTogetherSnapshot = (): TogetherSnapshot => ({
  connected: false,
  status: "alone",
  roomId: "",
  members: [],
  songs: [],
  songId: "",
  playing: false,
  progressMs: 0,
  updatedAt: 0,
});

/** 页面只持有连接，官方客户端独立维持 IM、RTC 和心跳；不重放结果不明的写操作。 */
export class TogetherService {
  private connection: Connection | null = null;
  private state = emptyTogetherSnapshot();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private accountId = "";
  private active = false;
  private busy = false;
  private failures = 0;
  private recommended = new Set<string>();
  private controller = new AbortController();
  private lastMutation = 0;
  private sequence = 0;
  private applied = 0;

  constructor(
    private options: {
      account: () => Promise<SocialSnapshot>;
      executable: () => string;
      visible: () => boolean;
      update: (snapshot: TogetherSnapshot) => void;
      pauseLocal: () => void;
      releaseLocal?: () => void;
      observe?: (snapshot: TogetherSnapshot) => void;
      stopObserving?: () => void;
      transport: NativeTransport;
      connect?: typeof connectDesktopCdp;
    },
  ) {}

  private publish(): TogetherSnapshot {
    const result = structuredClone(this.state);
    if (this.active && this.options.visible()) this.options.update(result);
    return result;
  }
  private async account(): Promise<string> {
    const snapshot = await this.options.account();
    if (!snapshot.accountId || snapshot.status === "auth-required")
      throw new Error("auth-required");
    if (this.accountId && snapshot.accountId !== this.accountId) {
      this.stop();
      throw new Error("account-changed");
    }
    return snapshot.accountId;
  }
  async connect(): Promise<TogetherSnapshot> {
    if (this.busy) throw new Error("rate-limited");
    this.stop();
    this.active = true;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const accountId = await this.account();
      if (epoch !== this.epoch) throw new Error("cancelled");
      this.accountId = accountId;
      const connection = await (this.options.connect || connectDesktopCdp)(
        9229,
        this.options.executable(),
      );
      if (epoch !== this.epoch) {
        connection.cdp.close();
        throw new Error("cancelled");
      }
      this.connection = connection;
      await this.execute("state");
      if (this.state.roomId) this.options.pauseLocal();
      this.schedule();
      return this.publish();
    } catch (error) {
      if (epoch === this.epoch) this.stop();
      throw error;
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  stop(): void {
    this.options.stopObserving?.();
    this.epoch++;
    this.busy = false;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.connection?.cdp.close();
    this.connection = null;
    this.accountId = "";
    this.state = emptyTogetherSnapshot();
    this.recommended.clear();
    this.controller.abort();
    this.controller = new AbortController();
  }
  private async execute(action: string, fields: Record<string, unknown> = {}): Promise<void> {
    const epoch = this.epoch;
    const sequence = ++this.sequence;
    const accountId = await this.account();
    if (!this.connection || epoch !== this.epoch) throw new Error("cdp-unavailable");
    const response = await this.connection.cdp.request("Runtime.evaluate", {
      expression: desktopActionExpression({ action, accountId, ...fields }),
      returnByValue: true,
    });
    if (epoch !== this.epoch) throw new Error("cancelled");
    if (response.exceptionDetails) throw new Error("native-operation-failed");
    const value = (response.result as { value?: { error?: string } })?.value;
    if (value?.error) throw new Error(value.error);
    const next = togetherSnapshotSchema.parse(value);
    if (sequence < this.applied) return;
    this.applied = sequence;
    this.state = next;
    this.options.observe?.(this.state);
    if (this.state.roomId && ["waiting", "together", "togetherOwner"].includes(this.state.status))
      this.options.pauseLocal();
    else this.options.releaseLocal?.();
  }
  private schedule(): void {
    if (!this.active) return;
    this.timer = setTimeout(
      async () => {
        this.timer = null;
        const epoch = this.epoch;
        if (!this.busy && this.options.visible()) {
          try {
            if (!this.connection) {
              const connection = await (this.options.connect || connectDesktopCdp)(
                9229,
                this.options.executable(),
              );
              if (epoch !== this.epoch) {
                connection.cdp.close();
                return;
              }
              this.connection = connection;
            }
            await this.execute("state");
            this.failures = 0;
          } catch (error) {
            if (epoch !== this.epoch) return;
            this.connection?.cdp.close();
            this.connection = null;
            this.failures = Math.min(5, this.failures + 1);
            this.state = {
              ...this.state,
              connected: false,
              error: error instanceof Error ? error.message : "offline",
            };
            this.options.observe?.(this.state);
            if (
              [
                "account-mismatch",
                "account-changed",
                "auth-required",
                "unsupported-build",
              ].includes(this.state.error!)
            ) {
              this.publish();
              this.stop();
              return;
            }
          }
          this.publish();
        }
        if (!this.options.visible()) this.options.stopObserving?.();
        if (epoch === this.epoch) this.schedule();
      },
      Math.min(30000, 1000 * 2 ** this.failures),
    );
    this.timer.unref?.();
  }
  private async mutate(
    action: string,
    fields: Record<string, unknown> = {},
  ): Promise<TogetherSnapshot> {
    if (this.busy || Date.now() - this.lastMutation < 500) throw new Error("rate-limited");
    this.busy = true;
    this.lastMutation = Date.now();
    const epoch = this.epoch;
    try {
      if (["accept", "create"].includes(action)) this.options.pauseLocal();
      await this.execute(action, fields);
      if (["accept", "create"].includes(action)) this.options.pauseLocal();
      return this.publish();
    } catch (error) {
      if (
        error instanceof Error &&
        !["cdp-timeout", "cdp-closed", "cdp-operation-failed", "native-operation-failed"].includes(
          error.message,
        ) &&
        !this.state.roomId
      )
        this.options.releaseLocal?.();
      throw error;
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  create(peerId?: string): Promise<TogetherSnapshot> {
    return this.mutate("create", { peerId });
  }
  async accept(peerId: string, messageId: string): Promise<TogetherSnapshot> {
    const snapshot = await this.options.account();
    const message = snapshot.messages[peerId]?.find((m) => m.id === messageId);
    if (
      message?.kind !== "invite" ||
      !message.invite ||
      message.senderId !== peerId ||
      message.invite.inviterId !== peerId ||
      Date.now() - message.time > 10 * 60 * 1000
    )
      throw new Error("invitation-expired");
    return this.mutate("accept", message.invite);
  }
  leave(): Promise<TogetherSnapshot> {
    return this.mutate("leave", { expectedRoom: this.state.roomId });
  }
  control(input: TogetherControl): Promise<TogetherSnapshot> {
    const duration =
      this.state.songs.find((s) => s.id === this.state.songId)?.durationMs || 86400000;
    if (input.action === "seek" && input.positionMs > duration) throw new Error("invalid-position");
    return this.mutate(input.action, { ...input, expectedRoom: this.state.roomId });
  }
  async recommendations(): Promise<TogetherSong[]> {
    const epoch = this.epoch;
    await this.account();
    if (epoch !== this.epoch) throw new Error("cancelled");
    const result = decodeRecommendations(
      await this.options.transport.call("recommendations", {}, this.controller.signal),
    );
    if (epoch !== this.epoch) throw new Error("cancelled");
    this.recommended = new Set(result.map((s) => s.id));
    return result;
  }
  add(songId: string): Promise<TogetherSnapshot> {
    if (!this.recommended.has(songId)) throw new Error("invalid-song");
    return this.mutate("add", { songId, expectedRoom: this.state.roomId });
  }
}
