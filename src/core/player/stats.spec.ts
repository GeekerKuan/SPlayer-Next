import { effectScope, nextTick, reactive, shallowReactive } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
const f = vi.hoisted(() => ({
  record: vi.fn(),
  media: {} as { track: Track | null },
  status: {} as { state: string },
}));
vi.mock("@/stores/media", () => ({ useMediaStore: () => f.media }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => f.status }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ record: f.record }) }));
describe("actual playback history", () => {
  it("updates the original history on actual play including direct room loads, without recording paused restore or resumes twice", async () => {
    f.media = shallowReactive({
      track: { id: "10", source: "netease", title: "song", artists: [], duration: 60000 },
    });
    f.status = reactive({ state: "paused" });
    const scope = effectScope();
    const listener = vi.spyOn(window, "addEventListener");
    const { installPlayStats } = await import("./stats");
    scope.run(installPlayStats);
    expect(f.record).not.toHaveBeenCalled();
    f.status.state = "playing";
    await nextTick();
    expect(f.record).toHaveBeenCalledExactlyOnceWith(f.media.track);
    f.status.state = "paused";
    await nextTick();
    f.status.state = "playing";
    await nextTick();
    expect(f.record).toHaveBeenCalledOnce();
    f.media.track = { ...f.media.track!, id: "11" };
    await nextTick();
    expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.record).toHaveBeenLastCalledWith(f.media.track);
    scope.stop();
    const unload = listener.mock.calls.find(([event]) => event === "beforeunload")?.[1];
    if (unload) window.removeEventListener("beforeunload", unload);
    listener.mockRestore();
  });
});
