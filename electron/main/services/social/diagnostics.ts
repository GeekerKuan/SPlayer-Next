import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { TogetherSnapshot } from "@shared/types/together";

type DiagnosticEvent =
  "enabled" | "disabled" | "state" | "operation-start" | "operation-end" | "control" | "add";
interface DiagnosticFields {
  operation?: string;
  action?: string;
  mode?: string;
  status?: string;
  connected?: boolean;
  playbackOwned?: boolean;
  playing?: boolean;
  awaitingNext?: boolean;
  ok?: boolean;
  acknowledged?: boolean;
  confirmed?: boolean;
  confirmationAttempt?: number;
  error?: string;
  memberCount?: number;
  songCount?: number;
  progressMs?: number;
  positionMs?: number;
  localProgressMs?: number;
  commandSeq?: number;
  playbackRevision?: number;
  durationMs?: number;
}
const operations = new Set([
  "chooseClient",
  "connect",
  "stop",
  "create",
  "ended",
  "invite",
  "invitationLink",
  "replace",
  "takeOver",
  "closeExternal",
  "joinLink",
  "readClipboardInvite",
  "friends",
  "previewInvite",
  "cancelPreview",
  "openInviteLink",
  "accept",
  "leave",
  "control",
  "recommendations",
  "add",
  "addMany",
  "play",
  "editQueue",
  "historyCandidates",
]);
const errors = new Set([
  "auth-required",
  "account-changed",
  "account-mismatch",
  "offline",
  "rate-limited",
  "room-current-song",
  "busy",
  "operation-unknown",
  "send-unknown",
  "invalid-input",
  "invalid-response",
  "cancelled",
  "request-timeout",
  "room-add-unconfirmed",
  "room-operation-failed",
  "room-not-owned",
  "room-expired",
  "invalid-song",
  "invalid-room-response",
  "already-in-queue",
  "queue-full",
  "room-changed",
  "room-not-found",
  "mode-in-room",
  "native-mode-required",
  "windows-client-required",
]);

/**
 * 会话级诊断日志：默认关闭，固定字段脱敏，异步写入有上限的双文件。
 * 不接受日志正文或文件路径 IPC；关闭及退出时排空已有队列，不新增定时器。
 */
export class TogetherDiagnostics {
  private active = false;
  private failure = false;
  private disposed = false;
  private pending = 0;
  private size = 0;
  private queue: Promise<void> = Promise.resolve();
  private lastState = "";
  private readonly file: string;
  private readonly previous: string;
  constructor(readonly directory: string) {
    this.file = path.join(directory, "current.jsonl");
    this.previous = path.join(directory, "previous.jsonl");
  }
  get enabled(): boolean {
    return this.active;
  }
  status(): { enabled: boolean; error?: string } {
    return { enabled: this.active, ...(this.failure ? { error: "diagnostics-unavailable" } : {}) };
  }
  async setEnabled(value: boolean): Promise<ReturnType<TogetherDiagnostics["status"]>> {
    if (this.disposed) throw new Error("cancelled");
    if (value === this.active) return this.status();
    if (value) {
      await this.queue;
      try {
        await mkdir(this.directory, { recursive: true });
        this.size = await stat(this.file)
          .then((info) => info.size)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return 0;
            throw error;
          });
      } catch {
        this.failure = true;
        throw new Error("diagnostics-unavailable");
      }
      if (this.disposed) throw new Error("cancelled");
      this.failure = false;
      this.active = true;
      this.lastState = "";
      this.record("enabled");
    } else {
      this.record("disabled");
      this.active = false;
      await this.queue;
    }
    return this.status();
  }
  record(event: DiagnosticEvent, fields: DiagnosticFields = {}): void {
    if (!this.active || this.disposed || this.pending >= 64) return;
    const safe: Record<string, string | number | boolean> = {};
    // 即使未来调用方误传整个响应，白名单之外的正文、凭证、头像和房间标识也不会落盘。
    for (const key of [
      "connected",
      "playbackOwned",
      "playing",
      "awaitingNext",
      "ok",
      "acknowledged",
      "confirmed",
    ] as const)
      if (typeof fields[key] === "boolean") safe[key] = fields[key]!;
    for (const key of [
      "memberCount",
      "songCount",
      "progressMs",
      "positionMs",
      "localProgressMs",
      "commandSeq",
      "playbackRevision",
      "durationMs",
      "confirmationAttempt",
    ] as const) {
      const value = fields[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    }
    if (fields.operation && operations.has(fields.operation)) safe.operation = fields.operation;
    if (
      fields.action &&
      ["pause", "resume", "next", "previous", "seek", "goto"].includes(fields.action)
    )
      safe.action = fields.action;
    if (fields.mode && ["native", "desktop-cdp"].includes(fields.mode)) safe.mode = fields.mode;
    if (
      fields.status &&
      ["alone", "waiting", "togetherOwner", "together", "timeout"].includes(fields.status)
    )
      safe.status = fields.status;
    if (fields.error)
      safe.error =
        errors.has(fields.error) || /^(?:api|http)-\d{3,4}$/.test(fields.error)
          ? fields.error
          : "other";
    if (event === "state") {
      const key = JSON.stringify({
        ...safe,
        progressMs: Math.floor((fields.progressMs || 0) / 1000),
      });
      if (key === this.lastState) return;
      this.lastState = key;
    }
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        platform: process.platform,
        ...safe,
      }) + "\n";
    const bytes = Buffer.byteLength(line);
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        if (this.failure) return;
        if (this.size + bytes > 2 * 1024 * 1024) {
          await rm(this.previous, { force: true });
          if (this.size) await rename(this.file, this.previous);
          this.size = 0;
        }
        await appendFile(this.file, line, "utf8");
        this.size += bytes;
      })
      .catch(() => {
        this.failure = true;
        this.active = false;
      })
      .finally(() => {
        this.pending--;
      });
  }
  snapshot(value: TogetherSnapshot): void {
    if (!this.active) return;
    this.record("state", {
      mode: value.mode,
      status: value.status,
      connected: value.connected,
      playbackOwned: value.playbackOwned,
      playing: value.playing,
      awaitingNext: value.awaitingNext,
      memberCount: value.members.length,
      songCount: value.songs.length,
      progressMs: Math.max(0, Math.round(value.progressMs)),
      commandSeq: value.commandSeq,
      playbackRevision: value.playbackRevision,
      error: value.error,
    });
  }
  async dispose(): Promise<void> {
    if (this.disposed) return this.queue;
    this.record("disabled");
    this.active = false;
    this.disposed = true;
    await this.queue;
  }
}
