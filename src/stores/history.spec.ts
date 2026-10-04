import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(async () => {}) }));
vi.mock("localforage", () => ({
  default: { createInstance: () => ({ getItem: storage.get, setItem: storage.set }) },
}));
import { useHistoryStore } from "./history";
const track: Track = { source: "netease", id: "3", title: "song", artists: [], duration: 60000 };
const records = [{ track, playedAt: 20 }];

describe("remote play history", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    storage.get.mockReset();
    storage.set.mockClear();
    storage.get.mockResolvedValue(null);
  });

  it("shares the hidden-record read across concurrent refreshes and keeps deleted records hidden", async () => {
    let release!: (value: unknown) => void;
    storage.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const store = useHistoryStore();
    const first = store.setRemote("1", records);
    const next = store.setRemote("1", [...records, { track: { ...track, id: "4" }, playedAt: 21 }]);
    release({ accountId: "1", hidden: { "netease:3": 20 } });
    await Promise.all([first, next]);
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(store.tracks.map((item) => item.id)).toEqual(["4"]);
    store.remove(store.tracks[0]);
    await store.setRemote("1", records);
    await store.setRemote("1", [...records, { track: { ...track, id: "4" }, playedAt: 21 }]);
    expect(store.tracks).toHaveLength(0);
    expect(storage.set).toHaveBeenCalledWith("entries", []);
    expect(storage.set).toHaveBeenCalledWith("remote-hidden", {
      accountId: "1",
      hidden: { "netease:3": 20, "netease:4": 21 },
    });
    await store.setRemote("1", [{ track, playedAt: 22 }]);
    expect(store.entries[0].playedAt).toBe(22);
  });

  it("discards a late account read after logout and never writes remote songs into local history", async () => {
    let release!: (value: unknown) => void;
    storage.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const store = useHistoryStore();
    const old = store.setRemote("1", records);
    await store.setRemote("", []);
    release({ accountId: "1", hidden: {} });
    await old;
    expect(store.entries).toHaveLength(0);
    await store.setRemote("2", records);
    expect(store.entries).toHaveLength(1);
    expect(storage.set).not.toHaveBeenCalled();
  });
});
