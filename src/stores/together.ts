import type { TogetherControl, TogetherSnapshot, TogetherSong } from "@shared/types/together";
import type { SocialResult } from "@shared/types/social";
import {
  applyTogetherPlayback,
  disposeTogetherPlayback,
  prepareTogetherPlayback,
  discardPreparedTogetherPlayback,
} from "@/services/togetherPlayback";
import { TogetherControls } from "@/services/togetherControl";
import {
  clearTogetherSession,
  setTogetherControlHandler,
  setTogetherAddHandler,
} from "@/services/togetherSession";
import { getCurrentTime } from "@/services/playback";
import { toast, type ToastInstance } from "@/composables/useToast";
import i18n from "@/i18n";

export const useTogetherStore = defineStore("together", () => {
  const snapshot = shallowRef<TogetherSnapshot>({
    connected: false,
    status: "alone",
    roomId: "",
    members: [],
    songs: [],
    songId: "",
    playing: false,
    progressMs: 0,
    updatedAt: 0,
  });
  const candidates = shallowRef<TogetherSong[]>([]);
  const invitedPeerId = ref("");
  const busy = ref(false);
  const recommendationsLoading = ref(false);
  const error = ref("");
  let unsubscribe: (() => void) | null = null;
  let epoch = 0;
  let additionToast: ToastInstance | null = null;
  const recommendations = computed(() =>
    (snapshot.value.recommendations?.length
      ? snapshot.value.recommendations
      : candidates.value
    ).filter((s) => !snapshot.value.songs.some((queued) => queued.id === s.id)),
  );
  const unwrap = <T>(result: SocialResult<T>): T => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const makeControls = (): TogetherControls =>
    new TogetherControls({
      publish: (next, localSeek, seekEcho) => {
        if (next.roomId !== snapshot.value.roomId) {
          invitedPeerId.value = "";
          candidates.value = [];
        }
        snapshot.value = next;
        applyTogetherPlayback(
          next,
          (message) => {
            error.value = message;
          },
          localSeek,
          seekEcho,
        );
      },
      send: (input) => window.api.together.control(input),
      refresh: () => window.api.together.connect(),
      position: getCurrentTime,
    });
  let controls = makeControls();
  function start(): void {
    if (unsubscribe) return;
    setTogetherControlHandler(controlRequest);
    setTogetherAddHandler(addPlaylist);
    unsubscribe =
      window.api.together?.onUpdate((next) => {
        error.value = next.error || "";
        controls.ingest(next);
      }) || null;
  }
  function stop(): void {
    if (snapshot.value.mode === "native" && snapshot.value.playbackOwned) return;
    epoch++;
    unsubscribe?.();
    unsubscribe = null;
    controls.dispose();
    additionToast?.close();
    additionToast = null;
    controls = makeControls();
    clearTogetherSession();
    disposeTogetherPlayback();
    candidates.value = [];
    invitedPeerId.value = "";
    busy.value = false;
    recommendationsLoading.value = false;
    snapshot.value = { ...snapshot.value, connected: false };
    void window.api.together?.stop();
  }
  async function run(
    operation: () => Promise<SocialResult<TogetherSnapshot>>,
    commit = true,
  ): Promise<boolean> {
    if (busy.value) return false;
    const current = epoch;
    prepareTogetherPlayback();
    busy.value = true;
    error.value = "";
    try {
      const next = unwrap(await operation());
      if (current !== epoch) return false;
      if (commit) controls.ingest(next);
      return true;
    } catch (reason) {
      if (current === epoch) error.value = reason instanceof Error ? reason.message : "offline";
      return false;
    } finally {
      if (current === epoch) {
        busy.value = false;
        if (!snapshot.value.playbackOwned) discardPreparedTogetherPlayback();
      }
    }
  }
  const connect = (chooseClient = false): Promise<boolean> =>
    run(() => window.api.together.connect(chooseClient));
  async function accept(peerId: string, messageId: string): Promise<boolean> {
    if (!snapshot.value.connected && !(await connect())) return false;
    return run(() => window.api.together.accept(peerId, messageId));
  }
  async function create(peerId?: string): Promise<boolean> {
    const success = await run(() => window.api.together.create(peerId));
    if (success && peerId) invitedPeerId.value = peerId;
    return success;
  }
  async function invite(peerId: string): Promise<boolean> {
    const success = await run(() => window.api.together.invite(peerId));
    if (success) invitedPeerId.value = peerId;
    return success;
  }
  const replace = (expectedRoomId: string): Promise<boolean> =>
    run(() => window.api.together.replace(expectedRoomId));
  const takeOver = (expectedRoomId: string): Promise<boolean> =>
    run(() => window.api.together.takeOver(expectedRoomId));
  const closeExternal = (expectedRoomId: string): Promise<boolean> =>
    run(() => window.api.together.closeExternal(expectedRoomId));
  const joinLink = (
    invite: import("@shared/types/together").TogetherInvitation,
  ): Promise<boolean> => run(() => window.api.together.joinLink(invite));
  async function invitationLink(): Promise<string | null> {
    if (busy.value) return null;
    const current = epoch;
    busy.value = true;
    error.value = "";
    try {
      const link = unwrap(await window.api.together.invitationLink());
      return current === epoch ? link : null;
    } catch (reason) {
      if (current === epoch) error.value = reason instanceof Error ? reason.message : "offline";
      return null;
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  const leave = (): Promise<boolean> => run(() => window.api.together.leave());
  async function controlRequest(input: TogetherControl): Promise<SocialResult<TogetherSnapshot>> {
    let result: SocialResult<TogetherSnapshot> = { ok: false, error: "rate-limited" };
    await run(async () => {
      result = await controls.control(input);
      return result;
    }, false);
    return result;
  }
  const control = async (input: TogetherControl): Promise<boolean> =>
    (await controlRequest(input)).ok;
  /** 加歌提示共用一次操作生命周期；迟到响应不能给新房间弹成功提示。 */
  const runAddition = async (
    operation: () => Promise<SocialResult<TogetherSnapshot>>,
  ): Promise<boolean> => {
    if (busy.value) return false;
    const current = epoch,
      roomId = snapshot.value.roomId;
    const notice = toast.loading(i18n.global.t("social.together.adding"), { duration: 0 });
    additionToast = notice;
    try {
      const success = await run(operation);
      if (current === epoch && roomId === snapshot.value.roomId) {
        if (success) toast.success(i18n.global.t("social.together.addedToRoom"));
        else if (error.value)
          toast.error(i18n.global.t(`social.errors.${error.value}`, error.value));
      }
      return success;
    } finally {
      notice.close();
      if (additionToast === notice) additionToast = null;
    }
  };
  const add = (songId: string): Promise<boolean> =>
    runAddition(() => window.api.together.add(songId));
  /** 复用已有歌单数据，一次 IPC / ADD；失败不自动逐曲补发。 */
  const addPlaylist = async (
    tracks: readonly import("@shared/types/player").Track[],
  ): Promise<boolean> => {
    if (busy.value || snapshot.value.mode !== "native" || !snapshot.value.playbackOwned)
      return false;
    const queued = new Set(snapshot.value.songs.map((song) => song.id));
    const ids = [
      ...new Set(
        tracks
          .filter((track) => track.source === "netease" && !track.cloud)
          .map((track) => track.id),
      ),
    ].filter((id) => !queued.has(id));
    if (!ids.length) {
      error.value = tracks.some((track) => track.source === "netease" && !track.cloud)
        ? "no-new-room-songs"
        : "room-songs-only";
      toast.info(i18n.global.t(`social.errors.${error.value}`));
      return false;
    }
    if (ids.length + queued.size > 500) {
      error.value = "queue-full";
      toast.warning(i18n.global.t("social.errors.queue-full"));
      return false;
    }
    return runAddition(() => window.api.together.addMany(ids));
  };
  async function loadRecommendations(): Promise<void> {
    if (busy.value || recommendationsLoading.value) return;
    const current = epoch;
    const roomId = snapshot.value.roomId;
    // 推荐读取不应阻止暂停、拖动或退出房间。
    recommendationsLoading.value = true;
    error.value = "";
    try {
      const songs = unwrap(await window.api.together.recommendations());
      if (current === epoch && roomId === snapshot.value.roomId) candidates.value = songs;
    } catch (reason) {
      if (current === epoch && roomId === snapshot.value.roomId)
        error.value = reason instanceof Error ? reason.message : "offline";
    } finally {
      if (current === epoch) recommendationsLoading.value = false;
    }
  }
  function dispose(): void {
    epoch++;
    unsubscribe?.();
    unsubscribe = null;
    controls.dispose();
    additionToast?.close();
    additionToast = null;
    clearTogetherSession();
    disposeTogetherPlayback();
    candidates.value = [];
    invitedPeerId.value = "";
    busy.value = false;
    recommendationsLoading.value = false;
  }
  return {
    snapshot,
    invitedPeerId,
    recommendations,
    recommendationsLoading,
    busy,
    error,
    start,
    stop,
    dispose,
    connect,
    accept,
    create,
    invite,
    invitationLink,
    replace,
    takeOver,
    closeExternal,
    joinLink,
    leave,
    control,
    add,
    addPlaylist,
    loadRecommendations,
  };
});
