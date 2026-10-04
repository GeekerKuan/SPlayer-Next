import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import persistedState from "pinia-plugin-persistedstate";
import { beforeEach, expect, it, vi } from "vitest";
import { useStatusStore } from "./status";
import * as queue from "./queue";

vi.mock("localforage", () => ({
  default: { createInstance: () => ({ setItem: async () => undefined }) },
}));

beforeEach(() => {
  queue.restoreTemporaryQueue();
  localStorage.clear();
  const pinia = createPinia().use(persistedState);
  createApp({}).use(pinia);
  setActivePinia(pinia);
});

it("房间播放期间持久化原队列的索引、位置和模式，音量等普通偏好仍正常保存", async () => {
  const status = useStatusStore();
  status.$patch({
    playIndex: 1,
    position: 32000,
    repeatMode: "one",
    shuffleMode: "on",
    heartMode: true,
  });
  const previous: queue.TemporaryPlaybackState = {
    playIndex: 1,
    position: 32000,
    duration: 60000,
    repeatMode: "one",
    shuffleMode: "on",
    heartMode: true,
    fmMode: false,
  };
  queue.prepareTemporaryPlayback(previous);
  status.$patch({ position: 0 });
  expect(JSON.parse(localStorage.getItem("status")!).position).toBe(32000);
  queue.setTemporaryQueue(
    [],
    { provider: "netease", originType: "page", originId: "test-room" },
    previous,
  );
  status.$patch({
    playIndex: 9,
    position: 18000,
    repeatMode: "list",
    shuffleMode: "off",
    heartMode: false,
    volume: 0.5,
  });
  const saved = JSON.parse(localStorage.getItem("status")!);
  expect(saved).toMatchObject({
    playIndex: 1,
    position: 32000,
    repeatMode: "one",
    shuffleMode: "on",
    heartMode: true,
    volume: 0.5,
  });
  expect(saved.duration).toBeUndefined();
  expect(saved.fmMode).toBeUndefined();
  queue.restoreTemporaryQueue();
  status.$patch({ playIndex: 0, position: 200 });
  expect(JSON.parse(localStorage.getItem("status")!)).toMatchObject({
    playIndex: 0,
    position: 200,
  });
});
