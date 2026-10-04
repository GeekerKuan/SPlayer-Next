import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";
import type { TogetherSnapshot } from "@shared/types/together";
import { toast } from "@/composables/useToast";
import {
  clearTogetherSession,
  playTogetherTrack,
  setTogetherSession,
  setTogetherControlHandler,
  setTogetherAddHandler,
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
  it("uses a helpful add-to-room hint for a valid unqueued song without sending new writes", async () => {
    const control = vi.fn();
    setTogetherControlHandler(control);
    await playTogetherTrack({ id: "11", source: "netease" } as Track);
    expect(toast.info).toHaveBeenCalledWith("social.together.useRoomAdd");
    expect(toast.error).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  });
  it("preserves the NetEase source guard and sends GOTO only for a confirmed room song", async () => {
    const control = vi.fn(async () => ({ ok: true as const, data: room }));
    setTogetherControlHandler(control);
    await playTogetherTrack({ id: "10", source: "qqmusic" } as Track);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(control).not.toHaveBeenCalled();
    await playTogetherTrack({ id: "10", source: "netease" } as Track);
    expect(control).toHaveBeenCalledExactlyOnceWith({ action: "goto", songId: "10" });
    clearTogetherSession();
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
