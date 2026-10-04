import type { TogetherControl, TogetherSnapshot } from "@shared/types/together";
import { toast } from "@/composables/useToast";
import i18n from "@/i18n";
import type { SocialResult } from "@shared/types/social";

let current: TogetherSnapshot | null = null;
let control: ((input: TogetherControl) => Promise<SocialResult<TogetherSnapshot>>) | null = null;
export const setTogetherControlHandler = (handler: typeof control): void => {
  control = handler;
};
export const clearTogetherSession = (): void => {
  current = null;
  control = null;
};
export const setTogetherSession = (snapshot: TogetherSnapshot): void => {
  current = snapshot;
};
export const ownsTogetherPlayback = (): boolean =>
  current?.mode === "native" && current.playbackOwned === true;
export const getTogetherSession = (): TogetherSnapshot | null => current;
/** 不通过用户控制队列；主进程在已有轮询中核对结束事件并处理房员接续。 */
export const notifyTogetherTrackEnded = async (): Promise<void> => {
  if (!ownsTogetherPlayback() || !current?.songId) return;
  await window.api.together.ended({
    roomId: current.roomId,
    songId: current.songId,
    commandSeq: current.commandSeq || 0,
  });
};
export const playTogetherTrack = async (
  track: import("@shared/types/player").Track,
): Promise<void> => {
  if (track.source !== "netease" || track.cloud || !current?.songs.some((s) => s.id === track.id)) {
    toast.error(i18n.global.t("social.errors.room-songs-only"));
    return;
  }
  await controlTogetherPlayback({ action: "goto", songId: track.id });
};

/** 用户播放操作走房间指令；远端应用直接使用原生 IPC，不经过此入口。 */
export const controlTogetherPlayback = async (input: TogetherControl): Promise<void> => {
  const result = await (control ? control(input) : window.api.together.control(input));
  if (!result.ok) toast.error(i18n.global.t(`social.errors.${result.error}`, result.error));
};
