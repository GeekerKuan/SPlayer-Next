import { test } from "node:test";
import assert from "node:assert/strict";
import { CrossDeviceService } from "./crossDeviceService";
import { decodeRecentSongs } from "./netease-native/recentCodec";
import { mergePlayHistory } from "../../../../shared/utils/playHistory";
import type { NativeOperation, NativeTransport } from "./netease-native/transport";
import type { CrossDeviceSource } from "../../../../shared/types/crossDevice";

const song = (id: number) => ({
  id,
  name: `song-${id}`,
  dt: 60000,
  ar: [{ id: 10, name: "artist" }],
  al: { id: 20, name: "album" },
});
const rows = (id: number, time: number) => ({
  data: song(id),
  playTime: time,
  multiTerminalInfo: { os: "android" },
});
const fixture = (override?: NativeTransport["call"]) => {
  let token = "a",
    allowed = true,
    enabled = true;
  const calls: {
    operation: NativeOperation;
    data: Record<string, unknown>;
    signal: AbortSignal;
  }[] = [];
  const service = new CrossDeviceService({
    transport: {
      call: async (operation, data, signal) => {
        calls.push({ operation, data, signal });
        if (override) return override(operation, data, signal);
        if (operation === "account") return { code: 200, account: { id: token === "a" ? 1 : 2 } };
        if (operation === "recentSongs")
          return { code: 200, data: { list: [rows(3, 10), rows(3, 20), rows(4, 15)] } };
        if (operation === "relayConfig") return { code: 200, data: { enable: true } };
        if (operation === "relayPosition")
          return {
            code: 200,
            data: {
              commonResourceList: [
                { generalizedObject: { deviceId: "phone", sessionId: "session" } },
              ],
            },
          };
        if (operation === "relayPull")
          return {
            code: 200,
            data: {
              relayMode: "snapshot",
              playMode: "random",
              resources: [
                { id: 3, type: "song" },
                { id: 4, type: "song" },
              ],
              currentPlayState: { resourceId: 4, resourceType: "song", progress: 30000 },
            },
          };
        if (operation === "roomSongs") return { code: 200, songs: [song(4), song(3)] };
        return { code: 200 };
      },
    },
    token: () => token,
    enabled: () => enabled,
    playbackAllowed: () => allowed,
  });
  return {
    service,
    calls,
    account: () => {
      token = "b";
    },
    forbid: () => {
      allowed = false;
    },
    disable: () => {
      enabled = false;
      service.cancel();
    },
  };
};

test("native recent records use actual timestamps, tolerate malformed rows and merge local history once", () => {
  const records = decodeRecentSongs({
    data: { list: [rows(3, 20), rows(3, 10), rows(4, 15), { bad: true }] },
  });
  assert.deepEqual(
    records.map((item) => [item.track.id, item.playedAt, item.device]),
    [
      ["3", 20, "android"],
      ["4", 15, "android"],
    ],
  );
  const local = [
    { track: records[0].track, playedAt: 21 },
    { track: { ...records[0].track, source: "local" as const }, playedAt: 18 },
  ];
  const merged = mergePlayHistory(local, records, { "netease:4": 15 });
  assert.deepEqual(
    merged.map((item) => [item.track.source, item.playedAt]),
    [
      ["netease", 21],
      ["local", 18],
    ],
  );
  assert.equal(records.length, 2);
});

test("recent reads coalesce, cache is account-bound and disabling releases requests", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.refresh(), f.service.refresh()]);
  assert.equal(a, b);
  await f.service.refresh();
  assert.equal(f.calls.filter((item) => item.operation === "recentSongs").length, 1);
  const signal = f.calls[0].signal;
  f.account();
  assert.equal((await f.service.refresh()).accountId, "2");
  assert.equal(signal.aborted, true);
  f.disable();
  assert.equal(f.calls.at(-1)!.signal.aborted, true);
  await assert.rejects(f.service.refresh(), /disabled/);
});

test("a late read cannot repopulate a cancelled account cache", async () => {
  let release!: (value: Record<string, unknown>) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const f = fixture(async (op) => {
    if (op === "account") return { account: { id: 1 } };
    if (op === "recentSongs")
      return new Promise((resolve) => {
        release = resolve;
        began();
      });
    return { data: { enable: false } };
  });
  const pending = f.service.refresh();
  await started;
  f.service.cancel();
  release({ data: { list: [rows(3, 20)] } });
  await assert.rejects(pending, /abort/i);
});

test("resume uses only the server offer, preserves queue order and does not seek songs to remote progress", async () => {
  const f = fixture();
  await f.service.refresh();
  const result = await f.service.resume();
  assert.deepEqual(
    result.tracks.map((track) => track.id),
    ["3", "4"],
  );
  assert.equal(result.index, 1);
  assert.equal(result.playMode, "random");
  assert.equal("progress" in result, false);
  assert.deepEqual(f.calls.find((item) => item.operation === "relayPull")!.data, {
    deviceId: "phone",
    sessionId: "session",
    targetDeviceId: "phone",
  });
  await assert.rejects(f.service.resume(), /no-resume/);
  const room = fixture();
  await room.service.refresh();
  room.forbid();
  await assert.rejects(room.service.resume(), /already-in-room/);
  assert.equal(
    room.calls.some((call) => call.operation === "relayPull"),
    false,
  );
});

test("relay submission is event-driven, uses PC JSON envelopes and retains one session through song changes", async () => {
  const f = fixture();
  const source: CrossDeviceSource = { songIds: ["3", "4"], currentId: "3", playMode: "random" };
  await f.service.publish(source);
  await f.service.publish(source);
  await f.service.publish({ ...source, currentId: "4" });
  const submitSource = f.calls.filter((call) => call.operation === "relaySubmitSource");
  const submitState = f.calls.filter((call) => call.operation === "relaySubmitState");
  assert.equal(submitSource.length, 1);
  assert.equal(submitState.length, 2);
  const list = JSON.parse(String(submitSource[0].data.songListSubmitReq));
  assert.deepEqual(list.resources, [
    { id: "3", type: "song" },
    { id: "4", type: "song" },
  ]);
  assert.equal(list.playMode, "random");
  for (const call of submitState) {
    const state = JSON.parse(String(call.data.playStateSubmitReq));
    assert.equal(state.sessionId, list.sessionId);
    assert.equal(state.progress, 0);
  }
  f.forbid();
  await f.service.publish({ ...source, currentId: "3" });
  assert.equal(f.calls.filter((call) => call.operation === "relaySubmitState").length, 2);
});

test("a definitive missing relay source retransmits one bounded snapshot with a new session", async () => {
  const f = fixture(async (operation) => {
    if (operation === "relayConfig") return { data: { enable: true, snapshotSize: 2 } };
    if (operation === "relaySubmitState") throw new Error("api-10001");
    return { code: 200 };
  });
  const source: CrossDeviceSource = {
    songIds: ["3", "4", "5", "6"],
    currentId: "5",
    playMode: "order",
  };
  await f.service.publish(source);
  await f.service.publish(source);
  const lists = f.calls
    .filter((call) => call.operation === "relaySubmitSource")
    .map((call) => JSON.parse(String(call.data.songListSubmitReq)));
  assert.equal(lists.length, 2);
  assert.equal(lists[0].retransmit, false);
  assert.equal(lists[1].retransmit, true);
  assert.notEqual(lists[1].sessionId, lists[0].sessionId);
  assert.deepEqual(lists[1].resources, [
    { id: "4", type: "song" },
    { id: "5", type: "song" },
  ]);
  assert.equal(f.calls.filter((call) => call.operation === "relaySubmitState").length, 1);
});

test("unknown relay results and rejected retransmissions never loop", async () => {
  for (const message of ["operation-unknown", "api-10001"]) {
    const f = fixture(async (operation) => {
      if (operation === "relayConfig") return { data: { enable: true } };
      throw new Error(message);
    });
    await assert.rejects(
      f.service.publish({ songIds: ["3"], currentId: "3", playMode: "list_loop" }),
      new RegExp(message),
    );
    assert.equal(
      f.calls.filter((call) => call.operation === "relaySubmitSource").length,
      message === "api-10001" ? 2 : 1,
    );
  }
});
