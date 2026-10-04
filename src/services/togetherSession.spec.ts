import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import type { TogetherSnapshot } from "@shared/types/together";
import { toast } from "@/composables/useToast";
import {
  clearTogetherSession,
  playTogetherTrack,
  setTogetherSession,
  setTogetherAddHandler,
  setTogetherPlayHandler,
  playTogetherTracks,
  addTogetherTracks,
} from "./togetherSession";
vi.mock("@/composables/useToast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n", () => ({ default: { global: { t: (key: string) => key } } }));
const room: TogetherSnapshot = {
  mode: "native",
  playbackOwned: true,
  connected: true,
  roomId: "test-room",
  status: "together",
  members: [],
  songs: [{ id: "10", name: "song", artists: "artist", durationMs: 60000 }],
  songId: "10",
  playing: true,
  progressMs: 0,
  updatedAt: 0,
};

describe("room-only playback actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTogetherSession();
    setTogetherSession(room);
  });
  it("plays an unqueued official song through the atomic play handler without the obsolete add hint", async () => {
    const play = vi.fn(async () => true);
    setTogetherPlayHandler(play);
    const track = { id: "11", source: "netease" } as Track;
    await playTogetherTrack(track);
    expect(play).toHaveBeenCalledExactlyOnceWith([track], 0);
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("keeps the NetEase guard and preserves play-all order while filtering unsupported entries", async () => {
    const play = vi.fn(async () => true);
    setTogetherPlayHandler(play);
    const tracks = [
      { id: "qq", source: "qqmusic" },
      { id: "11", source: "netease" },
      { id: "private", source: "netease", cloud: true },
      { id: "10", source: "netease" },
    ] as Track[];
    await playTogetherTracks(tracks);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(play).not.toHaveBeenCalled();
    await playTogetherTracks(tracks, 1);
    expect(play).toHaveBeenCalledExactlyOnceWith([tracks[1], tracks[3]], 0);
    clearTogetherSession();
    await playTogetherTrack(tracks[1]);
    expect(play).toHaveBeenCalledOnce();
  });
  it("routes explicit queue additions through one batch handler and releases it on disposal", async () => {
    const add = vi.fn(async () => true);
    setTogetherAddHandler(add);
    const tracks = [{ id: "11", source: "netease" } as Track];
    expect(await addTogetherTracks(tracks)).toBe(true);
    expect(add).toHaveBeenCalledExactlyOnceWith(tracks);
    clearTogetherSession();
    expect(await addTogetherTracks(tracks)).toBe(false);
    expect(add).toHaveBeenCalledOnce();
  });
});
