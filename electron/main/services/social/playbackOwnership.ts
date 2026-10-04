let locked = false;
let nativeRoom = "";
let nativeSong = "";
let control:
  ((input: import("@shared/types/together").TogetherControl) => Promise<unknown>) | null = null;

/** 官方客户端负责一起听音频时，所有本地引擎入口必须停止；页面卸载不代表退出房间。 */
export const isTogetherPlaybackLocked = (): boolean => locked;
/** 跨端续播不能接管正在一起听的播放器。 */
export const hasTogetherPlaybackOwnership = (): boolean => locked || !!nativeRoom;
export const setTogetherPlaybackLocked = (value: boolean): void => {
  locked = value;
};
/** 独立房间仅允许当前曲或本账号已校验的待播网易云曲目进入引擎。 */
export const setNativeTogetherOwnership = (roomId: string, songId: string): void => {
  nativeRoom = roomId;
  nativeSong = songId;
};
export const canLoadTogetherTrack = (
  track: import("@shared/types/player").Track | undefined,
  source: string,
): boolean => {
  if (locked) return false;
  if (!nativeRoom) return true;
  if (track?.source !== "netease" || track.id !== nativeSong) return false;
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".music.126.net") || url.hostname.endsWith(".music.163.com"))
    );
  } catch {
    return false;
  }
};
export const setTogetherControlHandler = (handler: typeof control): void => {
  control = handler;
};
export const canPlayTogetherTrack = (track: import("@shared/types/player").Track | null): boolean =>
  !locked && (!nativeRoom || (track?.source === "netease" && track.id === nativeSong));
export const routeTogetherControl = (
  input: import("@shared/types/together").TogetherControl,
): Promise<unknown> | null => (nativeRoom && control ? control(input) : null);
