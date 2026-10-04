import type { PlaybackContext, PlaybackQueueItem, Track } from "@shared/types/player";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn((_key: string, _value: PlaybackQueueItem[] | null) => Promise.resolve()),
}));

vi.mock("localforage", () => ({
  default: {
    createInstance: () => storage,
  },
}));

import {
  findTrackIndex,
  getTrack,
  insertManyToQueue,
  insertToQueue,
  moveInQueue,
  originalQueue,
  queue,
  queueEntries,
  removeFromQueue,
  restoreQueue,
  setQueue,
  shuffleQueue,
  unshuffleQueue,
  updateQueueItem,
  updateQueueTracks,
  setTemporaryQueue,
  restoreTemporaryQueue,
  getTemporaryPlaybackState,
  getPersistentQueuePlaybackState,
  prepareTemporaryPlayback,
  discardPreparedPlayback,
  removeServerTracks,
} from "./queue";

const track = (id: string): Track => ({
  id,
  source: "local",
  title: id,
  artists: [],
  duration: 1_000,
});

const context: PlaybackContext = {
  provider: "netease",
  originId: "456",
  originType: "playlist",
  originName: "测试歌单",
};

const entry = (id: string, playbackContext?: PlaybackContext): PlaybackQueueItem => ({
  track: track(id),
  context: playbackContext,
});
const playback = {
  playIndex: 1,
  position: 32000,
  duration: 60000,
  repeatMode: "one" as const,
  shuffleMode: "on" as const,
  heartMode: true,
  fmMode: false,
};

describe("queue", () => {
  beforeEach(() => {
    restoreTemporaryQueue();
    queueEntries.value = [];
    originalQueue.value = null;
    storage.getItem.mockReset();
    storage.setItem.mockClear();
  });

  it("房间队列不落盘，跨房更新后恢复同一份普通队列、上下文和随机备份", () => {
    setQueue([track("a"), track("b")], context);
    originalQueue.value = [entry("b", context), entry("a", context)];
    storage.setItem.mockClear();
    setTemporaryQueue([track("room-a")], context, playback);
    setTemporaryQueue([track("room-b")], context, { ...playback, playIndex: 0, position: 0 });
    insertToQueue(track("temporary"), 0);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(getPersistentQueuePlaybackState()).toEqual(playback);
    expect(restoreTemporaryQueue()).toEqual(playback);
    expect(queue.value.map((item) => item.id)).toEqual(["a", "b"]);
    expect(queueEntries.value[1].context).toEqual(context);
    expect(originalQueue.value?.map((item) => item.track.id)).toEqual(["b", "a"]);
    expect(getTemporaryPlaybackState()).toBeNull();
    expect(restoreTemporaryQueue()).toBeNull();
  });

  it("入房失败清理预备记忆，成功则沿用音频停止前的位置", () => {
    setQueue([track("a"), track("b")]);
    prepareTemporaryPlayback(playback);
    expect(getPersistentQueuePlaybackState()?.position).toBe(32000);
    expect(getTemporaryPlaybackState()).toBeNull();
    discardPreparedPlayback();
    expect(getPersistentQueuePlaybackState()).toBeNull();
    prepareTemporaryPlayback(playback);
    setTemporaryQueue([], context, { ...playback, position: 0 });
    expect(restoreTemporaryQueue()?.position).toBe(32000);
  });

  it("房间歌曲的元数据不会污染同 ID 的本地或流媒体歌曲", () => {
    setQueue([track("10"), { ...track("10"), source: "streaming", serverId: "server" }]);
    setTemporaryQueue([{ ...track("10"), source: "netease" }], context, playback);
    updateQueueTracks([{ ...track("10"), source: "netease", title: "room metadata" }]);
    expect(queue.value[0].title).toBe("room metadata");
    restoreTemporaryQueue();
    expect(queue.value.map((item) => item.source)).toEqual(["local", "streaming"]);
    expect(queue.value.every((item) => item.title === "10")).toBe(true);
  });

  it("迟到的磁盘恢复只更新普通队列，不替换正在显示的房间列表", async () => {
    setTemporaryQueue([track("room")], context, playback);
    storage.getItem.mockResolvedValueOnce([track("a")]).mockResolvedValueOnce(null);
    await restoreQueue();
    expect(queue.value[0].id).toBe("room");
    restoreTemporaryQueue();
    expect(queue.value[0].id).toBe("a");
  });

  it("一起听期间标签修改和服务器删除仍更新普通队列，房间曲目不会持久化", () => {
    setQueue([{ ...track("a"), source: "streaming", serverId: "deleted" }, track("b")]);
    setTemporaryQueue([track("room")], context, playback);
    storage.setItem.mockClear();
    updateQueueTracks([{ ...track("b"), title: "changed" }]);
    removeServerTracks("deleted");
    const savedLists = storage.setItem.mock.calls.filter((call) => call[0] === "playList");
    expect(savedLists.every((call) => !call[1]?.some((item) => item.track.id === "room"))).toBe(
      true,
    );
    expect(restoreTemporaryQueue()?.playIndex).toBe(0);
    expect(queue.value.map((item) => item.id)).toEqual(["b"]);
    expect(queue.value[0].title).toBe("changed");
  });

  it("替换队列时复制输入并清除洗牌备份", () => {
    const input = [track("a"), track("b")];
    originalQueue.value = [entry("old")];

    setQueue(input);
    input.push(track("c"));

    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(originalQueue.value).toBeNull();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("插入位置会限制在队列边界并同步洗牌备份", () => {
    queueEntries.value = [entry("a"), entry("c")];
    originalQueue.value = [entry("a"), entry("c")];

    insertToQueue(track("b"), 1);
    insertManyToQueue([track("d"), track("e")], 99);

    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(originalQueue.value?.map((item) => item.track.id)).toEqual(["a", "c", "b", "d", "e"]);
  });

  it("删除歌曲时按 ID 同步洗牌备份", () => {
    queueEntries.value = [entry("c"), entry("a"), entry("b")];
    originalQueue.value = [entry("a"), entry("b"), entry("c")];

    removeFromQueue(0);

    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(originalQueue.value?.map((item) => item.track.id)).toEqual(["a", "b"]);
  });

  it("移动和更新曲目时保持队列身份操作正确", () => {
    queueEntries.value = [entry("a"), entry("b"), entry("c")];

    moveInQueue(0, 2);
    updateQueueTracks([{ ...track("b"), title: "updated" }]);

    expect(queue.value.map(({ id }) => id)).toEqual(["b", "c", "a"]);
    expect(getTrack(0)?.title).toBe("updated");
    expect(getTrack(99)).toBeNull();
    expect(findTrackIndex("a")).toBe(2);
  });

  it("取消随机播放时恢复原顺序并返回当前歌曲索引", () => {
    queueEntries.value = [entry("a"), entry("b"), entry("c")];
    vi.spyOn(Math, "random").mockReturnValue(0);

    shuffleQueue(1);

    expect(queue.value[0].id).toBe("b");
    expect(originalQueue.value?.map((item) => item.track.id)).toEqual(["a", "b", "c"]);
    expect(unshuffleQueue("b")).toBe(1);
    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(originalQueue.value).toBeNull();
  });

  it("播放上下文跟随队列项插入、移动和随机播放", () => {
    setQueue([track("a"), track("b")], context);
    insertToQueue(track("c"), 1, { ...context, originId: "789", originType: "album" });
    moveInQueue(1, 2);
    vi.spyOn(Math, "random").mockReturnValue(0);
    shuffleQueue(0);

    expect(queueEntries.value.find((item) => item.track.id === "a")?.context).toEqual(context);
    expect(queueEntries.value.find((item) => item.track.id === "b")?.context).toEqual(context);
    expect(queueEntries.value.find((item) => item.track.id === "c")?.context).toEqual({
      ...context,
      originId: "789",
      originType: "album",
    });
  });

  it("队列中已有曲目时可替换播放上下文", () => {
    setQueue([track("a")], context);
    const nextContext: PlaybackContext = {
      provider: "qqmusic",
      originId: "789",
      originType: "album",
    };

    updateQueueItem(0, { ...track("a"), title: "updated" }, nextContext);

    expect(queueEntries.value[0]).toEqual({
      track: { ...track("a"), title: "updated" },
      context: nextContext,
    });
  });

  it("从持久化存储恢复队列和随机播放备份", async () => {
    storage.getItem
      .mockResolvedValueOnce([track("a"), track("b")])
      .mockResolvedValueOnce([track("b"), track("a")]);

    await restoreQueue();

    expect(queue.value.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(originalQueue.value?.map((item) => item.track.id)).toEqual(["b", "a"]);
  });

  it("恢复时将旧 Track 队列包装为队列项", async () => {
    storage.getItem
      .mockResolvedValueOnce([{ ...track("a"), source: "netease" }])
      .mockResolvedValueOnce(null);

    await restoreQueue();

    expect(queueEntries.value[0]).toEqual({
      track: { ...track("a"), source: "netease" },
    });
  });

  it("恢复时保留队列项的播放来源名称", async () => {
    storage.getItem.mockResolvedValueOnce([entry("a", context)]).mockResolvedValueOnce(null);

    await restoreQueue();

    expect(queueEntries.value[0]?.context).toEqual(context);
  });
});
