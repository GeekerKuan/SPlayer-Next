import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { desktopActionExpression, decodeRecommendations } from "./netease-native/desktopActions";
import { SocialNotificationPolicy } from "./notificationPolicy";
import { emptySocialSnapshot } from "./service";
import { createTogetherStats } from "./togetherStats";
import { emptyTogetherSnapshot, TogetherService } from "./togetherService";
import { connectDesktopCdp } from "./netease-native/desktopCdp";
import type { PlayEventInput } from "@shared/types/stats";

const desktopFixture = () => {
  const calls: { type: string; payload: Record<string, unknown> }[] = [];
  const state = {
    host: { uid: "1", isAnonymous: false },
    "async:listenTogether": { status: "together", roomInfo: { roomId: "room-a" }, roomMembers: [] },
    "async:listenTogetherPlayList": { displayTrackIds: ["10"] },
    "async:listenTogetherPlayStatus": { lastestStatus: { progress: 500, playStatus: "PAUSE" } },
    playing: { playingState: 1, curPlaying: { resourceId: "10" } },
    playingList: {
      curPlayingList: [
        {
          resourceId: "10",
          track: { name: "song", artists: [{ name: "artist" }], duration: 30000 },
        },
      ],
    },
  };
  const store = {
    getState: () => state,
    dispatch: (action: (typeof calls)[number]) => calls.push(action),
  };
  const document = {
    scripts: [{ src: "orpheus://orpheus/pub/app.chunk.d4d4312.js" }],
    querySelector: () => ({ __reactFiber: { memoizedProps: { value: { store } } } }),
  };
  const evaluate = (input: Record<string, unknown>) =>
    runInNewContext(desktopActionExpression({ accountId: "1", ...input }), { document, Date });
  return { calls, state, document, evaluate };
};
test("desktop commands cannot cross accounts, rooms or unverified builds", () => {
  const fixture = desktopFixture();
  assert.equal(fixture.evaluate({ action: "pause", accountId: "2" }).error, "account-mismatch");
  assert.equal(fixture.evaluate({ action: "pause", expectedRoom: "room-b" }).error, "room-changed");
  fixture.document.scripts[0].src = "orpheus://orpheus/pub/app.chunk.newbuild.js";
  assert.equal(fixture.evaluate({ action: "pause" }).error, "unsupported-build");
  assert.equal(fixture.calls.length, 0);
});
test("seek uses milliseconds at the bridge and seconds only at native action boundary", () => {
  const fixture = desktopFixture();
  fixture.evaluate({ action: "seek", expectedRoom: "room-a", positionMs: 12345 });
  assert.equal(fixture.calls[0].type, "playing/setPlayingPosition");
  assert.equal(fixture.calls[0].payload.duration, 12.345);
  assert.equal(fixture.calls[1].payload.position, 12.345);
});
test("recommendations are lightweight unique NetEase candidates and do not dispatch queue changes", () => {
  const song = { id: 10, name: "one", dt: 30000, ar: [{ name: "artist" }] };
  const result = decodeRecommendations({
    data: { dailySongs: [song, song, { id: "qq:10", name: "wrong", dt: 30, ar: [] }] },
  });
  assert.equal(result.length, 1);
  assert.deepEqual(Object.keys(result[0]).sort(), ["artists", "durationMs", "id", "name"]);
  const fixture = desktopFixture();
  assert.equal(
    fixture.evaluate({ action: "add", songId: "10", expectedRoom: "room-a" }).error,
    "already-in-queue",
  );
  assert.equal(fixture.calls.length, 0);
});
test("notifications suppress initial backlog, repeated updates, own invitations and account switches", () => {
  const policy = new SocialNotificationPolicy();
  const now = Date.now();
  const state = {
    ...emptySocialSnapshot(),
    accountId: "1",
    status: "online" as const,
    updatedAt: now,
    conversations: [
      { peerId: "2", name: "peer", avatar: "", preview: "", updatedAt: now - 1000, unread: 1 },
    ],
  };
  assert.equal(policy.consume(state).length, 0);
  const updated = {
    ...state,
    updatedAt: now + 1000,
    conversations: [{ ...state.conversations[0], updatedAt: now + 500 }],
  };
  assert.equal(policy.consume(updated).length, 1);
  assert.equal(policy.consume(updated).length, 0);
  assert.equal(policy.consume({ ...updated, accountId: "3" }).length, 0);
  assert.equal(
    policy.consume({
      ...updated,
      accountId: "3",
      conversations: [
        {
          ...updated.conversations[0],
          updatedAt: now + 700,
          content: { kind: "invite", text: "", invite: { roomId: "a", inviterId: "3" } },
        },
      ],
    }).length,
    0,
  );
});
test("room listening time reuses host accounting, excludes paused time and seek jumps", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const records: PlayEventInput[] = [];
  const stats = createTogetherStats((record) => records.push(record));
  const snapshot = {
    ...emptyTogetherSnapshot(),
    connected: true,
    status: "together" as const,
    roomId: "a",
    songId: "10",
    playing: true,
    songs: [{ id: "10", name: "song", artists: "artist", durationMs: 100000 }],
  };
  stats.observe(snapshot);
  context.mock.timers.tick(4000);
  stats.observe({ ...snapshot, progressMs: 80000 });
  context.mock.timers.tick(2000);
  stats.observe({ ...snapshot, playing: false });
  context.mock.timers.tick(3000);
  stats.stop();
  assert.equal(records.length, 1);
  assert.equal(records[0].listenedMs, 6000);
  assert.equal(records[0].track.source, "netease");
});

test("stopping during account resolution does not open a late CDP connection", async () => {
  let resolve!: (value: ReturnType<typeof emptySocialSnapshot>) => void;
  let connections = 0;
  const account = new Promise<ReturnType<typeof emptySocialSnapshot>>((done) => {
    resolve = done;
  });
  const service = new TogetherService({
    account: () => account,
    executable: () => "cloudmusic.exe",
    visible: () => false,
    update: () => {},
    pauseLocal: () => {},
    transport: { call: async () => ({}) },
    connect: async () => {
      connections++;
      throw new Error("unexpected");
    },
  });
  const pending = service.connect();
  service.stop();
  resolve({ ...emptySocialSnapshot(), accountId: "1", status: "online" });
  await assert.rejects(pending, /cancelled/);
  assert.equal(connections, 0);
});

test("native mutation timeout is returned once and never re-dispatched", async () => {
  let requests = 0;
  const connector = (async () => ({
    metadata: { recognized: true, build: "d4d4312", storeFound: true, models: {} },
    cdp: {
      close: () => {},
      request: async () => {
        requests++;
        if (requests === 1)
          return {
            result: {
              value: {
                ...emptyTogetherSnapshot(),
                connected: true,
                status: "together",
                roomId: "a",
              },
            },
          };
        throw new Error("cdp-timeout");
      },
    },
  })) as unknown as typeof connectDesktopCdp;
  const service = new TogetherService({
    account: async () => ({ ...emptySocialSnapshot(), accountId: "1", status: "online" }),
    executable: () => "cloudmusic.exe",
    visible: () => false,
    update: () => {},
    pauseLocal: () => {},
    transport: { call: async () => ({}) },
    connect: connector,
  });
  await service.connect();
  await assert.rejects(service.control({ action: "next" }), /cdp-timeout/);
  assert.equal(requests, 2);
  service.stop();
});

test("late desktop response after stop cannot overwrite the cleared session", async () => {
  let resolve!: (value: Record<string, unknown>) => void;
  const connector = (async () => ({
    metadata: {},
    cdp: {
      close: () => {},
      request: () =>
        new Promise<Record<string, unknown>>((done) => {
          resolve = done;
        }),
    },
  })) as unknown as typeof connectDesktopCdp;
  const service = new TogetherService({
    account: async () => ({ ...emptySocialSnapshot(), accountId: "1", status: "online" }),
    executable: () => "cloudmusic.exe",
    visible: () => false,
    update: () => {
      throw new Error("stale-update");
    },
    pauseLocal: () => {},
    transport: { call: async () => ({}) },
    connect: connector,
  });
  const pending = service.connect();
  await new Promise<void>((done) => setImmediate(done));
  service.stop();
  resolve({
    result: {
      value: { ...emptyTogetherSnapshot(), connected: true, status: "together", roomId: "a" },
    },
  });
  await assert.rejects(pending, /cancelled/);
});
