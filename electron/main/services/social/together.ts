import { getNeteaseCookies, mergeNeteaseCookies } from "@main/apis/netease";
import { store } from "@main/store";
import { fetchWithProxy } from "@main/utils/proxy";
import { getMainWindow } from "@main/window/main";
import { getPlayer } from "@main/services/engine";
import { toMs } from "@main/utils/time";
import { lightSnapshot } from "@main/services/nowPlaying";
import { socialService } from "./index";
import { TogetherService } from "./togetherService";
import { NativeTogetherService } from "./nativeTogetherService";
import { createNativeTransport } from "./netease-native/transport";
import {
  isTogetherPlaybackLocked,
  setTogetherPlaybackLocked,
  setNativeTogetherOwnership,
  setTogetherControlHandler,
} from "./playbackOwnership";
import { createTogetherStats } from "./togetherStats";
import { insertPlayEvent } from "@main/database/playStats";
import type {
  TogetherControl,
  TogetherPlaybackEnd,
  TogetherSnapshot,
} from "@shared/types/together";
import { loadRoomResume, saveRoomResume } from "./roomSession";
import { coreLog } from "@main/utils/logger";
const stats = createTogetherStats(insertPlayEvent);
const transport = createNativeTransport({
  cookies: getNeteaseCookies,
  mergeCookies: mergeNeteaseCookies,
  fetch: fetchWithProxy,
});
let lastNativeKey = "";
const update = (snapshot: TogetherSnapshot): void => {
  const window = getMainWindow();
  // WebContents 的 destroyed 回调早于 BrowserWindow 销毁，停机快照不能再发送。
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  if (snapshot.mode === "native") {
    const key = JSON.stringify([
      snapshot.roomId,
      snapshot.status,
      snapshot.playbackOwned,
      snapshot.connected,
      snapshot.commandSeq,
      snapshot.playbackRevision,
      snapshot.awaitingNext,
      snapshot.error,
      snapshot.recommendationMode,
      snapshot.members,
      snapshot.songs.map((s) => s.id),
    ]);
    const same = key === lastNativeKey;
    lastNativeKey = key;
    if (same && (!window.isVisible() || window.isMinimized())) return;
  }
  window.webContents.send("together:update", snapshot);
};
const native = new NativeTogetherService({
  account: () => socialService.snapshot(),
  transport,
  update,
  loadResume: loadRoomResume,
  saveResume: (value) =>
    saveRoomResume(value).catch((error) => coreLog.warn("保存一起听恢复记录失败", error)),
  ownership: setNativeTogetherOwnership,
  autoRecommend: () => store.get("player.togetherAutoRecommend") !== false,
  halt: () => {
    const player = getPlayer();
    player.stop();
    player.setSpeed(1);
  },
  playback: () => {
    const current = lightSnapshot();
    const player = getPlayer();
    const status = player.getStatus();
    const state = status.state;
    return {
      songId: current.track?.source === "netease" && !current.track.cloud ? current.track.id : "",
      playing: !status.isFinished && state === "playing",
      progressMs: toMs(player.getPosition()),
      // stop/loading 时旧歌曲标签仍可能存在，不能把残留的零进度当作房间播放状态。
      ready: !status.isFinished && (state === "playing" || state === "paused"),
      finished: status.isFinished,
    };
  },
});
const desktop = new TogetherService({
  account: () => socialService.snapshot(),
  executable: () => store.get("system.socialDesktopExecutable"),
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
  update: (snapshot) => update({ ...snapshot, mode: "desktop-cdp", playbackOwned: false }),
  pauseLocal: () => {
    if (isTogetherPlaybackLocked()) return;
    setTogetherPlaybackLocked(true);
    getPlayer().stop();
  },
  releaseLocal: () => setTogetherPlaybackLocked(false),
  observe: (snapshot) => stats.observe(snapshot),
  stopObserving: () => stats.stop(),
  transport,
});
let mode: "native" | "desktop-cdp" = "native";
let latest: TogetherSnapshot | null = null;
const selected = (): NativeTogetherService | TogetherService =>
  mode === "native" ? native : desktop;
const remember = async (operation: Promise<TogetherSnapshot>): Promise<TogetherSnapshot> => {
  latest = await operation;
  return { ...latest, mode };
};
/** 模式只在显式连接时改变，不以 CDP 自动补救独立模式的协议失败。 */
export const togetherService = {
  connect: async (): Promise<TogetherSnapshot> => {
    const next =
      process.platform === "win32" ? store.get("system.socialTogetherMode") || "native" : "native";
    if (next !== mode) {
      if (native.snapshot().playbackOwned || (mode === "desktop-cdp" && latest?.roomId))
        throw new Error("mode-in-room");
      selected().stop();
      mode = next;
      latest = null;
    }
    return remember(selected().connect());
  },
  detach: (): void => {
    if (mode === "native") native.detach();
    else desktop.stop();
  },
  stop: (): void => {
    native.stop();
    desktop.stop();
    latest = null;
    setTogetherPlaybackLocked(false);
  },
  logout: (): void => {
    native.stop(true);
    desktop.stop();
    latest = null;
    setTogetherPlaybackLocked(false);
  },
  create: (peerId?: string) => remember(selected().create(peerId)),
  invite: (peerId: string) =>
    remember(mode === "native" ? native.invite(peerId) : desktop.create(peerId)),
  invitationLink: async (): Promise<string> => {
    if (mode === "native") return native.invitationLink();
    const state = await remember(desktop.connect());
    const account = await socialService.snapshot();
    if (!state.roomId || !["waiting", "togetherOwner"].includes(state.status))
      throw new Error("room-invite-owner-only");
    if (!account.accountId || !state.members.some((member) => member.id === account.accountId))
      throw new Error("account-mismatch");
    return `orpheus://nm/play/listenTogether?${new URLSearchParams({ roomId: state.roomId, inviterId: account.accountId })}`;
  },
  replace: (expectedRoomId: string) => {
    if (mode !== "native") throw new Error("native-mode-required");
    return remember(native.replace(expectedRoomId));
  },
  accept: (peerId: string, messageId: string) => remember(selected().accept(peerId, messageId)),
  takeOver: (expectedRoomId: string) => {
    if (mode !== "native") throw new Error("native-mode-required");
    return remember(native.takeOver(expectedRoomId));
  },
  closeExternal: (expectedRoomId: string) => {
    if (mode !== "native") throw new Error("native-mode-required");
    return remember(native.closeExternal(expectedRoomId));
  },
  joinLink: (invite: { roomId: string; inviterId: string }) => {
    if (mode !== "native") throw new Error("native-mode-required");
    return remember(native.joinLink(invite));
  },
  leave: () => remember(selected().leave()),
  control: (input: TogetherControl) => remember(selected().control(input)),
  ended: async (input: TogetherPlaybackEnd): Promise<void> => {
    if (mode === "native") native.notifyEnded(input);
  },
  recommendations: () => selected().recommendations(),
  add: (songId: string) => remember(selected().add(songId)),
};
setTogetherControlHandler((input) => togetherService.control(input));
