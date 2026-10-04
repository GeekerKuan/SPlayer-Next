import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { defineComponent, reactive, nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.json";
import type { TogetherSnapshot } from "@shared/types/together";
import { useTogetherPresence } from "./useTogetherPresence";

const stores = vi.hoisted(() => ({
  together: {} as Record<string, unknown>,
  user: {} as Record<string, unknown>,
}));
vi.mock("@/stores/together", () => ({ useTogetherStore: () => stores.together }));
vi.mock("@/stores/user", () => ({ useUserStore: () => stores.user }));
vi.mock("@/stores/social", () => ({
  useSocialStore: () => ({
    snapshot: { conversations: [{ peerId: "2", name: "好友", avatar: "peer.jpg" }] },
  }),
}));

const waiting: TogetherSnapshot = {
  connected: true,
  mode: "native",
  playbackOwned: true,
  status: "waiting",
  roomId: "room",
  members: [{ id: "1", name: "自己", avatar: "self.jpg" }],
  songs: [],
  songId: "",
  playing: false,
  progressMs: 0,
  updatedAt: 0,
};
function setup() {
  let presence!: ReturnType<typeof useTogetherPresence>;
  const wrapper = mount(
    defineComponent({
      setup() {
        presence = useTogetherPresence();
        return () => null;
      },
    }),
    {
      global: {
        plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } })],
      },
    },
  );
  return { presence, wrapper };
}
describe("together presentation lifecycle", () => {
  beforeEach(() => {
    stores.together = reactive({ snapshot: structuredClone(waiting), invitedPeerId: "2" });
    stores.user = reactive({ profile: { userId: 1, nickname: "自己", avatarUrl: "self.jpg" } });
  });
  it("retains member identity on exit and retargets a rapid rejoin without delayed callbacks", async () => {
    const { presence, wrapper } = setup();
    expect(presence.active.value).toBe(true);
    expect(presence.participants.value[1]).toMatchObject({
      id: "2",
      waiting: true,
      avatar: "peer.jpg",
    });
    stores.together.snapshot = {
      ...waiting,
      status: "together",
      members: [...waiting.members, { id: "2", name: "好友", avatar: "peer.jpg" }],
      effectiveDurationMs: 420000,
    };
    await nextTick();
    expect(presence.joined.value).toBe(true);
    expect(presence.caption.value).toContain("7 分钟");
    stores.together.snapshot = { ...waiting, roomId: "", status: "alone", members: [] };
    stores.together.invitedPeerId = "";
    await nextTick();
    expect(presence.active.value).toBe(false);
    expect(presence.participants.value[1].avatar).toBe("peer.jpg");
    stores.together.snapshot = { ...waiting, roomId: "new-room" };
    stores.together.invitedPeerId = "3";
    await nextTick();
    expect(presence.active.value).toBe(true);
    expect(presence.participants.value[1].id).toBe("3");
    expect(presence.joined.value).toBe(false);
    wrapper.unmount();
  });
  it("hides foreign accounts and does not invent listening duration while offline", async () => {
    const { presence, wrapper } = setup();
    stores.together.snapshot = {
      ...waiting,
      status: "together",
      members: [...waiting.members, { id: "2", name: "好友" }],
    };
    await nextTick();
    expect(presence.caption.value).toBe("正在一起听歌");
    stores.together.snapshot = {
      ...(stores.together.snapshot as TogetherSnapshot),
      connected: false,
    };
    await nextTick();
    expect(presence.caption.value).toBe("正在恢复房间连接…");
    stores.user.profile = { userId: 9 };
    await nextTick();
    expect(presence.active.value).toBe(false);
    wrapper.unmount();
  });
});
