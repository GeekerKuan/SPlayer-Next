import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, randomUUID } from "node:crypto";
import { createNativeTransport, encodeNativeEapi } from "./netease-native/transport";
import {
  decodeContent,
  decodeConversations,
  decodeMessages,
  decodeNotices,
} from "./netease-native/codec";
import { SocialService, emptySocialSnapshot, mergeMessages } from "./service";
import { socialSend } from "./validation";
import type { NativeTransport } from "./netease-native/transport";
import type { SocialMessage, SocialSnapshot } from "@shared/types/social";

const user = (id: number) => ({ userId: id, nickname: `user-${id}`, avatarUrl: "" });
const message = (id: number, time = id): SocialMessage => ({
  id: String(id),
  time,
  peerId: "2",
  senderId: "2",
  kind: "text",
  text: String(id),
  delivery: "sent",
});
const conversation = () => ({
  fromUser: user(2),
  toUser: user(1),
  lastMsg: '{"type":6,"msg":"hello"}',
  lastMsgTime: 10,
  newMsgCount: 1,
});

test("native message cards retain resource data, avatar identity and safe fallback content", () => {
  const song = decodeContent(
    JSON.stringify({
      type: 1,
      msg: "推荐给你",
      song: { id: 5, name: "歌曲", album: { picUrl: "http://p1.music.126.net/a.jpg" } },
    }),
  );
  assert.equal(song.kind, "card");
  assert.equal(song.card?.type, "song");
  assert.equal(song.card?.id, "5");
  assert.equal(song.card?.cover, "https://p1.music.126.net/a.jpg");
  const image = decodeContent(
    JSON.stringify({
      type: 16,
      picInfo: { picUrl: "https://p1.music.126.net/image.jpg", width: 200 },
    }),
  );
  assert.equal(image.card?.type, "image");
  const sized = decodeContent(
    JSON.stringify({
      type: 16,
      picInfo: {
        picUrl: "https://p1.music.126.net/image.jpg",
        width: 800,
        height: 1600,
      },
    }),
  );
  assert.equal(sized.card?.width, 800);
  assert.equal(sized.card?.height, 1600);
  const malformed = decodeContent(
    JSON.stringify({
      type: 16,
      picInfo: {
        picUrl: "https://p1.music.126.net/image.jpg",
        width: -1,
        height: 999999,
      },
    }),
  );
  assert.equal(malformed.card?.width, undefined);
  assert.equal(malformed.card?.cover, sized.card?.cover);
  const unsafe = decodeContent(
    JSON.stringify({
      type: 23,
      generalMsg: { title: "安全文本", webUrl: "javascript:alert(1)", nativeUrl: "orpheus://exec" },
    }),
  );
  assert.equal(unsafe.card?.title, "安全文本");
  assert.equal(unsafe.card?.url, undefined);
  assert.equal(decodeContent('{"type":777,"msg":"未知类型的文本"}').text, "未知类型的文本");
  const messages = decodeMessages(
    {
      msgs: [
        {
          id: 1,
          time: 1,
          fromUser: {
            userId: 2,
            nickname: "朋友",
            avatarUrl: "https://p1.music.126.net/avatar.jpg",
          },
          msg: '{"type":6,"msg":"hello"}',
        },
      ],
      more: false,
    },
    "2",
  );
  assert.equal(messages.items[0].senderName, "朋友");
  assert.equal(messages.items[0].senderAvatar, "https://p1.music.126.net/avatar.jpg");
});
const fixture = (override?: NativeTransport["call"]) => {
  let token = "account-a";
  const updates: SocialSnapshot[] = [];
  const calls: string[] = [];
  const removed: string[] = [];
  const service = new SocialService({
    transport: {
      call:
        override ??
        (async (operation) => {
          calls.push(operation);
          if (operation === "account")
            return { code: 200, account: { id: token === "account-a" ? 1 : 3 } };
          if (operation === "conversations")
            return { code: 200, more: false, msgs: [conversation()] };
          if (operation === "history")
            return {
              code: 200,
              more: false,
              msgs: [{ id: 7, fromUser: user(2), time: 10, msg: '{"type":6,"msg":"hello"}' }],
            };
          return { code: 200 };
        }),
    },
    token: () => token,
    visible: () => false,
    cache: {
      load: async () => null,
      save: async () => {},
      remove: async (id) => {
        removed.push(id);
      },
    },
    update: (snapshot) => updates.push(snapshot),
  });
  return {
    service,
    calls,
    updates,
    removed,
    token: (value: string) => {
      token = value;
    },
  };
};

test("native eapi signs /api path and sends encrypted params", () => {
  const form = encodeNativeEapi("/api/msg/private/send", { msg: "hello" });
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from("e82ckenh8dichen8"), null);
  const text = Buffer.concat([
    decipher.update(Buffer.from(new URLSearchParams(form).get("params")!, "hex")),
    decipher.final(),
  ]).toString();
  assert.match(text, /^\/api\/msg\/private\/send-36cd479b6b5-\{"msg":"hello"\}/);
  assert.ok(!form.includes("hello"));
});
test("native transport retries reads and never replays an ambiguous send", async () => {
  let calls = 0;
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: "test" }),
    mergeCookies: () => {},
    fetch: async (url) => {
      assert.match(String(url), /^https:\/\/interfacepc.music.163.com\/eapi\//);
      calls++;
      if (calls === 1) throw new TypeError("network error");
      return new Response('{"code":200}', { status: 200 });
    },
  });
  await transport.call("history", {}, new AbortController().signal);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(transport.call("send", {}, new AbortController().signal), /send-unknown/);
  assert.equal(calls, 1);
});
test("heart mode switch uses the observed path and never replays an unknown mutation", async () => {
  let calls = 0;
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: "test" }),
    mergeCookies: () => {},
    fetch: async (url) => {
      calls++;
      assert.equal(
        String(url),
        "https://interfacepc.music.163.com/eapi/listen/together/heart/rcmd/change",
      );
      throw new TypeError("network error");
    },
  });
  await assert.rejects(
    transport.call("roomHeart", { roomId: "room", status: 1 }, new AbortController().signal),
    /operation-unknown/,
  );
  assert.equal(calls, 1);
});
test("server business errors are not retried", async () => {
  let calls = 0;
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: "test" }),
    mergeCookies: () => {},
    fetch: async () => {
      calls++;
      return new Response('{"code":301}');
    },
  });
  await assert.rejects(
    transport.call("history", {}, new AbortController().signal),
    /auth-required/,
  );
  assert.equal(calls, 1);
});
test("HTTP 429 cools down this account without replaying writes, then expires or resets on account change", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  let token = "first",
    calls = 0;
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: token }),
    mergeCookies: () => {},
    fetch: async () => {
      calls++;
      return calls === 1
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : new Response('{"code":200}');
    },
  });
  const signal = new AbortController().signal;
  await assert.rejects(transport.call("roomAdd", {}, signal), /rate-limited/);
  await assert.rejects(transport.call("roomStatus", {}, signal), /rate-limited/);
  assert.equal(calls, 1);
  t.mock.timers.tick(2000);
  await transport.call("roomStatus", {}, signal);
  assert.equal(calls, 2);
  token = "second";
  await transport.call("roomStatus", {}, signal);
  assert.equal(calls, 3);
});
test("account changes cannot merge cookies from old requests", async () => {
  let token = "old";
  let merged = false;
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: token }),
    mergeCookies: () => {
      merged = true;
    },
    fetch: async () => {
      token = "new";
      return new Response('{"code":200}', { headers: { "set-cookie": "NMTID=value" } });
    },
  });
  await assert.rejects(
    transport.call("history", {}, new AbortController().signal),
    /account-changed/,
  );
  assert.equal(merged, false);
});
test("validation rejects blank, invisible-only, oversize and spoofed IDs", () => {
  const input = { peerId: "2", text: "hi", clientId: randomUUID() };
  for (const text of [" ", "\n", "\u200B", "a".repeat(501)])
    assert.equal(socialSend.safeParse({ ...input, text }).success, false);
  assert.equal(socialSend.safeParse({ ...input, peerId: "../2" }).success, false);
  assert.equal(socialSend.safeParse({ ...input, cookie: "untrusted" }).success, false);
  assert.equal(socialSend.parse({ ...input, text: " a " }).text, "a");
});
test("codec picks the other user and treats unverified native cards as unsupported", () => {
  assert.equal(decodeContent('{"type":6,"msg":"test"}').kind, "text");
  assert.equal(decodeContent('{"type":1,"msg":"shared song"}').kind, "unsupported");
  assert.equal(
    decodeConversations({ msgs: [conversation()], more: false }, "1", 0).items[0].peerId,
    "2",
  );
  assert.deepEqual(decodeContent('{"type":99,"msg":"<script>text</script>"}'), {
    kind: "unsupported",
    text: "<script>text</script>",
  });
  assert.equal(decodeContent("x".repeat(16001)).kind, "unsupported");
  assert.throws(() => decodeMessages({ msgs: [{ id: "../bad" }], more: false }, "2"));
});
test("history merge deduplicates IDs and bounds both pagination directions", () => {
  const items = Array.from({ length: 600 }, (_, index) => message(index + 1));
  assert.equal(mergeMessages(items, [message(600)]).length, 500);
  assert.equal(mergeMessages(items, [message(600)])[0].id, "101");
  assert.equal(mergeMessages(items, [], true).at(-1)?.id, "500");
});

test("Windows native invitation URLs are classified without passing through executable links", () => {
  const url =
    "orpheus://open?url1=" +
    encodeURIComponent("orpheus://nm/play/listenTogether?roomId=demo-room&inviterId=2");
  const decode = (nativeUrl: string) =>
    decodeContent(JSON.stringify({ type: 23, generalMsg: { nativeUrl } }));
  assert.deepEqual(decode(url).invite, { roomId: "demo-room", inviterId: "2" });
  assert.equal(decode(url).kind, "invite");
  for (const bad of [
    "https://example.com/?roomId=x",
    url.replace("orpheus://open", "orpheus://evil"),
    "orpheus://open?url1=" +
      encodeURIComponent("orpheus://nm/play/listenTogether?roomId=x&inviterId=2&inviterId=3"),
  ])
    assert.equal(decode(bad).kind, "unsupported");
  assert.ok(!JSON.stringify(decode(url)).includes("orpheus:"));
});

test("notice pagination uses the Windows time cursors rather than treating them as offsets", () => {
  assert.equal(decodeNotices({ forwards: [], more: true, lasttime: 50 }, "mention", -1).cursor, 50);
  assert.equal(decodeNotices({ notices: [], more: false, lastTime: 60 }, "notice", -1).cursor, 60);
});
test("concurrent sends share a clientId result and account rate limits apply", async () => {
  const f = fixture();
  await f.service.snapshot();
  const input = { peerId: "2", text: "hello", clientId: randomUUID() };
  const [first, second] = await Promise.all([f.service.send(input), f.service.send(input)]);
  assert.equal(first.id, second.id);
  assert.equal(f.calls.filter((call) => call === "send").length, 1);
  await assert.rejects(f.service.send({ ...input, text: "changed" }), /duplicate-client-id/);
  await assert.rejects(f.service.send({ ...input, clientId: randomUUID() }), /rate-limited/);
  f.service.stop();
});
test("read watermark cannot exceed fetched history and is only local", async () => {
  const f = fixture();
  await f.service.refresh();
  await f.service.open("2");
  await assert.rejects(f.service.localRead("2", 999), /invalid-read-time/);
  const result = await f.service.localRead("2", 10);
  assert.equal(result.conversations[0].unread, 0);
  assert.equal(result.capabilities.nativeReadReceipt, false);
  assert.equal(f.calls.includes("read"), false);
  f.service.stop();
});

test("explicit failed send retries share their original bubble and never replay an unknown result", async (context) => {
  let now = 10000;
  context.mock.method(Date, "now", () => now);
  let sends = 0;
  const f = fixture(async (operation) => {
    if (operation === "account") return { code: 200, account: { id: 1 } };
    if (operation === "send") {
      sends++;
      if (sends === 1) throw new Error("send-failed");
      if (sends === 3) throw new Error("send-unknown");
    }
    return { code: 200 };
  });
  try {
    const first = await f.service.send({ peerId: "2", text: "hello", clientId: randomUUID() });
    assert.equal(first.delivery, "failed");
    now += 1500;
    const results = await Promise.all([f.service.retry(first.id), f.service.retry(first.id)]);
    assert.ok(results.every((item) => item.id === first.id && item.delivery === "sent"));
    assert.equal(sends, 2);
    assert.equal((await f.service.snapshot()).messages["2"].length, 1);
    await assert.rejects(f.service.retry(first.id), /invalid-input/);
    now += 1500;
    const unknown = await f.service.send({ peerId: "2", text: "another", clientId: randomUUID() });
    assert.equal(unknown.delivery, "unknown");
    await assert.rejects(f.service.retry(unknown.id), /invalid-input/);
    assert.equal(sends, 3);
  } finally {
    f.service.stop();
  }
});
test("account switch clears previous messages and logout removes account cache", async () => {
  const f = fixture();
  await f.service.open("2");
  f.token("account-b");
  const result = await f.service.snapshot();
  assert.equal(result.accountId, "3");
  assert.deepEqual(result.messages, {});
  f.service.logout();
  assert.deepEqual(f.removed, ["3"]);
  f.token("");
  assert.deepEqual((await f.service.snapshot()).messages, {});
});
test("stop aborts pending history and prevents stale response publication", async () => {
  let release: (() => void) | undefined;
  const f = fixture(async (operation, _args, signal) => {
    if (operation === "account") return { code: 200, account: { id: 1 } };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.equal(signal.aborted, true);
    return { code: 200, more: false, msgs: [] };
  });
  await f.service.snapshot();
  const job = f.service.open("2");
  await new Promise((resolve) => setImmediate(resolve));
  f.service.stop();
  release!();
  await assert.rejects(job, /account-changed/);
  assert.equal(f.updates.length, 0);
});
test("empty snapshot contains no credentials", () => {
  assert.equal(JSON.stringify(emptySocialSnapshot()).includes("MUSIC_U"), false);
});

test("friend pagination signs the UID path and retains the original request fields", async () => {
  const seen: { path: string; data: Record<string, unknown> }[] = [];
  const transport = createNativeTransport({
    cookies: () => ({ MUSIC_U: "test" }),
    mergeCookies: () => {},
    fetch: async (url, init) => {
      const decipher = createDecipheriv("aes-128-ecb", Buffer.from("e82ckenh8dichen8"), null);
      const plain = Buffer.concat([
        decipher.update(Buffer.from(new URLSearchParams(String(init?.body)).get("params")!, "hex")),
        decipher.final(),
      ])
        .toString()
        .split("-36cd479b6b5-");
      seen.push({ path: plain[0], data: JSON.parse(plain[1]) });
      assert.equal(String(url), `https://interfacepc.music.163.com/eapi/${plain[0].slice(5)}`);
      return new Response('{"code":200}');
    },
  });
  const signal = new AbortController().signal;
  await transport.call(
    "userFollows",
    { userId: "1", offset: 100, limit: 100, order: true },
    signal,
  );
  await transport.call(
    "userFollowers",
    { userId: "1", offset: 0, limit: 100, time: "0", getcounts: "true" },
    signal,
  );
  assert.equal(seen[0].path, "/api/user/getfollows/1");
  assert.equal(seen[0].data.userId, undefined);
  assert.equal(seen[0].data.offset, 100);
  assert.equal(seen[0].data.order, true);
  assert.equal(seen[1].path, "/api/user/getfolloweds/1");
  assert.equal(seen[1].data.userId, "1");
  assert.equal(seen[1].data.time, "0");
  assert.equal(seen[1].data.getcounts, "true");
});

test("missing or invalid Retry-After uses a full minute of local cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  for (const retryAfter of [undefined, "invalid", "-1"]) {
    let calls = 0;
    const transport = createNativeTransport({
      cookies: () => ({ MUSIC_U: "test" }),
      mergeCookies: () => {},
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response("", {
              status: 429,
              headers: retryAfter ? { "retry-after": retryAfter } : {},
            })
          : new Response('{"code":200}');
      },
    });
    const signal = new AbortController().signal;
    await assert.rejects(transport.call("roomStatus", {}, signal), /rate-limited/);
    t.mock.timers.tick(59999);
    await assert.rejects(transport.call("roomStatus", {}, signal), /rate-limited/);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await transport.call("roomStatus", {}, signal);
    assert.equal(calls, 2);
  }
});
