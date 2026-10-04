import type { TogetherControl, TogetherSnapshot, TogetherSong } from "@shared/types/together";
import type { SocialResult } from "@shared/types/social";
import {
  applyTogetherPlayback,
  disposeTogetherPlayback,
  prepareTogetherPlayback,
  discardPreparedTogetherPlayback,
} from "@/services/togetherPlayback";
import { TogetherControls } from "@/services/togetherControl";
import { clearTogetherSession, setTogetherControlHandler } from "@/services/togetherSession";

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
    });
  let controls = makeControls();
  function start(): void {
    if (unsubscribe) return;
    setTogetherControlHandler(controlRequest);
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
  const add = (songId: string): Promise<boolean> => run(() => window.api.together.add(songId));
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
    loadRecommendations,
  };
});
