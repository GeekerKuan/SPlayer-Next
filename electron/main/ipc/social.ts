import { ipcMain } from "electron";
import { z } from "zod";
import { getMainWindow } from "@main/window/main";
import { socialService } from "@main/services/social";
import {
  socialNoticeKind,
  socialOffset,
  socialPeer,
  socialSend,
  socialTime,
} from "@main/services/social/validation";
import type { SocialResult } from "@shared/types/social";

/** 账号操作仅允许主窗口顶层 frame，禁止歌词窗口和外部 frame 调用。 */
export const registerSocialIpc = (): void => {
  const pending = new Map<string, Promise<SocialResult<unknown>>>();
  const onWindowDestroyed = (): void => {
    pending.clear();
    socialService.stop();
  };
  const reads = new Set([
    "snapshot",
    "refresh",
    "open",
    "conversations",
    "history",
    "notifications",
    "localRead",
    "localReadNotices",
  ]);
  const handle = <T>(channel: string, operation: (args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(`social:${channel}`, async (event, ...args): Promise<SocialResult<T>> => {
      const window = getMainWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        return { ok: false, error: "forbidden" };
      // 同参数读取复用在途结果；发送限制仍由服务负责，读取繁忙不伪装成发送限流。
      let key = "";
      if (reads.has(channel)) {
        try {
          key = `${channel}:${JSON.stringify(args)}`;
        } catch {
          return { ok: false, error: "invalid-input" };
        }
        if (key.length > 4096) return { ok: false, error: "invalid-input" };
      }
      const active = key && pending.get(key);
      if (active) return active as Promise<SocialResult<T>>;
      if (key && pending.size >= 16) return { ok: false, error: "busy" };
      const job = (async (): Promise<SocialResult<T>> => {
        try {
          return { ok: true, data: await operation(args) };
        } catch (error) {
          return {
            ok: false,
            error:
              error instanceof z.ZodError
                ? "invalid-input"
                : error instanceof Error
                  ? error.message
                  : "offline",
          };
        }
      })();
      if (key) pending.set(key, job);
      try {
        return await job;
      } finally {
        if (key && pending.get(key) === job) pending.delete(key);
      }
    });
  };
  const noArgs = (args: unknown[]): void => {
    z.tuple([]).parse(args);
  };
  handle("start", async (args) => {
    noArgs(args);
    const window = getMainWindow()!;
    window.webContents.removeListener("destroyed", onWindowDestroyed);
    window.webContents.once("destroyed", onWindowDestroyed);
    return socialService.start();
  });
  handle("stop", async (args) => {
    noArgs(args);
    pending.clear();
    socialService.stop();
  });
  handle("snapshot", async (args) => {
    noArgs(args);
    return socialService.snapshot();
  });
  handle("refresh", async (args) => {
    noArgs(args);
    return socialService.refresh();
  });
  handle("open", async (args) => socialService.open(z.tuple([socialPeer]).parse(args)[0]));
  handle("conversations", async (args) =>
    socialService.conversations(z.tuple([socialOffset]).parse(args)[0]),
  );
  handle("history", async (args) =>
    socialService.history(...z.tuple([socialPeer, socialTime]).parse(args)),
  );
  handle("notifications", async (args) =>
    socialService.notifications(
      ...z
        .tuple([socialNoticeKind, z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)])
        .parse(args),
    ),
  );
  handle("send", async (args) => socialService.send(z.tuple([socialSend]).parse(args)[0]));
  handle("retry", async (args) =>
    socialService.retry(z.tuple([z.string().min(1).max(100)]).parse(args)[0]),
  );
  handle("localRead", async (args) =>
    socialService.localRead(...z.tuple([socialPeer, socialTime]).parse(args)),
  );
  handle("localReadNotices", async (args) =>
    socialService.localReadNotices(...z.tuple([socialNoticeKind, socialTime]).parse(args)),
  );
  handle("dismissInvite", async (args) =>
    socialService.dismissInvite(...z.tuple([socialPeer, z.string().max(100)]).parse(args)),
  );
};
