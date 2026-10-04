import { createPinia, setActivePinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";
import type { LyricLine } from "@shared/types/lyrics";
import { useMediaStore } from "./media";

const f = vi.hoisted(() => ({ transform: vi.fn() }));
vi.mock("@/services/lyric/loader", () => ({ watchLyricPreference: vi.fn() }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: () => ({
    locale: "zh-CN",
    lyric: { cjkTransform: "s2t", detectBackgroundLyrics: false },
  }),
}));
vi.mock("@/utils/lyric/cjkTransform", () => ({ applyLyricCjkTransform: f.transform }));

beforeEach(() => {
  setActivePinia(createPinia());
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { nowPlaying: { update: vi.fn() } },
  });
});

it.each(["clear", "resetLyricState", "emptyLyric"] as const)(
  "%s 后迟到的简繁转换不能恢复上一首歌词",
  async (operation) => {
    let finish!: (lines: LyricLine[]) => void;
    f.transform.mockReturnValueOnce(
      new Promise<LyricLine[]>((resolve) => {
        finish = resolve;
      }),
    );
    const media = useMediaStore();
    media.setLyric({ source: "embedded", format: "lrc" }, { content: "[00:01.00]旧歌词" });
    const oldLines = media.parsedLyric;
    expect(oldLines).toHaveLength(1);
    expect(f.transform).toHaveBeenCalledOnce();
    if (operation === "emptyLyric") media.setLyric(null, null);
    else media[operation]();
    const updates = vi.mocked(window.api.nowPlaying.update).mock.calls.length;
    finish(oldLines);
    await flushPromises();
    expect(media.parsedLyric).toEqual([]);
    expect(window.api.nowPlaying.update).toHaveBeenCalledTimes(updates);
  },
);
