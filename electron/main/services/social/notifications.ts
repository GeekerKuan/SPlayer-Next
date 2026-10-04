import { Notification } from "electron";
import { randomUUID } from "node:crypto";
import { getMainWindow, focusMainWindow } from "@main/window";
import { store } from "@main/store";
import { getLocale } from "@main/utils/i18n";
import type { SocialConversation, SocialSnapshot } from "@shared/types/social";
import { SocialNotificationPolicy } from "./notificationPolicy";

const policy = new SocialNotificationPolicy();
const live = new Map<string, Notification>();
let acceptInvite: ((item: SocialConversation, accountId: string) => Promise<void>) | null = null;
const navigate = (peerId: string): void => {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  focusMainWindow();
  window.webContents.send("social:navigate", peerId);
};
export const initSocialNotifications = (
  accept: (item: SocialConversation, accountId: string) => Promise<void>,
): void => {
  acceptInvite = accept;
  if (process.platform === "win32") Notification.handleActivation(() => focusMainWindow());
};
export const clearSocialNotifications = (): void => {
  policy.reset();
  for (const notification of live.values()) {
    notification.removeAllListeners();
    notification.close();
  }
  live.clear();
};

/** 不读取聊天历史、不显示正文；过期交互只导航，由页面重新核验房间。 */
export const publishSocialNotifications = (snapshot: SocialSnapshot): void => {
  if (snapshot.status === "auth-required") {
    clearSocialNotifications();
    return;
  }
  const items = policy.consume(snapshot);
  if (!store.get("system.socialNotifications") || !Notification.isSupported()) return;
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.isFocused())
    return;
  const zh = getLocale() === "zh-CN";
  for (const item of items) {
    const id = randomUUID();
    const invitation = item.content?.kind === "invite" && !!item.content.invite;
    const notification = new Notification({
      id,
      groupId: "splayer-social",
      title: item.name || "SPlayer-Next",
      body: invitation
        ? zh
          ? "邀请你一起听歌"
          : "Invited you to listen together"
        : zh
          ? "收到一条新私信"
          : "New private message",
      actions:
        invitation && process.platform === "win32"
          ? [
              { type: "button", text: zh ? "接受" : "Accept" },
              { type: "button", text: zh ? "在本机忽略" : "Dismiss locally" },
            ]
          : [],
    });
    const release = (): void => {
      notification.removeAllListeners();
      live.delete(id);
    };
    let handled = false;
    notification.on("click", () => {
      if (!handled) {
        handled = true;
        navigate(item.peerId);
      }
    });
    notification.on("action", (details) => {
      if (handled) return;
      handled = true;
      if (details.actionIndex === 0) {
        navigate(item.peerId);
        if (Date.now() - item.updatedAt < 10 * 60 * 1000)
          void acceptInvite?.(item, snapshot.accountId).catch(() => navigate(item.peerId));
      }
      notification.close();
      release();
    });
    notification.once("close", release);
    notification.once("failed", release);
    live.set(id, notification);
    while (live.size > 20) {
      const [oldId, old] = live.entries().next().value!;
      old.removeAllListeners();
      old.close();
      live.delete(oldId);
    }
    notification.show();
  }
};
