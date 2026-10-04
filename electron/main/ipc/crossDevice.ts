import { ipcMain } from "electron";
import { z } from "zod";
import { getMainWindow } from "@main/window/main";
import { lightSnapshot } from "@main/services/nowPlaying";
import { crossDeviceService } from "@main/services/social/crossDevice";
import { relaySource } from "@main/services/social/crossDeviceService";
import type { SocialResult } from "@shared/types/social";

export const registerCrossDeviceIpc = (): void => {
  const handle = <T>(channel: string, operation: (args: unknown[]) => Promise<T>) => {
    ipcMain.handle(`crossDevice:${channel}`, async (event, ...args): Promise<SocialResult<T>> => {
      const window = getMainWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        return { ok: false, error: "forbidden" };
      window.webContents.removeListener("destroyed", cancel);
      window.webContents.once("destroyed", cancel);
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
    });
  };
  handle("refresh", async (args) => {
    z.tuple([]).parse(args);
    return crossDeviceService.refresh();
  });
  handle("resume", async (args) => {
    z.tuple([]).parse(args);
    return crossDeviceService.resume();
  });
  handle("publish", async (args) => {
    const source = z.tuple([relaySource]).parse(args)[0];
    const current = lightSnapshot();
    if (
      current.track?.source !== "netease" ||
      current.track.id !== source.currentId ||
      current.state !== "playing"
    )
      return;
    await crossDeviceService.publish(source);
  });
  ipcMain.handle("crossDevice:cancel", (event) => {
    const window = getMainWindow();
    if (
      window &&
      event.sender === window.webContents &&
      event.senderFrame === event.sender.mainFrame
    )
      cancel();
  });
};
const cancel = (): void => crossDeviceService.cancel();
