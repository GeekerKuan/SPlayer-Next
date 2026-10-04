import { useCrossDeviceStore } from "@/stores/crossDevice";
import { useUserStore } from "@/stores/user";
import { useStatusStore } from "@/stores/status";
import { useMediaStore } from "@/stores/media";
import { useTogetherStore } from "@/stores/together";
import { queue } from "@/stores/queue";

/** 复用播放器状态和队列事件，所有订阅跟随主窗口组件释放。 */
export const useCrossDevice = (): void => {
  const crossDevice = useCrossDeviceStore();
  const user = useUserStore();
  const status = useStatusStore();
  const media = useMediaStore();
  const together = useTogetherStore();
  let alive = true;
  let publishing = false;
  let dirty = false;
  const publish = async (): Promise<void> => {
    dirty = true;
    if (publishing) return;
    publishing = true;
    try {
      while (dirty && alive) {
        dirty = false;
        const current = media.track;
        if (
          !crossDevice.enabled ||
          together.snapshot.roomId ||
          status.state !== "playing" ||
          current?.source !== "netease" ||
          current.cloud
        )
          continue;
        const ids = [
          ...new Set(
            queue.value
              .filter((track) => track.source === "netease" && !track.cloud)
              .map((track) => track.id),
          ),
        ];
        // 与 Windows 快照相同，保留当前歌曲附近的顺序，避免大队列把当前曲目移到尾部。
        const index = Math.max(0, ids.indexOf(current.id));
        const songIds =
          ids.length > 1000
            ? ids.slice(Math.max(0, index - 500), Math.min(ids.length, index + 500))
            : ids;
        if (!songIds.includes(current.id)) {
          if (songIds.length === 1000) songIds.pop();
          songIds.push(current.id);
        }
        await window.api.crossDevice.publish({
          songIds,
          currentId: current.id,
          playMode:
            status.shuffleMode === "on"
              ? "random"
              : status.repeatMode === "one"
                ? "single_loop"
                : "list_loop",
        });
      }
    } catch {
      /* 续播上报失败不阻塞原生播放器。 */
    } finally {
      publishing = false;
    }
  };
  const focus = (): void => {
    if (document.visibilityState === "visible") void crossDevice.refresh();
  };
  watch(
    () => [user.profile?.userId, crossDevice.enabled],
    () => {
      crossDevice.cancel();
      if (crossDevice.enabled) {
        void crossDevice.refresh();
        void publish();
      }
    },
    { immediate: true },
  );
  watch(
    [
      queue,
      () => media.track?.id,
      () => status.state,
      () => status.repeatMode,
      () => status.shuffleMode,
      () => together.snapshot.roomId,
    ],
    publish,
  );
  onMounted(() => window.addEventListener("focus", focus));
  onBeforeUnmount(() => {
    alive = false;
    dirty = false;
    window.removeEventListener("focus", focus);
    crossDevice.cancel();
  });
};
