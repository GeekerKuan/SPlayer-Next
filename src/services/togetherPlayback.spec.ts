import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import type { TogetherSnapshot } from "@shared/types/together";

const f = vi.hoisted(() => ({
  media: {
    track: null as null | { source: string; id: string },
    setTrack: vi.fn(),
    setPlaybackContext: vi.fn(),
    clear: vi.fn(),
  },
  status: {
    state: "paused",
    currentSource: null as string | null,
    position: 0,
    duration: 60000,
    isPlaying: false,
    playIndex: 0,
    fmMode: false,
    heartMode: false,
    shuffleMode: "off",
    repeatMode: "list",
  },
  load: vi.fn(),
  beginLyricLoad: vi.fn(),
  resolve: vi.fn(),
  setQueue: vi.fn(),
  backup: null as import("@/stores/queue").TemporaryPlaybackState | null,
  queueEntries: { value: [] },
  restoreQueue: vi.fn(),
  control: vi.fn(),
  seek: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  currentTime: 0,
}));
vi.mock("@/stores/media", () => ({ useMediaStore: () => f.media }));
vi.mock("@/stores/status", () => ({ useStatusStore: () => f.status }));
vi.mock("@/stores/queue", () => ({
  queueEntries: f.queueEntries,
  setTemporaryQueue: f.setQueue,
  prepareTemporaryPlayback: vi.fn(),
  discardPreparedPlayback: vi.fn(),
  getTemporaryPlaybackState: () => f.backup,
  restoreTemporaryQueue: f.restoreQueue,
  getQueueItem: () => ({
    track: { id: "normal", source: "netease", title: "normal", artists: [], duration: 60000 },
  }),
}));
vi.mock("@/core/player", () => ({
  load: f.load,
  seekLocally: f.seek,
  clearLocalSeek: vi.fn(),
  invalidatePlaybackOperation: vi.fn(),
}));
vi.mock("./audioSource", () => ({ resolveTrackSource: f.resolve }));
vi.mock("./playback", () => ({
  getCurrentTime: () => f.currentTime,
  setCurrentTime: vi.fn(),
  setDuration: vi.fn(),
  setPlaying: vi.fn(),
}));
vi.mock("./togetherSession", () => ({ setTogetherSession: vi.fn() }));
vi.mock("./lyric/loader", () => ({ beginLoad: f.beginLyricLoad }));
import { applyTogetherPlayback, disposeTogetherPlayback } from "./togetherPlayback";
const snapshot = (roomId: string): TogetherSnapshot => ({
  mode: "native",
  playbackOwned: true,
  connected: true,
  status: "together",
  roomId,
  members: [],
  songs: [{ id: "10", name: "song", artists: "artist", durationMs: 60000 }],
  songId: "10",
  playing: true,
  progressMs: 30000,
  updatedAt: 1,
  commandSeq: 10,
  playbackRevision: 1,
});
describe("native room playback bridge", () => {
  it("does not reload or resume an ended song while waiting for the next server command", async () => {
    applyTogetherPlayback({ ...snapshot("room-a"), awaitingNext: true });
    await Promise.resolve();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.play).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    f.backup = null;
    disposeTogetherPlayback();
    vi.clearAllMocks();
    f.media.track = null;
    f.status.currentSource = null;
    f.status.state = "paused";
    f.status.position = 32000;
    f.status.duration = 60000;
    f.status.repeatMode = "one";
    f.status.shuffleMode = "on";
    f.status.heartMode = true;
    f.status.isPlaying = false;
    f.currentTime = 0;
    f.seek.mockResolvedValue(undefined);
    f.media.setTrack.mockImplementation((track) => {
      f.media.track = track;
    });
    f.resolve.mockResolvedValue({ source: "https://m8.music.126.net/audio.flac" });
    f.load.mockImplementation(async () => {
      f.status.currentSource = "url";
      f.status.state = "paused";
      return { ok: true };
    });
    f.restoreQueue.mockImplementation(() => {
      const value = f.backup;
      f.backup = null;
      return value;
    });
    f.setQueue.mockImplementation((_tracks, _context, state) => {
      f.backup ||= state;
    });
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        player: { seek: f.seek, play: f.play, pause: f.pause },
        together: { control: f.control },
      },
    });
  });
  it("uses official-only resolution and applies remote state without sending another room command", async () => {
    applyTogetherPlayback(snapshot("room-a"));
    await flushPromises();
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ source: "netease" }), {
      officialOnly: true,
      silent: true,
    });
    expect(f.seek).toHaveBeenCalledWith(30000);
    expect(f.play).toHaveBeenCalledOnce();
    expect(f.control).not.toHaveBeenCalled();
  });

  it("leaving releases the temporary queue even while room audio resolution is pending", async () => {
    let finish!: (value: unknown) => void;
    f.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const room = snapshot("slow-room");
    applyTogetherPlayback(room);
    await flushPromises();
    expect(f.backup).not.toBeNull();
    applyTogetherPlayback({ ...room, roomId: "", playbackOwned: false, songs: [] });
    expect(f.restoreQueue).toHaveBeenCalledOnce();
    expect(f.backup).toBeNull();
    expect(f.status.repeatMode).toBe("one");
    expect(f.status.shuffleMode).toBe("on");
    expect(f.status.position).toBe(32000);
    expect(f.media.clear).toHaveBeenCalledOnce();
    expect(f.beginLyricLoad).toHaveBeenCalledOnce();
    finish({ source: "https://m8.music.126.net/old-room.flac" });
    await flushPromises();
    expect(f.load).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  it("an empty owned room isolates the queue and disposal restores it without autoplay", async () => {
    applyTogetherPlayback({ ...snapshot("empty-room"), songs: [], songId: "" });
    await flushPromises();
    expect(f.setQueue).toHaveBeenCalledWith([], expect.anything(), expect.anything());
    expect(f.backup).not.toBeNull();
    disposeTogetherPlayback();
    expect(f.backup).toBeNull();
    expect(f.play).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });
  it("a position-only refresh does not starve a slow URL resolution", async () => {
    let finish!: (value: unknown) => void;
    f.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = snapshot("room-b");
    applyTogetherPlayback(first);
    await flushPromises();
    applyTogetherPlayback({ ...first, updatedAt: 2, progressMs: 32000 });
    finish({ source: "https://m8.music.126.net/audio.flac" });
    await flushPromises();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.control).not.toHaveBeenCalled();
  });
  it("a server acknowledgement does not cancel an in-flight load of the same song", async () => {
    let finish!: (value: unknown) => void;
    f.resolve.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const room = snapshot("ack-loading");
    applyTogetherPlayback({ ...room, progressMs: 0 });
    await flushPromises();
    applyTogetherPlayback({ ...room, progressMs: 100, commandSeq: 11, playbackRevision: 2 });
    finish({ source: "https://m8.music.126.net/audio.flac" });
    await flushPromises();
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.seek).not.toHaveBeenCalled();
  });
  it("audio failure is bounded and never falls back to another platform", async () => {
    f.resolve.mockResolvedValueOnce(null);
    const onError = vi.fn();
    const room = snapshot("room-c");
    applyTogetherPlayback(room, onError);
    await flushPromises();
    applyTogetherPlayback({ ...room, updatedAt: 2 }, onError);
    await flushPromises();
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.load).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("room-audio-unavailable");
  });

  it("a small local seek is immediate without altering server revisions or swallowing the next remote command", async () => {
    const room = snapshot("room-d");
    applyTogetherPlayback(room);
    await flushPromises();
    f.seek.mockClear();
    applyTogetherPlayback({ ...room, progressMs: 500 }, undefined, true);
    await flushPromises();
    expect(f.seek).toHaveBeenLastCalledWith(500);
    applyTogetherPlayback({ ...room, progressMs: 700, playbackRevision: 2, commandSeq: 11 });
    await flushPromises();
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(500);
    expect(f.control).not.toHaveBeenCalled();
  });
  it("keeps smooth playback across delayed acknowledgement revisions within the correction tolerance", async () => {
    const room = snapshot("room-e");
    applyTogetherPlayback(room);
    await flushPromises();
    f.currentTime = 31000;
    f.status.isPlaying = true;
    f.seek.mockClear();
    f.play.mockClear();
    const confirmed = { ...room, progressMs: 31200, playbackRevision: 2, commandSeq: 11 };
    applyTogetherPlayback(confirmed, undefined, false, true);
    await flushPromises();
    expect(f.seek).not.toHaveBeenCalled();
    expect(f.play).not.toHaveBeenCalled();
    expect(f.pause).not.toHaveBeenCalled();
    applyTogetherPlayback({ ...confirmed, progressMs: 31500, playbackRevision: 3, commandSeq: 12 });
    await flushPromises();
    expect(f.seek).not.toHaveBeenCalled();
    applyTogetherPlayback({ ...confirmed, progressMs: 40000, playbackRevision: 4, commandSeq: 13 });
    await flushPromises();
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(40000);
  });
  it("corrects a confirmed seek when the actual local clock has drifted materially", async () => {
    const room = snapshot("room-f");
    applyTogetherPlayback(room);
    await flushPromises();
    f.currentTime = 20000;
    f.seek.mockClear();
    applyTogetherPlayback({ ...room, playbackRevision: 2, commandSeq: 11 }, undefined, false, true);
    await flushPromises();
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(30000);
  });
  it.each([false, true])(
    "local play-state acknowledgement playing=%s does not reset nearby progress",
    async (playing) => {
      const room = snapshot("play-state");
      applyTogetherPlayback(room);
      await flushPromises();
      f.currentTime = 31000;
      f.status.isPlaying = !playing;
      f.seek.mockClear();
      f.play.mockClear();
      f.pause.mockClear();
      applyTogetherPlayback(
        { ...room, playing, progressMs: 31200, playbackRevision: 2, commandSeq: 11 },
        undefined,
        false,
        true,
      );
      await flushPromises();
      expect(f.seek).not.toHaveBeenCalled();
      expect(playing ? f.play : f.pause).toHaveBeenCalledOnce();
      expect(f.control).not.toHaveBeenCalled();
    },
  );
  it("does not repeat a local engine seek when the server acknowledgement arrives during its completion", async () => {
    const room = snapshot("room-g");
    applyTogetherPlayback(room);
    await flushPromises();
    f.seek.mockClear();
    let finish!: () => void;
    f.seek.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    f.currentTime = 500;
    applyTogetherPlayback({ ...room, progressMs: 500 }, undefined, true);
    await flushPromises();
    applyTogetherPlayback(
      { ...room, progressMs: 600, commandSeq: 11, playbackRevision: 2 },
      undefined,
      false,
      true,
    );
    finish();
    await flushPromises();
    expect(f.seek).toHaveBeenCalledExactlyOnceWith(500);
  });
});
