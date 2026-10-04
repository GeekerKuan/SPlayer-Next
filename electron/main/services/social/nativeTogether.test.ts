import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeTogetherService } from "./nativeTogetherService";
import { emptySocialSnapshot } from "./service";
import type { NativeOperation } from "./netease-native/transport";
import {
  canLoadTogetherTrack,
  setNativeTogetherOwnership,
  setTogetherPlaybackLocked,
} from "./playbackOwnership";
import { roomPlaylistSchema } from "./netease-native/roomCodec";

const fixture = (resume?: { accountId: string; roomId: string; joinedAt: number }) => {
  let inRoom = false,
    serverSeq = 1;
  const calls: { operation: NativeOperation; data: Record<string, unknown> }[] = [];
  const info = {
    roomId: "room-a",
    creatorId: "2",
    effectiveDurationMs: 420000,
    roomUsers: [
      { userId: "1", nickname: "self", avatarUrl: "https://p1.music.126.net/self.jpg" },
      { userId: "2", nickname: "peer", avatarUrl: "https://p1.music.126.net/peer.jpg" },
    ],
  };
  const social = {
    ...emptySocialSnapshot(),
    accountId: "1",
    status: "online" as const,
    messages: {
      "2": [
        {
          id: "invite",
          peerId: "2",
          senderId: "2",
          time: Date.now(),
          kind: "invite" as const,
          text: "",
          delivery: "sent" as const,
          invite: { roomId: "room-a", inviterId: "2" },
        },
      ],
    },
  };
  const command = {
    targetSongId: "10",
    commandType: "PAUSE",
    playStatus: "PAUSE",
    progress: 1000,
    clientSeq: 0,
    serverSeq,
  };
  const playlist = {
    displayList: { result: ["10", "11"], rcmdSongIds: ["12"] },
    version: [
      { userId: 1, version: 3 },
      { userId: 2, version: 4 },
    ],
    playMode: "ORDER_LOOP",
    listMode: "",
  };
  let heartbeat = true;
  let heartbeatHook: (() => Promise<void> | void) | undefined;
  let halts = 0;
  const savedRooms: ({ accountId: string; roomId: string; joinedAt: number } | null)[] = [];
  let leaveOutcome: "success" | "unchanged" | "unknown" = "success";
  let holdStatus: Promise<void> | null = null;
  let shortUrl = "https://163cn.tv/testRoom";
  let shortFailure = false;
  const service = new NativeTogetherService({
    loadResume: async () => resume || null,
    saveResume: async (value) => {
      savedRooms.push(value);
    },
    account: async () => social,
    update: () => {},
    ownership: () => {},
    halt: () => {
      halts++;
    },
    playback: () => ({ songId: "10", playing: false, progressMs: 1000 }),
    transport: {
      call: async (operation, data) => {
        calls.push({ operation, data });
        switch (operation) {
          case "shortLink":
            if (shortFailure) throw new Error("operation-unknown");
            return { data: { shortUrl } };
          case "roomStatus":
            if (holdStatus) await holdStatus;
            return { data: { inRoom, roomInfo: inRoom ? info : null } };
          case "roomAccept":
            inRoom = true;
            return { data: { roomInfo: info } };
          case "roomPlaylist":
            return { data: { playlist, playCommand: command.targetSongId ? command : null } };
          case "roomCreate":
            inRoom = true;
            info.creatorId = "1";
            info.roomUsers = info.roomUsers.slice(0, 1);
            playlist.displayList.result = [];
            playlist.version = [];
            command.targetSongId = "";
            return { data: { roomInfo: info } };
          case "roomInvite":
            return { data: { result: true } };
          case "roomSongs":
            return {
              songs: [10, 11, 12, 13].map((id) => ({
                id,
                name: "song",
                dt: 60000,
                ar: [{ name: "artist" }],
              })),
            };
          case "roomHeartbeat":
            await heartbeatHook?.();
            return { data: { result: heartbeat } };
          case "roomCommand": {
            const sent = JSON.parse(String(data.commandInfo));
            Object.assign(command, sent, { serverSeq: ++serverSeq });
            return { data: { result: true } };
          }
          case "roomAdd":
            playlist.displayList.result.push(...JSON.parse(String(data.playlistParam)).displayList);
            return { data: { result: true } };
          case "roomLeave":
            if (leaveOutcome === "unknown") throw new Error("offline");
            if (leaveOutcome === "unchanged") return { data: { success: false } };
            inRoom = false;
            return { data: { success: true } };
          default:
            throw Error("unexpected-operation");
        }
      },
    },
  });
  return {
    service,
    calls,
    social,
    command,
    playlist,
    info,
    savedRooms,
    halts: () => halts,
    onHeartbeat: (hook: () => Promise<void> | void) => {
      heartbeatHook = hook;
    },
    failShort: () => {
      shortFailure = true;
    },
    setShort: (value: string) => {
      shortUrl = value;
    },
    setLeaveOutcome: (value: typeof leaveOutcome) => {
      leaveOutcome = value;
    },
    setRoom: () => {
      inRoom = true;
    },
    failHeartbeat: () => {
      heartbeat = false;
    },
    holdStatus: (promise: Promise<void> | null) => {
      holdStatus = promise;
    },
  };
};

test("independent accept verifies account and room, activates heartbeat without desktop actions", async () => {
  const f = fixture();
  const state = await f.service.accept("2", "invite");
  assert.equal(state.mode, "native");
  assert.equal(state.playbackOwned, true);
  assert.equal(state.members.length, 2);
  assert.equal(state.effectiveDurationMs, 420000);
  assert.equal(state.members[1].avatar, "https://p1.music.126.net/peer.jpg");
  const heart = f.calls.find((c) => c.operation === "roomHeartbeat")!;
  assert.equal(heart.data.progress, 1000);
  assert.equal(heart.data.playStatus, "PAUSE");
  assert.ok(f.calls.every((c) => !String(c.operation).includes("desktop")));
  f.service.stop();
});

test("verified room heart mode is read-only and unknown modes do not disrupt playback", async () => {
  const f = fixture();
  f.setRoom();
  f.playlist.listMode = "heart";
  assert.equal((await f.service.connect()).recommendationMode, "heart");
  f.playlist.listMode = "future-mode";
  const next = await f.service.connect();
  assert.equal(next.connected, true);
  assert.equal(next.recommendationMode, undefined);
  assert.deepEqual(
    next.songs.map((song) => song.id),
    ["10", "11"],
  );
  assert.ok(
    f.calls.every((call) => ["roomStatus", "roomPlaylist", "roomSongs"].includes(call.operation)),
  );
  f.service.stop();
  assert.equal(f.service.snapshot().recommendationMode, undefined);
});

test("independent host initializes an empty room and sends one native invite after heartbeat", async () => {
  const f = fixture();
  const state = await f.service.create("2");
  assert.equal(state.playbackOwned, true);
  assert.equal(state.status, "waiting");
  assert.deepEqual(
    state.songs.map((s) => s.id),
    ["10"],
  );
  assert.equal(f.calls.filter((c) => c.operation === "roomInvite").length, 1);
  assert.ok(
    f.calls.findIndex((c) => c.operation === "roomHeartbeat") <
      f.calls.findIndex((c) => c.operation === "roomInvite"),
  );
  assert.equal(f.calls.find((c) => c.operation === "roomInvite")?.data.acceptorId, "2");
  f.service.stop();
});

test("leave validates remote room state instead of assuming the heartbeat result schema", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  await f.service.accept("2", "invite");
  t.mock.timers.tick(1000);
  const state = await f.service.leave();
  assert.equal(state.roomId, "");
  assert.equal(state.playbackOwned, false);
  assert.equal(f.calls.filter((c) => c.operation === "roomLeave").length, 1);
  f.service.stop();
});

test("a guest cannot send host invitations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  await f.service.accept("2", "invite");
  t.mock.timers.tick(1000);
  await assert.rejects(f.service.invite("3"), /room-invite-owner-only/);
  assert.equal(f.calls.filter((c) => c.operation === "roomInvite").length, 0);
  f.service.stop();
});
test("read-only existing room cannot send playback commands or adopt ownership", async () => {
  const f = fixture();
  f.setRoom();
  const state = await f.service.connect();
  assert.equal(state.playbackOwned, false);
  await assert.rejects(f.service.control({ action: "resume" }), /room-not-owned/);
  assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 0);
  f.service.stop();
});

for (const owner of [false, true]) {
  test(`adopting another device's ${owner ? "host" : "guest"} room preserves server playback before local ownership`, async () => {
    const f = fixture();
    try {
      f.setRoom();
      if (owner) f.info.creatorId = "1";
      f.command.playStatus = "PLAY";
      f.command.progress = 17500;
      await f.service.connect();
      f.onHeartbeat(() => {
        assert.equal(f.halts(), 0);
        assert.equal(f.service.snapshot().playbackOwned, false);
        assert.deepEqual(f.savedRooms, []);
      });
      const next = await f.service.takeOver("room-a");
      assert.equal(next.playbackOwned, true);
      assert.equal(next.status, owner ? "togetherOwner" : "together");
      assert.deepEqual(
        next.songs.map((song) => song.id),
        ["10", "11"],
      );
      assert.equal(next.songId, "10");
      assert.equal(next.playing, true);
      const heartbeats = f.calls.filter((call) => call.operation === "roomHeartbeat");
      assert.equal(heartbeats.length, 1);
      assert.equal(heartbeats[0].data.playStatus, "PLAY");
      assert.ok(Number(heartbeats[0].data.progress) >= 17500);
      assert.equal(f.halts(), 1);
      assert.equal(f.savedRooms[0]?.roomId, "room-a");
      assert.ok(
        f.calls.every(
          (call) =>
            ![
              "roomCreate",
              "roomAccept",
              "roomLeave",
              "roomCommand",
              "roomAdd",
              "roomInvite",
            ].includes(call.operation),
        ),
      );
    } finally {
      f.service.stop();
    }
  });
}

test("rejected takeover heartbeat never claims playback or records a successful adoption", async () => {
  const f = fixture();
  try {
    f.setRoom();
    await f.service.connect();
    f.failHeartbeat();
    await assert.rejects(f.service.takeOver("room-a"), /room-expired/);
    assert.equal(f.service.snapshot().playbackOwned, false);
    assert.equal(f.halts(), 0);
    assert.ok(f.savedRooms.every((value) => value === null));
    assert.equal(f.calls.filter((call) => call.operation === "roomHeartbeat").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "roomLeave").length, 0);
  } finally {
    f.service.stop();
  }
});

test("a room changed during takeover confirmation is not claimed or stopped", async () => {
  const f = fixture();
  try {
    f.setRoom();
    await f.service.connect();
    f.onHeartbeat(() => {
      f.info.roomId = "room-b";
    });
    await assert.rejects(f.service.takeOver("room-a"), /room-changed/);
    assert.equal(f.service.snapshot().playbackOwned, false);
    assert.equal(f.halts(), 0);
    assert.deepEqual(f.savedRooms, []);
  } finally {
    f.service.stop();
  }
});

test("stopping during takeover confirmation cancels the late response before claiming playback", async () => {
  const f = fixture();
  f.setRoom();
  await f.service.connect();
  let finish!: () => void;
  f.onHeartbeat(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.takeOver("room-a");
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.service.stop();
  finish();
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.service.snapshot().playbackOwned, false);
  assert.equal(f.halts(), 0);
  assert.deepEqual(f.savedRooms, []);
});

test("an existing empty room can be adopted without inventing song or playback commands", async () => {
  const f = fixture();
  try {
    f.setRoom();
    f.command.targetSongId = "";
    f.playlist.displayList.result = [];
    await f.service.connect();
    const next = await f.service.takeOver("room-a");
    assert.equal(next.playbackOwned, true);
    assert.equal(next.songId, "");
    assert.deepEqual(next.songs, []);
    assert.ok(
      f.calls.every((call) => ["roomStatus", "roomPlaylist", "roomSongs"].includes(call.operation)),
    );
  } finally {
    f.service.stop();
  }
});

test("cold restore requires the same account and verified room without replaying invitations", async () => {
  for (const stamp of [
    { accountId: "1", roomId: "room-a", joinedAt: Date.now() },
    { accountId: "2", roomId: "room-a", joinedAt: Date.now() },
    { accountId: "1", roomId: "other-room", joinedAt: Date.now() },
  ]) {
    const f = fixture(stamp);
    f.setRoom();
    const state = await f.service.connect();
    const matches = stamp.accountId === "1" && stamp.roomId === "room-a";
    assert.equal(state.playbackOwned, matches);
    assert.equal(f.calls.filter((c) => c.operation === "roomHeartbeat").length, matches ? 1 : 0);
    assert.ok(
      f.calls.every((c) => !["roomCreate", "roomAccept", "roomInvite"].includes(c.operation)),
    );
    f.service.stop();
  }
});
test("adding a recommendation increments only self version and uses native playlistParam", async () => {
  const f = fixture();
  await f.service.accept("2", "invite");
  await new Promise((r) => setTimeout(r, 510));
  await f.service.add("12");
  const add = f.calls.find((c) => c.operation === "roomAdd")!;
  assert.equal(add.data.commandInfo, undefined);
  const payload = JSON.parse(String(add.data.playlistParam));
  assert.deepEqual(payload.version, [
    { userId: 1, version: 4 },
    { userId: 2, version: 4 },
  ]);
  assert.deepEqual(payload.displayList, ["12"]);
  assert.equal(payload.commandType, "ADD");
  f.service.stop();
});
test("adds a new official song outside room recommendations without replacing the queue", async () => {
  const f = fixture();
  await f.service.accept("2", "invite");
  await new Promise((resolve) => setTimeout(resolve, 510));
  const next = await f.service.add("13");
  assert.deepEqual(
    next.songs.map((song) => song.id),
    ["10", "11", "13"],
  );
  const addition = f.calls.find((call) => call.operation === "roomAdd")!;
  const param = JSON.parse(String(addition.data.playlistParam));
  assert.deepEqual(param.displayList, ["13"]);
  assert.equal(param.commandType, "ADD");
  assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
  f.service.stop();
});
test("missing official song details never generate a room write", async () => {
  const f = fixture();
  await f.service.accept("2", "invite");
  await new Promise((resolve) => setTimeout(resolve, 510));
  await assert.rejects(f.service.add("999"), /invalid-song/);
  assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 0);
  f.service.stop();
});
test("expired invitation and negative heartbeat do not report successful join", async () => {
  const f = fixture();
  f.social.messages["2"][0].time = Date.now() - 700000;
  await assert.rejects(f.service.accept("2", "invite"), /invitation-expired/);
  assert.equal(f.calls.length, 0);
  f.social.messages["2"][0].time = Date.now();
  f.failHeartbeat();
  await assert.rejects(f.service.accept("2", "invite"), /room-expired/);
  f.service.stop();
});
test("main playback gate rejects local, plugin CDN and obsolete room songs", () => {
  const track = {
    id: "10",
    source: "netease" as const,
    title: "song",
    artists: [],
    duration: 60000,
  };
  setNativeTogetherOwnership("room-a", "10");
  assert.equal(canLoadTogetherTrack(track, "https://m8.music.126.net/audio.flac"), true);
  assert.equal(canLoadTogetherTrack({ ...track, source: "local" }, "C:/song.flac"), false);
  assert.equal(canLoadTogetherTrack(track, "https://plugin.example/song.flac"), false);
  assert.equal(
    canLoadTogetherTrack({ ...track, id: "11" }, "https://m8.music.126.net/audio.flac"),
    false,
  );
  setTogetherPlaybackLocked(true);
  assert.equal(canLoadTogetherTrack(track, "https://m8.music.126.net/audio.flac"), false);
  setTogetherPlaybackLocked(false);
  setNativeTogetherOwnership("", "");
});
test("front control waits for in-flight polling instead of rejecting an unrelated refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = fixture();
  await f.service.accept("2", "invite");
  let finish!: () => void;
  f.holdStatus(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  t.mock.timers.tick(2000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const control = f.service.control({ action: "resume" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 0);
  f.holdStatus(null);
  finish();
  assert.equal((await control).playing, true);
  f.service.stop();
});
test("stopping during room reads drops the late response and releases ownership", async () => {
  const f = fixture();
  let finish!: () => void;
  f.holdStatus(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const connection = f.service.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.service.stop();
  finish();
  await assert.rejects(connection, /cancelled/);
  assert.equal(f.service.snapshot().connected, false);
  assert.equal(f.service.snapshot().playbackOwned, false);
});
test("newly created room may have a null playlist before the first ADD command", () => {
  const response = roomPlaylistSchema.parse({ data: { playlist: null, playCommand: null } });
  assert.deepEqual(response.data.playlist.displayList.result, []);
  assert.equal(response.data.playlist.playMode, "ORDER_LOOP");
  const empty = roomPlaylistSchema.parse({ data: {} });
  assert.deepEqual(empty.data.playlist.version, []);
  assert.equal(
    roomPlaylistSchema.parse({
      data: { playlist: { ...response.data.playlist, randomList: null } },
    }).data.playlist.randomList,
    null,
  );
});

test("replacing an external room verifies leaving before creating exactly one new room", async () => {
  const f = fixture();
  try {
    f.setRoom();
    await f.service.connect();
    const next = await f.service.replace("room-a");
    assert.equal(next.playbackOwned, true);
    assert.equal(next.status, "waiting");
    const operations = f.calls.map((call) => call.operation);
    assert.equal(operations.filter((op) => op === "roomLeave").length, 1);
    assert.equal(operations.filter((op) => op === "roomCreate").length, 1);
    assert.ok(operations.indexOf("roomLeave") < operations.indexOf("roomCreate"));
    assert.equal(operations.includes("roomInvite"), false);
  } finally {
    f.service.stop();
  }
});

test("changed rooms and uncertain exit results cannot trigger automatic room creation", async () => {
  for (const outcome of ["changed", "unchanged", "unknown"] as const) {
    const f = fixture();
    try {
      f.setRoom();
      await f.service.connect();
      if (outcome === "changed") f.info.roomId = "room-b";
      else f.setLeaveOutcome(outcome);
      await assert.rejects(
        f.service.replace("room-a"),
        outcome === "changed"
          ? /room-changed/
          : outcome === "unknown"
            ? /offline/
            : /room-operation-failed/,
      );
      assert.equal(f.calls.filter((call) => call.operation === "roomCreate").length, 0);
      assert.equal(
        f.calls.filter((call) => call.operation === "roomLeave").length,
        outcome === "changed" ? 0 : 1,
      );
    } finally {
      f.service.stop();
    }
  }
});

test("host invitations accept arbitrary peer IDs and the copied link contains only room identifiers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.create("3456");
    assert.equal(await f.service.invitationLink(), "https://163cn.tv/testRoom");
    f.failShort();
    const link = new URL(await f.service.invitationLink());
    assert.equal(link.protocol, "https:");
    assert.equal(link.hostname, "st.music.163.com");
    assert.equal(link.pathname, "/listen-together/share/");
    assert.deepEqual(
      [...link.searchParams],
      [
        ["roomId", "room-a"],
        ["inviterId", "1"],
        ["songId", "10"],
      ],
    );
    assert.equal(f.calls.find((call) => call.operation === "roomInvite")?.data.acceptorId, "3456");
    t.mock.timers.tick(1000);
    await assert.rejects(f.service.replace("room-a"), /already-in-room/);
    assert.equal(f.calls.filter((call) => call.operation === "roomLeave").length, 0);
  } finally {
    f.service.stop();
  }
});

test("an unexpected short-link domain falls back to the official room URL", async () => {
  const f = fixture();
  try {
    await f.service.create();
    f.setShort("https://untrusted.example/room");
    const link = new URL(await f.service.invitationLink());
    assert.equal(link.hostname, "st.music.163.com");
    assert.equal(link.searchParams.get("roomId"), "room-a");
    assert.equal(f.calls.filter((call) => call.operation === "shortLink").length, 1);
  } finally {
    f.service.stop();
  }
});
