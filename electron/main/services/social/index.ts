import { getNeteaseCookies, mergeNeteaseCookies } from "@main/apis/netease";
import { fetchWithProxy } from "@main/utils/proxy";
import { getMainWindow } from "@main/window/main";
import { socialCache } from "./cache";
import { SocialService } from "./service";
import { createNativeTransport } from "./netease-native/transport";
import { publishSocialNotifications } from "./notifications";

export const socialService = new SocialService({
  transport: createNativeTransport({
    cookies: getNeteaseCookies,
    mergeCookies: mergeNeteaseCookies,
    fetch: fetchWithProxy,
  }),
  token: () => getNeteaseCookies().MUSIC_U || "",
  cache: socialCache,
  visible: () => {
    const window = getMainWindow();
    return (
      !!window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized()
    );
  },
  update: (snapshot) => {
    const window = getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    publishSocialNotifications(snapshot);
    window.webContents.send("social:update", snapshot);
  },
});
