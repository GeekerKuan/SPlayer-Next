import { useHistoryStore } from "./history";
import { useUserStore } from "./user";
import { useSettingsStore } from "./settings";
import { useTogetherStore } from "./together";
import { useStatusStore } from "./status";
import * as player from "@/core/player";

export const useCrossDeviceStore = defineStore("crossDevice", () => {
  const canResume = ref(false);
  const busy = ref(false);
  const error = ref("");
  let epoch = 0;
  let refreshing: Promise<void> | null = null;
  const enabled = computed(
    () => !!useUserStore().profile && useSettingsStore().system.player.crossDeviceResume,
  );

  const cancel = (): void => {
    epoch++;
    refreshing = null;
    busy.value = canResume.value = false;
    error.value = "";
    void useHistoryStore().setRemote("", []);
    void window.api.crossDevice.cancel();
  };
  /** 焦点和页面读取共享在途请求，后台不建立额外轮询。 */
  const refresh = (): Promise<void> => {
    if (!enabled.value) return Promise.resolve();
    if (refreshing) return refreshing;
    const generation = epoch;
    const accountId = String(useUserStore().profile!.userId);
    const job = (async () => {
      try {
        const result = await window.api.crossDevice.refresh();
        if (
          generation !== epoch ||
          !enabled.value ||
          String(useUserStore().profile?.userId) !== accountId
        )
          return;
        if (result.ok && result.data.accountId === accountId) {
          await useHistoryStore().setRemote(accountId, result.data.records);
          if (generation !== epoch) return;
          canResume.value = result.data.canResume;
        } else if (
          result.ok ||
          ["auth-required", "account-changed", "disabled"].includes(result.error)
        )
          cancel();
      } catch {
        /* 网络中断保留当前账号的已取得记录。 */
      }
    })();
    refreshing = job;
    void job.finally(() => {
      if (refreshing === job) refreshing = null;
    });
    return job;
  };

  const resume = async (): Promise<void> => {
    if (!enabled.value || busy.value) return;
    const together = useTogetherStore();
    if (together.snapshot.roomId) {
      error.value = "already-in-room";
      return;
    }
    const generation = epoch;
    busy.value = true;
    error.value = "";
    try {
      const result = await window.api.crossDevice.resume();
      if (generation !== epoch || !enabled.value) return;
      canResume.value = false;
      if (!result.ok) {
        error.value = result.error;
        return;
      }
      if (together.snapshot.roomId) {
        error.value = "already-in-room";
        return;
      }
      const { tracks, index, playMode } = result.data;
      const status = useStatusStore();
      status.repeatMode = playMode === "single_loop" ? "one" : "list";
      status.shuffleMode = playMode === "random" ? "on" : "off";
      await player.playFrom(tracks, index, {
        originId: "cross-device",
        originType: "page",
        originName: "",
      });
    } catch {
      if (generation === epoch) error.value = "offline";
    } finally {
      if (generation === epoch) busy.value = false;
    }
  };
  return { canResume, busy, error, enabled, refresh, resume, cancel };
});
