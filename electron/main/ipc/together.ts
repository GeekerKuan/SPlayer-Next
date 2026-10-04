import { clipboard, dialog, ipcMain, shell } from "electron";
import { createHash } from "node:crypto";
import { fetchWithProxy } from "@main/utils/proxy";
import {
  extractTogetherShare,
  isTogetherShortLink,
  parseTogetherLink,
} from "@shared/utils/togetherLink";
import type { TogetherClipboardInvite } from "@shared/types/together";
import { z } from "zod";
import { store } from "@main/store";
import { getMainWindow } from "@main/window/main";
import { togetherService } from "@main/services/social/together";
import { socialPeer } from "@main/services/social/validation";
import { roomIdSchema } from "@main/services/social/netease-native/roomCodec";
import type { SocialResult } from "@shared/types/social";

/** 固定操作 IPC 禁止传入 CDP 方法、表达式、端口和网页 URL。 */
export const registerTogetherIpc = (): void => {
  const pending = new Set<string>();
  let clipboardDigest = "";
  const handle = <T>(channel: string, operation: (args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(`together:${channel}`, async (event, ...args): Promise<SocialResult<T>> => {
      const window = getMainWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        return { ok: false, error: "forbidden" };
      if (pending.has(channel)) return { ok: false, error: "rate-limited" };
      pending.add(channel);
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
      } finally {
        pending.delete(channel);
      }
    });
  };
  const chooseClient = async (): Promise<string> => {
    if (process.platform !== "win32") throw new Error("windows-client-required");
    const selection = await dialog.showOpenDialog(getMainWindow()!, {
      title: "选择网易云音乐 cloudmusic.exe",
      properties: ["openFile"],
      filters: [{ name: "Windows application", extensions: ["exe"] }],
    });
    if (selection.canceled || !selection.filePaths[0]) throw new Error("cancelled");
    if (!/[\\/]cloudmusic\.exe$/i.test(selection.filePaths[0]))
      throw new Error("windows-client-required");
    store.set("system.socialDesktopExecutable", selection.filePaths[0]);
    return selection.filePaths[0];
  };
  handle("chooseClient", (args) => {
    z.tuple([]).parse(args);
    return chooseClient();
  });
  handle("connect", async (args) => {
    const [choose] = z.tuple([z.boolean().optional()]).parse(args);
    const window = getMainWindow()!;
    if (
      process.platform === "win32" &&
      store.get("system.socialTogetherMode") === "desktop-cdp" &&
      (choose || !store.get("system.socialDesktopExecutable"))
    ) {
      await chooseClient();
    }
    window.webContents.removeListener("destroyed", onDestroyed);
    window.webContents.once("destroyed", onDestroyed);
    return togetherService.connect();
  });
  handle("stop", async (args) => {
    z.tuple([]).parse(args);
    togetherService.detach();
  });
  handle("create", (args) =>
    togetherService.create(z.tuple([socialPeer.optional()]).parse(args)[0]),
  );
  handle("invite", (args) => togetherService.invite(z.tuple([socialPeer]).parse(args)[0]));
  handle("invitationLink", (args) => {
    z.tuple([]).parse(args);
    return togetherService.invitationLink();
  });
  handle("replace", (args) => togetherService.replace(z.tuple([roomIdSchema]).parse(args)[0]));
  handle("takeOver", (args) => togetherService.takeOver(z.tuple([roomIdSchema]).parse(args)[0]));
  handle("closeExternal", (args) =>
    togetherService.closeExternal(z.tuple([roomIdSchema]).parse(args)[0]),
  );
  handle("joinLink", (args) =>
    togetherService.joinLink(
      z.tuple([z.object({ roomId: roomIdSchema, inviterId: socialPeer }).strict()]).parse(args)[0],
    ),
  );
  handle("readClipboardInvite", async (args): Promise<TogetherClipboardInvite | null> => {
    z.tuple([]).parse(args);
    if (!getMainWindow()?.isFocused()) return null;
    const text = clipboard.readText();
    const digest = createHash("sha256").update(text).digest("hex");
    if (digest === clipboardDigest) return null;
    const share = extractTogetherShare(text);
    if (!share) {
      clipboardDigest = digest;
      return null;
    }
    let invitation = parseTogetherLink(share.url);
    if (!invitation && isTogetherShortLink(share.url)) {
      // 仅跟随受限平台短链的重定向，不带登录 Cookie，也不下载跳转后的页面。
      let url = share.url;
      const window = getMainWindow()!;
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      const timeout = setTimeout(cancel, 8000);
      window.once("blur", cancel);
      window.webContents.once("destroyed", cancel);
      const signal = controller.signal;
      try {
        for (let hop = 0; hop < 3; hop++) {
          const response = await fetchWithProxy(url, { redirect: "manual", signal });
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
          url = new URL(location, url).href;
          invitation = parseTogetherLink(url);
          if (invitation || !isTogetherShortLink(url)) break;
        }
      } catch {
        /* 未解析到房间时提供用户主动打开浏览器的兜底。 */
      } finally {
        clearTimeout(timeout);
        window.removeListener("blur", cancel);
        window.webContents.removeListener("destroyed", cancel);
      }
    }
    if (!getMainWindow()?.isFocused()) return null;
    clipboardDigest = digest;
    return { ...share, invitation };
  });
  handle("openInviteLink", async (args) => {
    const [url] = z.tuple([z.string().max(4096)]).parse(args);
    if (!isTogetherShortLink(url) && !parseTogetherLink(url)) throw new Error("invalid-input");
    if (!url.startsWith("https://")) throw new Error("invalid-input");
    await shell.openExternal(url);
  });
  handle("accept", (args) =>
    togetherService.accept(...z.tuple([socialPeer, z.string().min(1).max(100)]).parse(args)),
  );
  handle("leave", (args) => {
    z.tuple([]).parse(args);
    return togetherService.leave();
  });
  handle("control", (args) =>
    togetherService.control(
      z
        .tuple([
          z.discriminatedUnion("action", [
            z.object({ action: z.enum(["pause", "resume", "next", "previous"]) }).strict(),
            z
              .object({
                action: z.literal("seek"),
                positionMs: z.number().finite().min(0).max(86400000),
              })
              .strict(),
            z.object({ action: z.literal("goto"), songId: socialPeer }).strict(),
          ]),
        ])
        .parse(args)[0],
    ),
  );
  handle("recommendations", (args) => {
    z.tuple([]).parse(args);
    return togetherService.recommendations();
  });
  handle("add", (args) => togetherService.add(z.tuple([socialPeer]).parse(args)[0]));
};
const onDestroyed = (): void => togetherService.stop();
