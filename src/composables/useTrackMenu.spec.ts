import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, reactive, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import type { TogetherSnapshot } from "@shared/types/together";
import zh from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({
  together: null as unknown as {
    snapshot: TogetherSnapshot;
    busy: boolean;
    error: string;
    add: (id: string) => Promise<boolean>;
  },
  add: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/core/player", () => ({ playNow: vi.fn(), insertToQueue: vi.fn() }));
vi.mock("@/stores/together", () => ({ useTogetherStore: () => mocks.together }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({ system: { download: { enabled: false } } }),
}));
vi.mock("@/stores/plugins", () => ({ usePluginsStore: () => ({ menuContributions: [] }) }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => ({}) }));
vi.mock("@/composables/useCopyText", () => ({ useCopyText: () => ({ copy: vi.fn() }) }));
vi.mock("@/composables/useToast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
vi.mock("@/composables/useDownload", () => ({ buildDownloadQualityItems: () => [] }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { useTrackMenu } from "./useTrackMenu";

const song: Track = {
  id: "42",
  source: "netease",
  title: "推荐歌曲",
  artists: [],
  duration: 30000,
};
function fixture() {
  const track = ref<Track>(song);
  let menu!: ReturnType<typeof useTrackMenu>;
  const wrapper = mount(
    defineComponent({
      setup() {
        menu = useTrackMenu(track);
        return () => null;
      },
    }),
    {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } })],
      },
    },
  );
  return { track, menu, wrapper };
}
describe("original song menu room additions", () => {
  beforeEach(() => {
    mocks.add.mockResolvedValue(true);
    mocks.together = reactive({
      snapshot: {
        mode: "native",
        playbackOwned: true,
        connected: true,
        status: "together",
        roomId: "room-a",
        members: [],
        songs: [],
        songId: "",
        playing: false,
        progressMs: 0,
        updatedAt: 0,
      },
      busy: false,
      error: "",
      add: mocks.add,
    });
  });
  it("reuses the room ADD operation for original recommendations and hides local queue insertion", async () => {
    const { menu, wrapper } = fixture();
    expect(menu.items.value.find((item) => item.key === "addToTogether")?.show).toBe(true);
    expect(menu.items.value.find((item) => item.key === "playNext")?.show).toBe(false);
    await menu.handleSelect("addToTogether");
    expect(mocks.add).toHaveBeenCalledWith("42");
    // 结果提示由 store 统一处理，入口不重复弹提示。
    expect(mocks.success).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("rejects cloud and non-NetEase songs, and becomes unavailable after leaving", async () => {
    const { track, menu, wrapper } = fixture();
    for (const value of [
      { ...song, cloud: true },
      { ...song, source: "local" as const },
    ]) {
      track.value = value;
      expect(menu.items.value.find((item) => item.key === "addToTogether")?.show).toBe(false);
      await menu.handleSelect("addToTogether");
    }
    track.value = song;
    mocks.together.snapshot.playbackOwned = false;
    await menu.handleSelect("addToTogether");
    expect(mocks.add).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("does not display a success notification for a previous room", async () => {
    let finish!: (value: boolean) => void;
    mocks.add.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { menu, wrapper } = fixture();
    const pending = menu.handleSelect("addToTogether");
    mocks.together.snapshot.roomId = "room-b";
    finish(true);
    await pending;
    expect(mocks.success).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
