import { test } from "node:test";
import assert from "node:assert/strict";
import { loadInvitePreview } from "./invitePreview";
import type { SocialSnapshot } from "../../../../shared/types/social";
import type { NativeTransport } from "./netease-native/transport";

const invite = {
  url: "https://163cn.tv/test",
  marked: false,
  invitation: { roomId: "room", inviterId: "2" },
  songId: "3",
};
const account = {
  accountId: "1",
  status: "online",
  conversations: [],
} as unknown as SocialSnapshot;
test("invitation metadata reads never enter a room and do not substitute another song", async () => {
  const calls: string[] = [];
  const transport: NativeTransport = {
    call: async (op, data) => {
      calls.push(op);
      if (op === "userDetail") {
        assert.deepEqual(data, { all: "true", userId: "2" });
        return {
          profile: { userId: 2, nickname: "friend", avatarUrl: "https://p1.music.126.net/a.jpg" },
        };
      }
      if (op === "roomSongs")
        return {
          songs: [
            { id: 3, name: "song", ar: [{ name: "artist" }], dt: 60000 },
            { id: 4, name: "other", ar: [], dt: 1 },
          ],
        };
      assert.deepEqual(data, { roomId: "room" });
      return { data: { joinable: true } };
    },
  };
  const result = await loadInvitePreview(invite, account, transport, new AbortController().signal);
  assert.equal(result.inviter.name, "friend");
  assert.equal(result.song?.id, "3");
  assert.equal(result.joinable, true);
  assert.deepEqual(calls.sort(), ["roomCheck", "roomSongs", "userDetail"]);
});
test("expired rooms remain visible while optional song/profile failures use truthful placeholders", async () => {
  const result = await loadInvitePreview(
    invite,
    account,
    {
      call: async (op) => {
        if (op === "roomCheck") return { data: { joinable: false, copywriting: "expired" } };
        throw new Error("offline");
      },
    },
    new AbortController().signal,
  );
  assert.equal(result.inviter.name, "2");
  assert.equal(result.song, undefined);
  assert.equal(result.joinable, false);
  assert.equal(result.hint, "expired");
});
test("cached friend avatars skip lookup, and cancelled results never populate a preview", async () => {
  const controller = new AbortController();
  let lookups = 0;
  const transport: NativeTransport = {
    call: async (op) => {
      if (op === "userDetail") lookups++;
      controller.abort();
      return {};
    },
  };
  await assert.rejects(
    loadInvitePreview(
      invite,
      {
        ...account,
        conversations: [
          {
            peerId: "2",
            name: "known",
            avatar: "https://p1.music.126.net/a.jpg",
            preview: "",
            unread: 0,
            updatedAt: 0,
          },
        ],
      },
      transport,
      controller.signal,
    ),
    /abort/i,
  );
  assert.equal(lookups, 0);
});
test("authentication failures are not hidden as missing invitation metadata", async () => {
  await assert.rejects(
    loadInvitePreview(
      invite,
      account,
      {
        call: async () => {
          throw new Error("auth-required");
        },
      },
      new AbortController().signal,
    ),
    /auth-required/,
  );
});

test("own invitation never fetches preview metadata", async () => {
  let requests = 0;
  await assert.rejects(
    loadInvitePreview(
      { ...invite, invitation: { roomId: "own-room", inviterId: "1" } },
      account,
      {
        call: async () => {
          requests++;
          return {};
        },
      },
      new AbortController().signal,
    ),
    /self-invitation/,
  );
  assert.equal(requests, 0);
});
