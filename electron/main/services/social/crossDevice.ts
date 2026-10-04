import { getNeteaseCookies, mergeNeteaseCookies } from "@main/apis/netease";
import { store } from "@main/store";
import { fetchWithProxy } from "@main/utils/proxy";
import { createNativeTransport } from "./netease-native/transport";
import { hasTogetherPlaybackOwnership } from "./playbackOwnership";
import { CrossDeviceService } from "./crossDeviceService";

export const crossDeviceService = new CrossDeviceService({
  transport: createNativeTransport({
    cookies: getNeteaseCookies,
    mergeCookies: mergeNeteaseCookies,
    fetch: fetchWithProxy,
  }),
  token: () => getNeteaseCookies().MUSIC_U || "",
  enabled: () => store.get("player.crossDeviceResume") !== false,
  playbackAllowed: () => !hasTogetherPlaybackOwnership(),
});
