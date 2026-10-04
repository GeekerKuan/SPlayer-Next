import { test, type TestContext } from "node:test";
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
  let createHook: (() => Promise<void> | void) | undefined;
  let haltHook: (() => void) | undefined;
  const playback = { songId: "10", playing: false, progressMs: 1000, ready: true, finished: false };
  let autoRecommend = true;
  let writeHook: ((operation: NativeOperation) => Promise<void> | void) | undefined;
  let recommendationHook: (() => Promise<void> | void) | undefined;
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
    autoRecommend: () => autoRecommend,
    halt: () => {
      halts++;
      haltHook?.();
    },
    playback: () => ({ ...playback }),
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
            await createHook?.();
            return { data: { roomInfo: info } };
          case "recommendations":
            await recommendationHook?.();
            return {
              data: { dailySongs: [{ id: 13, name: "recommended", dt: 60000, ar: [] }] },
            };
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
            await writeHook?.(operation);
            const sent = JSON.parse(String(data.commandInfo));
            Object.assign(command, sent, { serverSeq: ++serverSeq });
            return { data: { result: true } };
          }
          case "roomAdd":
            await writeHook?.(operation);
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
    playback,
    savedRooms,
    halts: () => halts,
    onHeartbeat: (hook: () => Promise<void> | void) => {
      heartbeatHook = hook;
    },
    onCreate: (hook: () => Promise<void> | void) => {
      createHook = hook;
    },
    onHalt: (hook: () => void) => {
      haltHook = hook;
    },
    onWrite: (hook: (operation: NativeOperation) => Promise<void> | void) => {
      writeHook = hook;
    },
    onRecommendations: (hook: () => Promise<void> | void) => {
      recommendationHook = hook;
    },
    setAutoRecommend: (value: boolean) => {
      autoRecommend = value;
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

/** 排空被测试轮询的微任务，不等待真实网络或创建额外生产定时器。 */
const tickRoom = async (t: TestContext, ms: number): Promise<void> => {
  t.mock.timers.tick(ms);
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const finishRoomSong = (f: ReturnType<typeof fixture>): void => {
  Object.assign(f.playback, { songId: f.command.targetSongId, ready: false, finished: true });
  const state = f.service.snapshot();
  f.service.notifyEnded({
    roomId: state.roomId,
    songId: state.songId,
    commandSeq: state.commandSeq!,
  });
};

test("host advances an existing queue once and rejects duplicate or stale end events", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    assert.equal(f.service.snapshot().awaitingNext, true);
    finishRoomSong(f);
    await tickRoom(t, 0);
    assert.equal(f.service.snapshot().songId, "11");
    assert.equal(f.service.snapshot().awaitingNext, false);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 0);
  } finally {
    f.service.stop();
  }
});

test("host appends one official recommendation at the tail and advances without replacing its queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    assert.deepEqual(
      f.service.snapshot().songs.map((song) => song.id),
      ["10", "11", "12"],
    );
    assert.equal(f.service.snapshot().songId, "12");
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    const next = JSON.parse(
      String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
    );
    assert.equal(next.commandType, "NEXT");
    assert.equal(next.targetSongId, "12");
    assert.equal(next.progress, 0);
  } finally {
    f.service.stop();
  }
});

test("exhausted room recommendations fall back to the acting account's daily recommendation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    f.playlist.displayList.rcmdSongIds = ["10", "11"];
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    assert.equal(f.service.snapshot().songId, "13");
    assert.equal(f.calls.filter((call) => call.operation === "recommendations").length, 1);
  } finally {
    f.service.stop();
  }
});

test("a member waits for the host, then continues the unchanged room without changing its creator", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.command.playStatus = "PLAY";
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 0);
    await tickRoom(t, 4000);
    assert.equal(f.service.snapshot().songId, "11");
    assert.equal(f.service.snapshot().status, "together");
    assert.equal(f.info.creatorId, "2");
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.ok(!f.calls.some((call) => ["roomCreate", "roomLeave"].includes(call.operation)));
  } finally {
    f.service.stop();
  }
});

test("a remote next command during the member grace period cancels local continuation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.command.playStatus = "PLAY";
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    Object.assign(f.command, { targetSongId: "11", serverSeq: 2, progress: 0 });
    await tickRoom(t, 4000);
    assert.equal(f.service.snapshot().songId, "11");
    assert.equal(f.service.snapshot().awaitingNext, false);
    assert.ok(!f.calls.some((call) => call.operation === "roomCommand"));
  } finally {
    f.service.stop();
  }
});

test("multiple members elect one continuation sender rather than all sending NEXT", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.command.playStatus = "PLAY";
    f.social.accountId = "5";
    f.info.roomUsers[0].userId = "5";
    f.info.roomUsers.push({
      userId: "3",
      nickname: "other",
      avatarUrl: "https://p1.music.126.net/other.jpg",
    });
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    await tickRoom(t, 6000);
    assert.equal(f.service.snapshot().awaitingNext, true);
    assert.ok(!f.calls.some((call) => call.operation === "roomCommand"));
  } finally {
    f.service.stop();
  }
});

test("single loop, heart, unknown modes and disabled auto-recommend preserve their queue policy", async (t) => {
  for (const mode of ["single", "heart", "future", "disabled"]) {
    await t.test(mode, async (sub) => {
      sub.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
      const f = fixture();
      try {
        f.setRoom();
        f.info.creatorId = "1";
        f.command.playStatus = "PLAY";
        f.command.targetSongId = "11";
        if (mode === "single") f.playlist.playMode = "SINGLE_LOOP";
        if (mode === "heart") f.playlist.listMode = "heart";
        if (mode === "future") f.playlist.listMode = "future-mode";
        if (mode === "disabled") f.setAutoRecommend(false);
        await f.service.takeOver("room-a");
        finishRoomSong(f);
        await tickRoom(sub, 0);
        assert.ok(
          !f.calls.some(
            (call) => call.operation === "roomAdd" || call.operation === "recommendations",
          ),
        );
        assert.equal(f.service.snapshot().songId, mode === "single" ? "11" : "10");
      } finally {
        f.service.stop();
      }
    });
  }
});

test("unknown ADD is not replayed; a later queue confirmation permits exactly one NEXT", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    f.onWrite((op) => {
      if (op === "roomAdd") throw new Error("operation-unknown");
    });
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    await tickRoom(t, 8000);
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    assert.ok(!f.calls.some((call) => call.operation === "roomCommand"));
    assert.equal(f.service.snapshot().error, "room-next-unconfirmed");
    f.playlist.displayList.result.push("12");
    await tickRoom(t, 2000);
    assert.equal(f.service.snapshot().songId, "12");
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
  } finally {
    f.service.stop();
  }
});

test("an uncertain NEXT is not replayed and manual control clears the waiting state", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.onWrite((op) => {
      if (op === "roomCommand") throw new Error("operation-unknown");
    });
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    await tickRoom(t, 8000);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    f.onWrite(() => {});
    await f.service.control({ action: "next" });
    assert.equal(f.service.snapshot().awaitingNext, false);
    assert.equal(f.service.snapshot().songId, "11");
  } finally {
    f.service.stop();
  }
});

test("recommendation read failure still advances the known ordinary room queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    f.playlist.displayList.rcmdSongIds = [];
    f.onRecommendations(() => {
      throw new Error("offline");
    });
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    assert.equal(f.service.snapshot().songId, "10");
    assert.equal(f.service.snapshot().connected, true);
    assert.ok(!f.calls.some((call) => call.operation === "roomAdd"));
  } finally {
    f.service.stop();
  }
});

test("stopping during recommendation retrieval drops the late candidate and releases continuation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    f.playlist.displayList.rcmdSongIds = [];
    f.onRecommendations(() => held);
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    f.service.stop();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.service.snapshot().awaitingNext, false);
    assert.ok(
      !f.calls.some((call) => call.operation === "roomAdd" || call.operation === "roomCommand"),
    );
  } finally {
    release();
    f.service.stop();
  }
});

test("manual NEXT while recommendation is pending cancels automatic ADD and advances once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.command.targetSongId = "11";
    f.playlist.displayList.rcmdSongIds = [];
    f.onRecommendations(() => held);
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    t.mock.timers.tick(1000);
    const manual = f.service.control({ action: "next" });
    release();
    await manual;
    assert.ok(!f.calls.some((call) => call.operation === "roomAdd"));
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.equal(f.service.snapshot().songId, "10");
  } finally {
    release();
    f.service.stop();
  }
});

test("manual NEXT during the automatic NEXT acknowledgement does not skip another song", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    f.onWrite((operation) => (operation === "roomCommand" ? held : undefined));
    await f.service.takeOver("room-a");
    finishRoomSong(f);
    await tickRoom(t, 0);
    t.mock.timers.tick(1000);
    const manual = f.service.control({ action: "next" });
    release();
    await manual;
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.equal(f.service.snapshot().songId, "11");
  } finally {
    release();
    f.service.stop();
  }
});

test("an unverified end event cannot trigger a room write", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.playStatus = "PLAY";
    await f.service.takeOver("room-a");
    const expected = { roomId: "room-a", songId: "10", commandSeq: 1 };
    f.service.notifyEnded(expected);
    f.playback.finished = true;
    f.service.notifyEnded({ ...expected, roomId: "room-b" });
    f.service.notifyEnded({ ...expected, commandSeq: 0 });
    assert.equal(f.service.snapshot().awaitingNext, false);
    await tickRoom(t, 6000);
    assert.ok(!f.calls.some((call) => call.operation === "roomCommand"));
  } finally {
    f.service.stop();
  }
});

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

test("only a newly created own room inherits the local song, progress and playing state before stop", async () => {
  const f = fixture();
  try {
    Object.assign(f.playback, { playing: true, progressMs: 31250 });
    f.onHalt(() => Object.assign(f.playback, { playing: false, progressMs: 0, ready: false }));
    const next = await f.service.create();
    const commands = f.calls.filter((call) => call.operation === "roomCommand");
    assert.equal(commands.length, 1);
    const initial = JSON.parse(String(commands[0].data.commandInfo));
    assert.equal(initial.commandType, "GOTO");
    assert.equal(initial.targetSongId, "10");
    assert.equal(initial.progress, 31250);
    assert.equal(initial.playStatus, "PLAY");
    const heart = f.calls.find((call) => call.operation === "roomHeartbeat")!;
    assert.equal(heart.data.roomId, "room-a");
    assert.equal(heart.data.playStatus, "PLAY");
    assert.ok(Number(heart.data.progress) >= 31250);
    assert.equal(next.songId, "10");
    assert.equal(next.playing, true);
    assert.ok(next.progressMs >= 31250);
    assert.ok(!f.calls.some((call) => call.operation === "recommendations"));
  } finally {
    f.service.stop();
  }
});

test("creating a room preserves a paused NetEase track's position", async () => {
  const f = fixture();
  try {
    f.playback.progressMs = 18750;
    const next = await f.service.create();
    assert.equal(next.playing, false);
    assert.equal(next.progressMs, 18750);
    const heart = f.calls.find((call) => call.operation === "roomHeartbeat")!;
    assert.equal(heart.data.progress, 18750);
    assert.equal(heart.data.playStatus, "PAUSE");
  } finally {
    f.service.stop();
  }
});

test("non-NetEase playback starts a recommended NetEase song without carrying its local position", async (t) => {
  for (const roomRecommendations of [true, false]) {
    await t.test(roomRecommendations ? "room candidate" : "daily candidate", async () => {
      const f = fixture();
      try {
        Object.assign(f.playback, { songId: "", playing: true, progressMs: 47000 });
        if (!roomRecommendations) f.playlist.displayList.rcmdSongIds = [];
        const next = await f.service.create();
        const initial = JSON.parse(
          String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
        );
        assert.equal(initial.targetSongId, roomRecommendations ? "12" : "13");
        assert.equal(initial.progress, 0);
        assert.equal(initial.playStatus, "PLAY");
        assert.equal(next.songId, roomRecommendations ? "12" : "13");
      } finally {
        f.service.stop();
      }
    });
  }
});

test("new-room seed clamps invalid or stale engine positions to a valid song range", async (t) => {
  for (const [position, expected] of [
    [NaN, 0],
    [-300, 0],
    [90000, 60000],
  ]) {
    await t.test(String(position), async () => {
      const f = fixture();
      try {
        f.playback.progressMs = position;
        await f.service.create();
        const initial = JSON.parse(
          String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
        );
        assert.equal(initial.progress, expected);
      } finally {
        f.service.stop();
      }
    });
  }
});

test("a create response for another owner never receives the local playback seed", async () => {
  const f = fixture();
  try {
    f.onCreate(() => {
      f.info.creatorId = "2";
    });
    await assert.rejects(f.service.create(), /account-mismatch/);
    assert.equal(f.halts(), 0);
    assert.ok(
      !f.calls.some((call) => ["roomAdd", "roomCommand", "roomHeartbeat"].includes(call.operation)),
    );
  } finally {
    f.service.stop();
  }
});

test("accepting an existing invitation never seeds a different local song or position", async () => {
  const f = fixture();
  try {
    Object.assign(f.playback, { songId: "13", playing: true, progressMs: 49000 });
    const next = await f.service.accept("2", "invite");
    assert.equal(next.songId, "10");
    assert.equal(next.progressMs, 1000);
    const heart = f.calls.find((call) => call.operation === "roomHeartbeat")!;
    assert.equal(heart.data.songId, "10");
    assert.equal(heart.data.progress, 1000);
    assert.equal(heart.data.playStatus, "PAUSE");
    assert.ok(!f.calls.some((call) => call.operation === "roomCommand"));
  } finally {
    f.service.stop();
  }
});

test("a stale NetEase label on a stopped engine uses recommendation instead of its residual position", async () => {
  const f = fixture();
  try {
    Object.assign(f.playback, { ready: false, progressMs: 41000 });
    const next = await f.service.create();
    assert.equal(next.songId, "12");
    const initial = JSON.parse(
      String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
    );
    assert.equal(initial.progress, 0);
  } finally {
    f.service.stop();
  }
});

test("a command while room audio is loading uses server position even with the same stale song label", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.command.progress = 17500;
    f.command.playStatus = "PLAY";
    f.onHalt(() => Object.assign(f.playback, { ready: false, playing: false, progressMs: 0 }));
    await f.service.takeOver("room-a");
    t.mock.timers.tick(1000);
    await f.service.control({ action: "pause" });
    const sent = JSON.parse(
      String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
    );
    assert.ok(sent.progress >= 17500);
    assert.equal(sent.playStatus, "PAUSE");
  } finally {
    f.service.stop();
  }
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
