import { z } from "zod";
import type {
  NoticeKind,
  SocialConversation,
  SocialMessage,
  SocialPage,
  SocialSendInput,
  SocialSnapshot,
} from "@shared/types/social";
import type { NativeTransport } from "./netease-native/transport";
import { decodeConversations, decodeMessages, decodeNotices } from "./netease-native/codec";
import { socialPeer, socialSend, socialTime, socialOffset, socialNoticeKind } from "./validation";

export const emptySocialSnapshot = (): SocialSnapshot => ({
  accountId: "",
  conversations: [],
  messages: {},
  notices: [],
  readTimes: {},
  status: "auth-required",
  updatedAt: 0,
  capabilities: { nativeReadReceipt: false, together: false, transport: "eapi-poll" },
});

export interface SocialCache {
  load: (accountId: string) => Promise<SocialSnapshot | null>;
  save: (snapshot: SocialSnapshot) => Promise<void>;
  remove: (accountId: string) => Promise<void>;
}
interface ServiceOptions {
  transport: NativeTransport;
  token: () => string;
  cache: SocialCache;
  update: (snapshot: SocialSnapshot) => void;
  visible: () => boolean;
}

/** 按服务端 ID 去重；最新页保留近期消息，历史页保留翻页方向的数据。 */
export const mergeMessages = (
  old: SocialMessage[],
  page: SocialMessage[],
  older = false,
): SocialMessage[] => {
  const map = new Map(old.map((message) => [message.id, message]));
  for (const message of page) map.set(message.id, message);
  const items = [...map.values()].sort((a, b) => a.time - b.time);
  return older ? items.slice(0, 500) : items.slice(-500);
};

/** 单轮询器和 generation 防止退出、切换账号后的旧响应写回。 */
export class SocialService {
  private state = emptySocialSnapshot();
  private token = "";
  private controller = new AbortController();
  private generation = 0;
  private active = false;
  private background = false;
  private peerId = "";
  private noticeKind: NoticeKind | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshJob: Promise<SocialSnapshot> | null = null;
  private accountJob: Promise<void> | null = null;
  private failures = 0;
  private sendTimes: number[] = [];
  private sends = new Map<string, { input: string; job: Promise<SocialMessage> }>();
  private lastRefresh = 0;

  constructor(private options: ServiceOptions) {}

  private publish(forceUpdate = false): void {
    this.boundSnapshot();
    if (this.active || this.background || forceUpdate)
      this.options.update(structuredClone(this.state));
    if (this.state.accountId)
      void this.options.cache.save(structuredClone(this.state)).catch(() => {});
  }
  private resetRequests(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.refreshJob = null;
    this.accountJob = null;
  }
  private async ensureAccount(): Promise<void> {
    const token = this.options.token();
    if (this.token !== token) {
      const oldAccount = this.state.accountId;
      this.resetRequests();
      this.token = token;
      this.state = emptySocialSnapshot();
      this.peerId = "";
      this.sendTimes = [];
      this.sends.clear();
      this.lastRefresh = 0;
      this.publish();
      if (!token && oldAccount) void this.options.cache.remove(oldAccount).catch(() => {});
    }
    if (!token) throw new Error("auth-required");
    if (this.state.accountId) return;
    if (this.accountJob) return this.accountJob;
    const generation = this.generation;
    const job = (async () => {
      const body = await this.options.transport.call("account", {}, this.controller.signal);
      const account = z
        .object({ id: z.union([z.number().int().positive(), socialPeer]) })
        .parse(body.account);
      const accountId = String(account.id);
      const cached = await this.options.cache.load(accountId).catch(() => null);
      this.assertCurrent(generation);
      this.state = cached?.accountId === accountId ? cached : emptySocialSnapshot();
      this.state.accountId = accountId;
      this.state.status = "offline";
      this.publish();
    })();
    this.accountJob = job;
    try {
      await job;
    } finally {
      if (this.accountJob === job) this.accountJob = null;
    }
  }
  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.token !== this.options.token())
      throw new Error("account-changed");
    this.controller.signal.throwIfAborted();
  }
  async snapshot(): Promise<SocialSnapshot> {
    try {
      await this.ensureAccount();
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : "offline";
      this.state.status = this.state.error === "auth-required" ? "auth-required" : "offline";
    }
    return structuredClone(this.state);
  }
  async start(): Promise<SocialSnapshot> {
    if (this.active) return this.snapshot();
    this.active = true;
    const snapshot = await this.snapshot();
    if (snapshot.status !== "auth-required") this.schedule(0);
    return snapshot;
  }
  stop(): void {
    this.active = false;
    this.peerId = "";
    this.noticeKind = null;
    if (this.background) {
      this.schedule(10000);
      return;
    }
    for (const messages of Object.values(this.state.messages))
      for (const message of messages)
        if (message.delivery === "sending") message.delivery = "unknown";
    if (this.state.accountId)
      void this.options.cache.save(structuredClone(this.state)).catch(() => {});
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.peerId = "";
    this.noticeKind = null;
    this.resetRequests();
  }
  /** 后台通知是显式服务订阅，不依赖渲染页面挂载。 */
  setBackground(enabled: boolean): void {
    this.background = enabled;
    if (enabled) this.schedule(0);
    else if (!this.active) this.stop();
  }
  stopAll(): void {
    this.background = false;
    this.stop();
  }
  /** 显式退出账号时立即清理缓存，不能等待下一次页面打开。 */
  logout(): void {
    const accountId = this.state.accountId;
    this.stop();
    this.resetRequests();
    this.token = "";
    this.state = emptySocialSnapshot();
    this.sends.clear();
    this.sendTimes = [];
    this.publish(true);
    if (accountId) void this.options.cache.remove(accountId).catch(() => {});
  }
  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.active && !this.background) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.active && !this.background) return;
      if (this.background || this.options.visible()) {
        try {
          await this.refresh();
        } catch {
          /* 下轮退避恢复。 */
        }
      }
      this.schedule(
        Math.min(
          60000,
          (this.active && this.options.visible() ? 5000 : 10000) * 2 ** this.failures,
        ),
      );
    }, ms);
    this.timer.unref?.();
  }
  async refresh(): Promise<SocialSnapshot> {
    await this.ensureAccount();
    if (this.refreshJob) return this.refreshJob;
    if (Date.now() - this.lastRefresh < 1000) return structuredClone(this.state);
    this.lastRefresh = Date.now();
    const generation = this.generation;
    const job = (async () => {
      try {
        const body = await this.options.transport.call(
          "conversations",
          { offset: 0, limit: 30, total: "true" },
          this.controller.signal,
        );
        this.assertCurrent(generation);
        this.mergeConversations(decodeConversations(body, this.state.accountId, 0).items);
        if (this.noticeKind) await this.notifications(this.noticeKind, -1);
        else if (this.peerId) await this.history(this.peerId, 0);
        this.assertCurrent(generation);
        this.state.status = "online";
        this.state.error = undefined;
        this.state.updatedAt = Date.now();
        this.failures = 0;
      } catch (error) {
        if (generation !== this.generation) throw error;
        this.failures = Math.min(4, this.failures + 1);
        this.state.error = error instanceof Error ? error.message : "offline";
        this.state.status = this.state.error === "auth-required" ? "auth-required" : "offline";
        if (this.state.status === "auth-required") this.logout();
      }
      this.publish();
      return structuredClone(this.state);
    })();
    this.refreshJob = job;
    try {
      return await job;
    } finally {
      if (this.refreshJob === job) this.refreshJob = null;
    }
  }
  private mergeConversations(items: SocialConversation[]): void {
    const map = new Map(this.state.conversations.map((item) => [item.peerId, item]));
    for (const item of items) {
      if ((this.state.readTimes[item.peerId] ?? 0) >= item.updatedAt) item.unread = 0;
      map.set(item.peerId, item);
    }
    this.state.conversations = [...map.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500);
  }
  async conversations(offset: number): Promise<SocialPage<SocialConversation>> {
    socialOffset.parse(offset);
    await this.ensureAccount();
    const generation = this.generation;
    const body = await this.options.transport.call(
      "conversations",
      { offset, limit: 30, total: "true" },
      this.controller.signal,
    );
    this.assertCurrent(generation);
    const page = decodeConversations(body, this.state.accountId, offset);
    this.mergeConversations(page.items);
    this.publish();
    return page;
  }
  async open(peerId: string): Promise<SocialPage<SocialMessage>> {
    socialPeer.parse(peerId);
    await this.ensureAccount();
    this.peerId = peerId;
    this.noticeKind = null;
    return this.history(peerId, 0);
  }
  async history(peerId: string, before: number): Promise<SocialPage<SocialMessage>> {
    socialPeer.parse(peerId);
    socialTime.parse(before);
    await this.ensureAccount();
    const generation = this.generation;
    const body = await this.options.transport.call(
      "history",
      { userId: peerId, time: before || -1, limit: 30, total: "true" },
      this.controller.signal,
    );
    this.assertCurrent(generation);
    const page = decodeMessages(body, peerId);
    for (const message of page.items) {
      if (message.kind === "invite" && this.state.readTimes[`invite:${message.id}`]) {
        message.kind = "unsupported";
        message.text = "invitation-dismissed";
        message.invite = undefined;
      }
    }
    const messages = this.state.messages;
    const previous = messages[peerId] ?? [];
    // 后续刷新移除已被服务端历史确认的本地占位，未知结果仍由用户核对。
    const confirmed = new Set<string>();
    for (const server of page.items) {
      const local = previous.find(
        (item) =>
          item.clientId &&
          item.delivery === "sent" &&
          !confirmed.has(item.id) &&
          item.senderId === server.senderId &&
          item.text === server.text &&
          Math.abs(item.time - server.time) < 10000,
      );
      if (local) confirmed.add(local.id);
    }
    delete messages[peerId];
    messages[peerId] = mergeMessages(
      previous.filter((item) => !confirmed.has(item.id)),
      page.items,
      before > 0,
    );
    while (Object.keys(messages).length > 20) delete messages[Object.keys(messages)[0]];
    if (!this.refreshJob) this.publish();
    return page;
  }
  async notifications(kind: NoticeKind, cursor: number) {
    socialNoticeKind.parse(kind);
    z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).parse(cursor);
    await this.ensureAccount();
    this.noticeKind = kind;
    this.peerId = "";
    const generation = this.generation;
    const args =
      kind === "notice"
        ? { limit: 30, time: cursor }
        : kind === "mention"
          ? { limit: 30, offset: 0, time: cursor, total: "true" }
          : { limit: 30, beforeTime: cursor, uid: this.state.accountId, total: "true" };
    const body = await this.options.transport.call(kind, args, this.controller.signal);
    this.assertCurrent(generation);
    const page = decodeNotices(body, kind, cursor);
    const map = new Map(this.state.notices.map((item) => [item.id, item]));
    for (const item of page.items) {
      item.locallyRead = (this.state.readTimes[`notice:${kind}`] ?? 0) >= item.time;
      map.set(item.id, item);
    }
    this.state.notices = [...map.values()].sort((a, b) => b.time - a.time).slice(0, 200);
    this.publish();
    return page;
  }
  async localRead(peerId: string, time: number): Promise<SocialSnapshot> {
    socialPeer.parse(peerId);
    socialTime.parse(time);
    await this.ensureAccount();
    const visibleTime = Math.max(
      ...(this.state.messages[peerId] ?? []).map((item) => item.time),
      0,
    );
    if (time > visibleTime) throw new Error("invalid-read-time");
    this.state.readTimes[peerId] = Math.max(this.state.readTimes[peerId] ?? 0, time);
    const conversation = this.state.conversations.find((item) => item.peerId === peerId);
    if (conversation && conversation.updatedAt <= time) conversation.unread = 0;
    this.boundReadTimes();
    this.publish();
    return structuredClone(this.state);
  }
  async localReadNotices(kind: NoticeKind, time: number): Promise<SocialSnapshot> {
    socialNoticeKind.parse(kind);
    socialTime.parse(time);
    await this.ensureAccount();
    const items = this.state.notices.filter((item) => item.kind === kind);
    if (time > Math.max(...items.map((item) => item.time), 0)) throw new Error("invalid-read-time");
    this.state.readTimes[`notice:${kind}`] = Math.max(
      this.state.readTimes[`notice:${kind}`] ?? 0,
      time,
    );
    this.state.notices = this.state.notices.map((item) =>
      item.kind === kind && item.time <= time ? { ...item, locallyRead: true } : item,
    );
    this.boundReadTimes();
    this.publish();
    return structuredClone(this.state);
  }
  private boundReadTimes(): void {
    const keys = Object.keys(this.state.readTimes);
    for (const key of keys.slice(0, Math.max(0, keys.length - 503)))
      delete this.state.readTimes[key];
  }
  /** IPC 与磁盘共享同一体积上限，极长历史优先淘汰最近未访问的会话。 */
  private boundSnapshot(): void {
    while (Buffer.byteLength(JSON.stringify(this.state)) > 2 * 1024 * 1024) {
      const keys = Object.keys(this.state.messages);
      const victim = keys.find((key) => key !== this.peerId) ?? keys[0];
      if (victim) {
        if (keys.length > 1) delete this.state.messages[victim];
        else if (this.state.messages[victim].length > 1)
          this.state.messages[victim].splice(0, Math.ceil(this.state.messages[victim].length / 2));
        else delete this.state.messages[victim];
      } else if (this.state.notices.length) this.state.notices.pop();
      else if (this.state.conversations.length) this.state.conversations.pop();
      else break;
    }
    const keys = Object.keys(this.state.messages);
    for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete this.state.messages[key];
  }
  async dismissInvite(peerId: string, messageId: string): Promise<SocialSnapshot> {
    socialPeer.parse(peerId);
    await this.ensureAccount();
    const message = this.state.messages[peerId]?.find((item) => item.id === messageId);
    if (message?.kind !== "invite") throw new Error("unsupported-invitation");
    message.kind = "unsupported";
    message.text = "invitation-dismissed";
    message.invite = undefined;
    this.state.readTimes[`invite:${message.id}`] = message.time;
    this.boundReadTimes();
    this.publish();
    return structuredClone(this.state);
  }
  async send(raw: SocialSendInput): Promise<SocialMessage> {
    const input = socialSend.parse(raw);
    await this.ensureAccount();
    const signature = JSON.stringify([input.peerId, input.text]);
    const existing = this.sends.get(input.clientId);
    if (existing) {
      if (existing.input !== signature) throw new Error("duplicate-client-id");
      return existing.job;
    }
    const now = Date.now();
    this.sendTimes = this.sendTimes.filter((time) => now - time < 60000);
    if (this.sendTimes.length >= 20 || now - (this.sendTimes.at(-1) ?? 0) < 1000)
      throw new Error("rate-limited");
    this.sendTimes.push(now);
    const generation = this.generation;
    const job = (async (): Promise<SocialMessage> => {
      const optimistic: SocialMessage = {
        id: `local:${input.clientId}`,
        peerId: input.peerId,
        senderId: this.state.accountId,
        time: now,
        kind: "text",
        text: input.text,
        clientId: input.clientId,
        delivery: "sending",
      };
      this.state.messages[input.peerId] = mergeMessages(this.state.messages[input.peerId] ?? [], [
        optimistic,
      ]);
      this.publish();
      try {
        await this.options.transport.call(
          "send",
          { type: "text", msg: input.text, userIds: JSON.stringify([input.peerId]) },
          this.controller.signal,
        );
        this.assertCurrent(generation);
        optimistic.delivery = "sent";
      } catch (error) {
        if (generation !== this.generation) throw new Error("send-unknown");
        optimistic.delivery =
          error instanceof Error && error.message === "send-unknown" ? "unknown" : "failed";
      }
      this.state.messages[input.peerId] = mergeMessages(this.state.messages[input.peerId] ?? [], [
        optimistic,
      ]);
      this.publish();
      return optimistic;
    })();
    this.sends.set(input.clientId, { input: signature, job });
    if (this.sends.size > 100) this.sends.delete(this.sends.keys().next().value!);
    return job;
  }
}
