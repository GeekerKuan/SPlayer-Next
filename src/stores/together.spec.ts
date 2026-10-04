import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTogetherStore } from "./together";
import type { TogetherSnapshot } from "@shared/types/together";
import { controlTogetherPlayback } from "@/services/togetherSession";
vi.mock("@/services/togetherPlayback", () => ({
  applyTogetherPlayback: vi.fn(),
  disposeTogetherPlayback: vi.fn(),
  prepareTogetherPlayback: vi.fn(),
  discardPreparedTogetherPlayback: vi.fn(),
}));

const snapshot: TogetherSnapshot = {
  connected: true,
  status: "together",
  roomId: "a",
  members: [],
  songs: [{ id: "1", name: "queued", artists: "artist", durationMs: 30000 }],
  songId: "1",
  playing: false,
  progressMs: 1000,
  updatedAt: 0,
};
describe("together state lifecycle", () => {
  let update: (value: TogetherSnapshot) => void;
  const unsubscribe = vi.fn();
  const stop = vi.fn();
  beforeEach(() => {
    setActivePinia(createPinia());
    unsubscribe.mockClear();
    stop.mockClear();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        together: {
          onUpdate: (callback: typeof update) => {
            update = callback;
            return unsubscribe;
          },
          stop,
          connect: async () => ({ ok: true, data: snapshot }),
          recommendations: async () => ({
            ok: true,
            data: [
              ...snapshot.songs,
              { id: "2", name: "candidate", artists: "artist", durationMs: 20000 },
            ],
          }),
        },
      },
    });
  });
  it("filters recommended duplicates without replacing the room queue", async () => {
    const store = useTogetherStore();
    await store.connect();
    await store.loadRecommendations();
    expect(store.recommendations.map((s) => s.id)).toEqual(["2"]);
    expect(store.snapshot.songs.map((s) => s.id)).toEqual(["1"]);
  });
  it("prefers live room recommendations and drops candidates from a previous room", async () => {
    const store = useTogetherStore();
    store.start();
    await store.connect();
    await store.loadRecommendations();
    update({
      ...snapshot,
      recommendations: [
        ...snapshot.songs,
        { id: "3", name: "room recommendation", artists: "", durationMs: 30000 },
      ],
    });
    expect(store.recommendations.map((song) => song.id)).toEqual(["3"]);
    update({ ...snapshot, roomId: "b", recommendations: [] });
    expect(store.recommendations).toHaveLength(0);
    store.stop();
  });
  it("drops a late connection result after the page unsubscribes", async () => {
    let finish!: (value: unknown) => void;
    window.api.together.connect = () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      });
    const store = useTogetherStore();
    store.start();
    const job = store.connect();
    store.stop();
    finish({ ok: true, data: snapshot });
    expect(await job).toBe(false);
    expect(store.snapshot.connected).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("keeps playback controls available while a single recommendation request is pending", async () => {
    const native = { ...snapshot, mode: "native" as const, playbackOwned: true, playing: true };
    window.api.together.connect = async () => ({ ok: true, data: native });
    let finish!: (value: unknown) => void;
    window.api.together.recommendations = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.together.recommendations>>>(
          (resolve) => (finish = resolve as typeof finish),
        ),
    );
    window.api.together.control = vi.fn(
      async (): ReturnType<typeof window.api.together.control> => ({
        ok: true,
        data: { ...native, playing: false, commandSeq: 2, playbackRevision: 2 },
      }),
    );
    const store = useTogetherStore();
    await store.connect();
    const reading = store.loadRecommendations();
    expect(store.recommendationsLoading).toBe(true);
    expect(store.busy).toBe(false);
    await store.loadRecommendations();
    expect(window.api.together.recommendations).toHaveBeenCalledOnce();
    expect(await store.control({ action: "pause" })).toBe(true);
    expect(window.api.together.control).toHaveBeenCalledWith({ action: "pause" });
    finish({ ok: true, data: [] });
    await reading;
    expect(store.recommendationsLoading).toBe(false);
    store.dispose();
  });

  it("clears recommendation loading on disposal and ignores its late response", async () => {
    let finish!: (value: unknown) => void;
    window.api.together.recommendations = () =>
      new Promise((resolve) => (finish = resolve as typeof finish));
    const store = useTogetherStore();
    await store.connect();
    const reading = store.loadRecommendations();
    store.dispose();
    expect(store.recommendationsLoading).toBe(false);
    finish({ ok: true, data: [{ id: "2", name: "late", artists: "", durationMs: 1000 }] });
    await reading;
    expect(store.recommendations).toHaveLength(0);
  });

  it("routes normal player controls through the same optimistic room state as the room panel", async () => {
    const native: TogetherSnapshot = {
      ...snapshot,
      mode: "native",
      playbackOwned: true,
      playing: true,
      commandSeq: 1,
      playbackRevision: 1,
    };
    window.api.together.connect = async () => ({ ok: true, data: native });
    let finish!: (value: unknown) => void;
    window.api.together.control = () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      });
    const store = useTogetherStore();
    store.start();
    await store.connect();
    const job = controlTogetherPlayback({ action: "seek", positionMs: 20000 });
    expect(store.snapshot.progressMs).toBeGreaterThanOrEqual(20000);
    expect(store.snapshot.playing).toBe(true);
    finish({ ok: true, data: { ...native, progressMs: 20000, playbackRevision: 2 } });
    await job;
    expect(store.error).toBe("");
    store.dispose();
  });
});
