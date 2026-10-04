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
    openHeartRcmd: false,
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
  let queueResponse: Record<string, unknown> = { data: { result: true } };
  let heartResponse: Record<string, unknown> = { data: { success: true, refreshPlaylist: true } };
  let heartbeat = true;
  let heartbeatHook: (() => Promise<void> | void) | undefined;
  let createHook: (() => Promise<void> | void) | undefined;
  let haltHook: (() => void) | undefined;
  const playback = { songId: "10", playing: false, progressMs: 1000, ready: true, finished: false };
  let autoRecommend = true;
  let songSource: "recommended" | "room" | "history" = "room";
  const updates: import("@shared/types/together").TogetherSnapshot[] = [];
  let writeHook: ((operation: NativeOperation) => Promise<void> | void) | undefined;
  let playlistHook: (() => Record<string, unknown> | undefined) | undefined;
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
    update: (snapshot) => {
      updates.push(snapshot);
    },
    songSource: () => songSource,
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
          case "userFollows":
            return {
              follow: [
                { userId: 2, nickname: "friend", mutual: true },
                { userId: 1, nickname: "self" },
              ],
              more: true,
            };
          case "userFollowers":
            return { followeds: [{ userId: 3, nickname: "follower" }], more: false };
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
            return (
              playlistHook?.() ?? {
                data: { playlist, playCommand: command.targetSongId ? command : null },
              }
            );
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
          case "roomHeart":
            await writeHook?.(operation);
            if ((heartResponse.data as { success?: unknown }).success === true) {
              info.openHeartRcmd = data.status === 1;
              playlist.displayList.result = info.openHeartRcmd ? ["10", "12"] : ["10", "11"];
            }
            return heartResponse;
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
            serverSeq = Math.max(serverSeq, command.serverSeq) + 1;
            Object.assign(command, sent, { serverSeq });
            return { data: { result: true } };
          }
          case "roomAdd": {
            await writeHook?.(operation);
            const sent = JSON.parse(String(data.playlistParam));
            if (sent.commandType === "DELETE")
              playlist.displayList.result = playlist.displayList.result.filter(
                (id) => !sent.displayList.includes(id),
              );
            else if (sent.commandType === "REPLACE") playlist.displayList.result = sent.displayList;
            else playlist.displayList.result.push(...sent.displayList);
            playlist.version = sent.version;
            return queueResponse;
          }
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
    onPlaylist: (hook: () => Record<string, unknown> | undefined) => {
      playlistHook = hook;
    },
    onRecommendations: (hook: () => Promise<void> | void) => {
      recommendationHook = hook;
    },
    updates,
    setQueueResponse: (body: Record<string, unknown>) => {
      queueResponse = body;
    },
    setHeartResponse: (body: Record<string, unknown>) => {
      heartResponse = body;
    },
    setSongSource: (value: typeof songSource) => {
      songSource = value;
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
    await tickRoom(t, 300);
    await tickRoom(t, 900);
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

test("manual NEXT takes over a pending recommendation and advances once without a competing automatic write", async (t) => {
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
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
    assert.equal(f.service.snapshot().songId, "13");
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

test("manual ADD refreshes remote versions and tolerates a delayed playlist echo without repeating writes", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    f.playlist.version[1].version = 8;
    let written = false;
    let reads = 0;
    f.onWrite((op) => {
      if (op === "roomAdd") written = true;
    });
    f.onPlaylist(() => {
      if (written && reads++ === 0)
        return {
          data: {
            playlist: {
              ...f.playlist,
              displayList: { ...f.playlist.displayList, result: ["10", "11"] },
            },
            playCommand: f.command,
          },
        };
      return undefined;
    });
    now += 1000;
    const next = await f.service.add("13");
    assert.ok(next.songs.some((song) => song.id === "13"));
    const writes = f.calls.filter((call) => call.operation === "roomAdd");
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(String(writes[0].data.playlistParam)).version[1].version, 8);
  } finally {
    f.service.stop();
  }
});

test("unknown ADD confirmed by the room succeeds once, while cancellation clears its confirmation wait", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    now += 1000;
    f.onWrite((op) => {
      if (op === "roomAdd") {
        f.playlist.displayList.result.push("13");
        throw new Error("operation-unknown");
      }
    });
    const next = await f.service.add("13");
    assert.ok(next.songs.some((song) => song.id === "13"));
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    now += 1000;
    f.onWrite((op) => {
      if (op === "roomAdd") throw new Error("operation-unknown");
    });
    let didRead!: () => void;
    const observed = new Promise<void>((resolve) => {
      didRead = resolve;
    });
    f.onPlaylist(() => {
      if (f.calls.filter((call) => call.operation === "roomAdd").length > 1) didRead();
      return undefined;
    });
    const pending = f.service.add("12");
    const rejected = assert.rejects(pending, /Abort|cancelled/);
    await observed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.service.stop();
    await rejected;
  } finally {
    f.service.stop();
  }
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

test("playlist addition deduplicates into one incremental ADD without blocking on confirmation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    f.calls.length = 0;
    const next = await f.service.addMany(["10", "12", "12", "13"]);
    assert.deepEqual(
      next.songs.map((song) => song.id),
      ["10", "11", "12", "13"],
    );
    const writes = f.calls.filter((call) => call.operation === "roomAdd");
    assert.equal(writes.length, 1);
    const data = JSON.parse(String(writes[0].data.playlistParam));
    assert.deepEqual(data.displayList, ["12", "13"]);
    assert.deepEqual(data.randomList, ["12", "13"]);
    assert.equal(data.version[0].version, 4);
    assert.equal(f.calls.filter((call) => call.operation === "roomStatus").length, 1);
    assert.ok(f.calls.filter((call) => call.operation === "roomSongs").length <= 1);
  } finally {
    f.service.stop();
  }
});
test("batch capacity and unverified songs fail without partial writes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  for (const full of [false, true]) {
    const f = fixture();
    try {
      await f.service.accept("2", "invite");
      t.mock.timers.tick(1000);
      if (full)
        f.playlist.displayList.result = Array.from({ length: 500 }, (_, i) => String(i + 100));
      f.calls.length = 0;
      await assert.rejects(
        f.service.addMany(full ? ["12", "13"] : ["999"]),
        full ? /queue-full/ : /invalid-song/,
      );
      assert.equal(
        f.calls.some((call) => call.operation === "roomAdd"),
        false,
      );
    } finally {
      f.service.stop();
    }
  }
});
test("personal fallback recommendations share concurrent reads and expire within the same room", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const f = fixture();
  try {
    const [first, second] = await Promise.all([
      f.service.recommendations(),
      f.service.recommendations(),
    ]);
    assert.deepEqual(first, second);
    first[0].name = "mutated";
    assert.notEqual((await f.service.recommendations())[0].name, "mutated");
    assert.equal(f.calls.filter((call) => call.operation === "recommendations").length, 1);
    t.mock.timers.tick(60000);
    await f.service.recommendations();
    assert.equal(f.calls.filter((call) => call.operation === "recommendations").length, 2);
  } finally {
    f.service.stop();
  }
});

test("host appends once while the last track is playing, then next uses the appended track", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    Object.assign(f.command, { targetSongId: "11", playStatus: "PLAY" });
    Object.assign(f.playback, { songId: "11", playing: true });
    await f.service.takeOver("room-a");
    await tickRoom(t, 2000);
    assert.deepEqual(
      f.service.snapshot().songs.map((song) => song.id),
      ["10", "11", "12"],
    );
    assert.equal(f.service.snapshot().songId, "11");
    await tickRoom(t, 2000);
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    await f.service.control({ action: "next" });
    assert.equal(f.service.snapshot().songId, "12");
    const sent = JSON.parse(
      String(f.calls.find((call) => call.operation === "roomCommand")!.data.commandInfo),
    );
    assert.equal(sent.commandType, "NEXT");
  } finally {
    f.service.stop();
  }
});

test("manual next at a paused tail adds a recommendation, while disabling recommendations loops the queue", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  for (const enabled of [true, false]) {
    const f = fixture();
    try {
      f.setRoom();
      f.info.creatorId = "1";
      f.command.targetSongId = "11";
      f.playback.songId = "11";
      f.setAutoRecommend(enabled);
      await f.service.takeOver("room-a");
      await tickRoom(t, 600);
      await f.service.control({ action: "next" });
      assert.equal(f.service.snapshot().songId, enabled ? "12" : "10");
      assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, enabled ? 1 : 0);
    } finally {
      f.service.stop();
    }
  }
});

test("remote heart activation during manual tail recommendation drops the stale ordinary candidate", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    f.command.targetSongId = "11";
    f.playback.songId = "11";
    f.playlist.displayList.rcmdSongIds = [];
    await f.service.takeOver("room-a");
    await tickRoom(t, 600);
    f.onRecommendations(() => {
      f.info.openHeartRcmd = true;
      f.playlist.displayList.result = ["11", "12"];
    });
    await f.service.control({ action: "next" });
    assert.equal(f.service.snapshot().recommendationMode, "heart");
    assert.equal(f.service.snapshot().songId, "12");
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 0);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 1);
  } finally {
    f.service.stop();
  }
});

test("members do not proactively append while playing and an uncertain append is never replayed at song end", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const member = fixture();
  try {
    member.setRoom();
    member.command.targetSongId = "11";
    member.command.playStatus = "PLAY";
    Object.assign(member.playback, { songId: "11", playing: true });
    await member.service.takeOver("room-a");
    await tickRoom(t, 2000);
    assert.equal(member.calls.filter((call) => call.operation === "roomAdd").length, 0);
  } finally {
    member.service.stop();
  }
  const f = fixture();
  try {
    f.setRoom();
    f.info.creatorId = "1";
    Object.assign(f.command, { targetSongId: "11", playStatus: "PLAY" });
    Object.assign(f.playback, { songId: "11", playing: true });
    f.onWrite((op) => {
      if (op === "roomAdd") throw new Error("operation-unknown");
    });
    await f.service.takeOver("room-a");
    await tickRoom(t, 2000);
    await tickRoom(t, 300);
    await tickRoom(t, 900);
    finishRoomSong(f);
    await tickRoom(t, 0);
    await tickRoom(t, 8000);
    assert.equal(f.calls.filter((call) => call.operation === "roomAdd").length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "roomCommand").length, 0);
  } finally {
    f.service.stop();
  }
});

test("friend directory caches each account page, excludes self and validates pagination", async () => {
  const f = fixture();
  try {
    const page = await f.service.friends("following", 0);
    assert.deepEqual(page.items, [{ id: "2", name: "friend", mutual: true }]);
    page.items.length = 0;
    assert.equal((await f.service.friends("following", 0)).items.length, 1);
    assert.equal(f.calls.filter((call) => call.operation === "userFollows").length, 1);
    assert.equal((await f.service.friends("followers", 0)).items[0].id, "3");
    await assert.rejects(f.service.friends("following", 99), /invalid-input/);
    await assert.rejects(f.service.friends("following", 500), /invalid-input/);
    f.social.accountId = "2";
    await assert.rejects(f.service.friends("following", 0), /account-changed/);
  } finally {
    f.service.stop();
  }
});

test("direct play publishes the new song before a slow ADD completes, then sends one GOTO", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    f.onWrite((op) => (op === "roomAdd" ? held : undefined));
    const job = f.service.play(["13"], 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.service.snapshot().songId, "13");
    assert.equal(f.service.snapshot().playing, true);
    assert.ok(f.updates.some((s) => s.songId === "13"));
    assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 0);
    t.mock.timers.tick(750);
    release();
    const next = await job;
    assert.equal(next.songId, "13");
    assert.equal(next.progressMs, 750);
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 1);
    assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 1);
  } finally {
    release?.();
    f.service.stop();
  }
});

test("play all appends unique official songs in original order and selects the original first song", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    const next = await f.service.play(["13", "12", "13", "10"], 0);
    assert.equal(next.songId, "13");
    assert.deepEqual(
      next.songs.map((s) => s.id),
      ["10", "11", "13", "12"],
    );
    const writes = f.calls.filter((c) => c.operation === "roomAdd");
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(String(writes[0].data.playlistParam)).displayList, ["13", "12"]);
    assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 1);
  } finally {
    f.service.stop();
  }
});

test("DELETE and REPLACE match Windows fields, and clear keeps the playing song without stopping it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    await f.service.editQueue({ action: "move", songId: "11", beforeId: "10" });
    let param = JSON.parse(
      String(f.calls.filter((c) => c.operation === "roomAdd").at(-1)!.data.playlistParam),
    );
    assert.equal(param.commandType, "REPLACE");
    assert.equal(param.anchorSongId, "");
    assert.equal(param.anchorPosition, -1);
    assert.deepEqual(param.displayList, ["11", "10"]);
    t.mock.timers.tick(1000);
    const before = f.halts();
    const next = await f.service.editQueue({ action: "clear" });
    param = JSON.parse(
      String(f.calls.filter((c) => c.operation === "roomAdd").at(-1)!.data.playlistParam),
    );
    assert.equal(param.commandType, "DELETE");
    assert.deepEqual(param.displayList, ["11"]);
    assert.deepEqual(
      next.songs.map((s) => s.id),
      ["10"],
    );
    assert.equal(f.halts(), before);
    assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 0);
    t.mock.timers.tick(1000);
    await assert.rejects(
      f.service.editQueue({ action: "remove", songId: "10" }),
      /room-current-song/,
    );
  } finally {
    f.service.stop();
  }
});

test("an accepted Windows list report uses existing polls, expires stale projection and never repeats ADD", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    f.setQueueResponse({ code: 200, data: { result: false } });
    let written = false;
    f.onWrite((op) => {
      if (op === "roomAdd") written = true;
    });
    f.onPlaylist(() =>
      written
        ? {
            data: {
              playlist: {
                ...f.playlist,
                displayList: { result: ["10", "11", "12"], rcmdSongIds: [] },
              },
              playCommand: f.command,
            },
          }
        : undefined,
    );
    const added = await f.service.add("13");
    assert.ok(added.songs.some((s) => s.id === "13"));
    await f.service.connect();
    assert.deepEqual(
      f.service.snapshot().songs.map((s) => s.id),
      ["10", "11", "12", "13"],
    );
    t.mock.timers.tick(16000);
    await f.service.connect();
    assert.deepEqual(
      f.service.snapshot().songs.map((s) => s.id),
      ["10", "11", "12"],
    );
    assert.equal(f.service.snapshot().error, "room-add-unconfirmed");
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 1);
  } finally {
    f.service.stop();
  }
});

test("fixed history continuation excludes queued songs and does not query personal recommendations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    f.setSongSource("history");
    f.service.setHistoryCandidates(["10", "11", "13", "13"]);
    f.command.targetSongId = "11";
    f.command.serverSeq++;
    f.playback.songId = "11";
    await f.service.connect();
    t.mock.timers.tick(1000);
    const next = await f.service.control({ action: "next" });
    assert.equal(next.songId, "13");
    assert.equal(f.calls.filter((c) => c.operation === "recommendations").length, 0);
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 1);
  } finally {
    f.service.stop();
  }
});

test("stopping a slow direct-play operation discards its queue and command continuation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    f.onWrite((op) => (op === "roomAdd" ? held : undefined));
    const job = f.service.play(["13"], 0);
    const rejected = assert.rejects(job, /cancelled/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.service.stop();
    release();
    await rejected;
    assert.equal(f.service.snapshot().playbackOwned, false);
    assert.equal(f.service.snapshot().songs.length, 0);
    assert.equal(f.calls.filter((c) => c.operation === "roomCommand").length, 0);
  } finally {
    release?.();
    f.service.stop();
  }
});

test("heart recommendation uses the official switch and server-restored queue without REPLACE", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    const enabled = await f.service.setHeartRecommendation(true);
    assert.equal(enabled.recommendationMode, "heart");
    assert.equal(f.playlist.listMode, "");
    assert.deepEqual(
      enabled.songs.map((s) => s.id),
      ["10", "12"],
    );
    assert.deepEqual(f.calls.find((c) => c.operation === "roomHeart")?.data, {
      roomId: "room-a",
      status: 1,
    });
    f.command.targetSongId = "12";
    f.command.serverSeq++;
    f.playback.songId = "12";
    await f.service.connect();
    t.mock.timers.tick(1000);
    await f.service.control({ action: "next" });
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 0);
    t.mock.timers.tick(1000);
    const disabled = await f.service.setHeartRecommendation(false);
    assert.equal(disabled.recommendationMode, undefined);
    assert.deepEqual(
      disabled.songs.map((s) => s.id),
      ["10", "11"],
    );
    assert.deepEqual(
      f.calls.filter((c) => c.operation === "roomHeart").map((c) => c.data.status),
      [1, 0],
    );
  } finally {
    f.service.stop();
  }
});

test("heart permission failure stays ordinary and never fakes success or repeats the switch", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    f.setHeartResponse({ code: 200, data: { success: false, refreshPlaylist: false } });
    await assert.rejects(
      f.service.setHeartRecommendation(true),
      /heart-recommendation-unavailable/,
    );
    assert.equal(f.service.snapshot().recommendationMode, undefined);
    assert.equal(f.calls.filter((c) => c.operation === "roomHeart").length, 1);
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 0);
  } finally {
    f.service.stop();
  }
});

test("remote heart switch discards unconfirmed ordinary queue projection", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  try {
    await f.service.accept("2", "invite");
    t.mock.timers.tick(1000);
    let wrote = false;
    f.onWrite((op) => {
      if (op === "roomAdd") wrote = true;
    });
    f.onPlaylist(() =>
      wrote
        ? {
            data: {
              playlist: {
                ...f.playlist,
                displayList: { result: ["10", "11"], rcmdSongIds: [] },
              },
              playCommand: f.command,
            },
          }
        : undefined,
    );
    await f.service.add("13");
    f.info.openHeartRcmd = true;
    await f.service.connect();
    assert.equal(f.service.snapshot().recommendationMode, "heart");
    assert.deepEqual(
      f.service.snapshot().songs.map((s) => s.id),
      ["10", "11"],
    );
    assert.equal(f.calls.filter((c) => c.operation === "roomAdd").length, 1);
  } finally {
    f.service.stop();
  }
});
