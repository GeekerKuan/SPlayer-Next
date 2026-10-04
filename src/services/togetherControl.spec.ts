import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialResult } from "@shared/types/social";
import type { TogetherSnapshot } from "@shared/types/together";
import { TogetherControls } from "./togetherControl";

const initial: TogetherSnapshot = {
  mode: "native",
  playbackOwned: true,
  connected: true,
  status: "together",
  roomId: "room-a",
  members: [],
  songs: [
    { id: "10", name: "song", artists: "artist", durationMs: 60000 },
    { id: "11", name: "next", artists: "artist", durationMs: 60000 },
  ],
  songId: "10",
  playing: true,
  progressMs: 10000,
  updatedAt: 0,
  commandSeq: 10,
  playbackRevision: 1,
};
const fixture = () => {
  let finish!: (result: SocialResult<TogetherSnapshot>) => void;
  const publish = vi.fn(),
    refresh = vi.fn().mockResolvedValue({ ok: true, data: initial });
  const send = vi.fn(
    () =>
      new Promise<SocialResult<TogetherSnapshot>>((resolve) => {
        finish = resolve;
      }),
  );
  const controls = new TogetherControls({ publish, refresh, send });
  controls.ingest(initial);
  return {
    controls,
    publish,
    refresh,
    send,
    finish: (result: SocialResult<TogetherSnapshot>) => finish(result),
  };
};
describe("room seek reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("seeks locally before upload finishes, continues playing, and masks old polling positions", async () => {
    const f = fixture();
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    expect(f.publish.mock.lastCall?.[0].progressMs).toBe(30000);
    expect(f.publish.mock.lastCall?.[0].playing).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    f.controls.ingest({ ...initial, progressMs: 11000 });
    expect(f.publish.mock.lastCall?.[0].progressMs).toBe(31000);
    expect(f.publish.mock.lastCall?.[2]).toBe(false);
    f.finish({ ok: true, data: { ...initial, progressMs: 30000, playbackRevision: 2 } });
    await result;
    expect(f.publish.mock.lastCall?.[2]).toBe(true);
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ action: "seek", positionMs: 30000 });
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("recognizes a polling echo and a delayed success without treating unrelated remote commands as local", async () => {
    const f = fixture();
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    f.controls.ingest({ ...initial, commandSeq: 11, progressMs: 30000, playbackRevision: 2 });
    expect(f.publish.mock.lastCall?.[2]).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    f.finish({
      ok: true,
      data: { ...initial, commandSeq: 11, progressMs: 35000, playbackRevision: 2 },
    });
    await result;
    // 提前收到匹配确认后不再保留保护定时器，后续同一版本更新也无需强制 seek。
    expect(f.publish.mock.lastCall?.[2]).toBe(true);
    f.controls.ingest({ ...initial, commandSeq: 12, progressMs: 16000, playbackRevision: 3 });
    expect(f.publish.mock.lastCall?.[2]).toBe(false);
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a new remote seek or track takes precedence, and an older late acknowledgement cannot undo it", async () => {
    const f = fixture();
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    f.controls.ingest({
      ...initial,
      commandSeq: 11,
      songId: "11",
      progressMs: 0,
      playbackRevision: 2,
    });
    expect(f.publish.mock.lastCall?.[0].songId).toBe("11");
    f.finish({ ok: true, data: { ...initial, progressMs: 30000 } });
    await result;
    expect(f.publish.mock.lastCall?.[0].songId).toBe("11");
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("expiry reads actual state once, without replaying the control or blindly restoring cached progress", async () => {
    const f = fixture();
    f.refresh.mockResolvedValueOnce({ ok: false, error: "rate-limited" });
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.publish.mock.lastCall?.[0].progressMs).toBe(30000);
    f.finish({ ok: true, data: { ...initial, commandSeq: 11, progressMs: 35000 } });
    await result;
    expect(f.send).toHaveBeenCalledOnce();
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("failed upload reconciles against a fresh read", async () => {
    const f = fixture();
    f.refresh.mockResolvedValueOnce({
      ok: true,
      data: { ...initial, commandSeq: 11, progressMs: 16000 },
    });
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    f.finish({ ok: false, error: "operation-unknown" });
    expect((await result).ok).toBe(false);
    await Promise.resolve();
    expect(f.publish.mock.lastCall?.[0].progressMs).toBe(16000);
    expect(f.send).toHaveBeenCalledOnce();
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("dispose settles pending work, removes both timers, and rejects late results and reads", async () => {
    const f = fixture();
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    f.controls.dispose();
    expect(await result).toEqual({ ok: false, error: "cancelled" });
    const count = f.publish.mock.calls.length;
    f.finish({ ok: true, data: initial });
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.publish).toHaveBeenCalledTimes(count);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a stuck IPC operation has a bounded deadline and is not resent", async () => {
    const f = fixture();
    const result = f.controls.control({ action: "seek", positionMs: 30000 });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toEqual({ ok: false, error: "operation-unknown" });
    expect(f.send).toHaveBeenCalledOnce();
    f.controls.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["pause", "resume"] as const)(
    "%s applies locally and a matching ACK neither seeks nor refreshes again",
    async (action) => {
      const publish = vi.fn(),
        refresh = vi.fn();
      let finish!: (value: SocialResult<TogetherSnapshot>) => void;
      const send = vi.fn(
        () =>
          new Promise<SocialResult<TogetherSnapshot>>((resolve) => {
            finish = resolve;
          }),
      );
      const controls = new TogetherControls({ publish, refresh, send, position: () => 15000 });
      const first = { ...initial, playing: action === "pause" };
      controls.ingest(first);
      const job = controls.control({ action });
      expect(publish.mock.lastCall?.[0]).toMatchObject({
        progressMs: 15000,
        playing: action === "resume",
      });
      expect(publish.mock.lastCall?.slice(1)).toEqual([false, true]);
      await vi.advanceTimersByTimeAsync(500);
      controls.ingest({ ...first, progressMs: 10500 });
      expect(publish.mock.lastCall?.[0].playing).toBe(action === "resume");
      finish({
        ok: true,
        data: {
          ...first,
          progressMs: 15000,
          playing: action === "resume",
          commandSeq: 11,
          playbackRevision: 2,
        },
      });
      await job;
      expect(publish.mock.lastCall?.[2]).toBe(true);
      await vi.advanceTimersByTimeAsync(20000);
      expect(refresh).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      controls.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
