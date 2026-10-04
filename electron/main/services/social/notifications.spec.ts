import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySocialSnapshot } from "./service";
import type { SocialSnapshot } from "@shared/types/social";
import type { EventEmitter } from "node:events";
const f = vi.hoisted(() => ({
  focused: true,
  enabled: true,
  notifications: [] as (EventEmitter & { options: { actions: unknown[] }; close: () => void })[],
  accept: vi.fn(async () => {}),
  send: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Notification extends EventEmitter {
    constructor(public options: { actions: unknown[] }) {
      super();
      f.notifications.push(this);
    }
    static isSupported(): boolean {
      return true;
    }
    static handleActivation(): void {
      // 测试替身：系统通知激活由 action 事件模拟。
    }
    show(): void {
      // 测试替身：通知构造时已记录显示参数。
    }
    close(): void {
      this.emit("close");
    }
  }
  return { Notification };
});
vi.mock("@main/window", () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    isFocused: () => f.focused,
    webContents: { isDestroyed: () => false, send: f.send },
  }),
  focusMainWindow: f.focus,
}));
vi.mock("@main/store", () => ({ store: { get: () => f.enabled } }));
vi.mock("@main/utils/i18n", () => ({ getLocale: () => "zh-CN" }));
import {
  clearSocialNotifications,
  initSocialNotifications,
  publishSocialNotifications,
} from "./notifications";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const snapshot = (time: number, invite = true, unread = 0): SocialSnapshot => ({
  ...emptySocialSnapshot(),
  accountId: "1",
  status: "online",
  updatedAt: time,
  conversations: [
    {
      peerId: "2",
      name: "friend",
      avatar: "",
      preview: "",
      updatedAt: time,
      unread,
      content: invite
        ? { kind: "invite", text: "", invite: { roomId: "room", inviterId: "2" } }
        : { kind: "text", text: "" },
    },
  ],
  messages: {},
});
describe("native invitation notification interaction", () => {
  beforeEach(() => {
    clearSocialNotifications();
    f.notifications = [];
    f.focused = true;
    f.enabled = true;
    initSocialNotifications(f.accept);
    publishSocialNotifications(snapshot(Date.now() - 1000));
  });
  afterEach(() => {
    clearSocialNotifications();
    Object.defineProperty(process, "platform", platform);
  });
  it.each(["win32", "darwin"])(
    "shows foreground invitations on %s and accepts only once",
    async (os) => {
      Object.defineProperty(process, "platform", { value: os, configurable: true });
      const next = snapshot(Date.now());
      publishSocialNotifications(next);
      publishSocialNotifications(next);
      expect(f.notifications).toHaveLength(1);
      const notification = f.notifications[0];
      expect(notification.options.actions).toHaveLength(2);
      notification.emit("action", { actionIndex: 0 });
      notification.emit("action", { actionIndex: 0 });
      await Promise.resolve();
      expect(f.accept).toHaveBeenCalledExactlyOnceWith(next.conversations[0], "1");
    },
  );
  it("keeps ordinary private-message notifications silent while focused", () => {
    publishSocialNotifications(snapshot(Date.now(), false, 1));
    expect(f.notifications).toHaveLength(0);
    f.focused = false;
    publishSocialNotifications(snapshot(Date.now() + 500, false, 1));
    expect(f.notifications).toHaveLength(1);
  });
  it("respects disabled notifications and ignores expired accept actions", async () => {
    f.enabled = false;
    publishSocialNotifications(snapshot(Date.now()));
    expect(f.notifications).toHaveLength(0);
    f.enabled = true;
    const now = Date.now();
    publishSocialNotifications(snapshot(now + 1000));
    vi.spyOn(Date, "now").mockReturnValue(now + 601001);
    f.notifications[0].emit("action", { actionIndex: 0 });
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith("social:navigate", "2");
  });
});
