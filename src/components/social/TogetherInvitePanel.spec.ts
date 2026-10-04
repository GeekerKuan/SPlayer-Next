import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import zh from "@/i18n/locales/zh-CN.json";
import { useTogetherDialog } from "@/composables/useTogetherDialog";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), joinLink: vi.fn() }));
const state = reactive({ snapshot: { roomId: "" }, busy: false, error: "" });
vi.mock("@/stores/together", () => ({ useTogetherStore: () => ({ ...state, ...mocks }) }));
vi.mock("@/stores/user", () => ({
  useUserStore: () => ({
    profile: { userId: 1, nickname: "me", avatarUrl: "https://p1.music.126.net/me.jpg" },
  }),
}));
import TogetherInvitePanel from "./TogetherInvitePanel.vue";
import SButton from "@/components/ui/SButton.vue";
import SocialAvatar from "./SocialAvatar.vue";
import SCard from "@/components/ui/SCard.vue";

const invite = {
  url: "https://163cn.tv/test",
  marked: false,
  invitation: { roomId: "room", inviterId: "2" },
  songId: "3",
};
const metadata = {
  inviter: { id: "2", name: "friend", avatar: "https://p1.music.126.net/peer.jpg" },
  song: { id: "3", name: "shared song", artists: "artist", durationMs: 60000 },
  joinable: true,
};
const create = () =>
  mount(TogetherInvitePanel, {
    props: { invite },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } })],
      components: { SButton, SocialAvatar, SCard },
      stubs: { IconLucideHeadphones: true },
    },
  });
describe("clipboard invitation confirmation", () => {
  beforeEach(() => {
    state.snapshot.roomId = "";
    state.busy = false;
    mocks.connect.mockReset().mockResolvedValue(true);
    mocks.joinLink.mockReset().mockResolvedValue(true);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        together: {
          previewInvite: vi.fn().mockResolvedValue({ ok: true, data: metadata }),
          cancelPreview: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    });
    useTogetherDialog().showInvitation(invite);
  });
  it("ignores our own invitation without changing an existing dialog or fetching metadata", () => {
    const dialog = useTogetherDialog();
    dialog.open.value = false;
    dialog.showInvitation({ ...invite, invitation: { roomId: "own-room", inviterId: "1" } });
    expect(dialog.open.value).toBe(false);
    expect(window.api.together.previewInvite).not.toHaveBeenCalled();
    dialog.showDebug();
    dialog.showInvitation({ ...invite, invitation: { roomId: "own-room", inviterId: "1" } });
    expect(dialog.debug.value).toBe(true);
  });
  it("renders both avatars and the shared song without joining until the user accepts", async () => {
    const wrapper = create();
    await flushPromises();
    expect(wrapper.findAllComponents(SocialAvatar)).toHaveLength(2);
    expect(wrapper.text()).toContain("friend 邀请你一起听歌");
    expect(wrapper.text()).toContain("shared song");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.joinLink).not.toHaveBeenCalled();
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "接受")!
      .trigger("click");
    await flushPromises();
    expect(mocks.joinLink).toHaveBeenCalledWith(invite.invitation);
    expect(useTogetherDialog().clipboardInvite.value).toBeNull();
    wrapper.unmount();
  });
  it("does not replace an existing room, and disables accepting an expired invite", async () => {
    state.snapshot.roomId = "other";
    const wrapper = create();
    await flushPromises();
    expect(wrapper.text()).toContain("查看当前房间");
    expect(wrapper.findAll("button").some((button) => button.text() === "接受")).toBe(false);
    wrapper.unmount();
    state.snapshot.roomId = "";
    vi.mocked(window.api.together.previewInvite).mockResolvedValue({
      ok: true,
      data: { ...metadata, joinable: false },
    });
    const expired = create();
    await flushPromises();
    expect(
      expired
        .findAll("button")
        .find((button) => button.text() === "接受")!
        .attributes("disabled"),
    ).toBeDefined();
    expect(mocks.joinLink).not.toHaveBeenCalled();
    expired.unmount();
  });
  it("cancels on blur and ignores a late result after closing", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(window.api.together.previewInvite).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }),
    );
    const wrapper = create();
    await flushPromises();
    window.dispatchEvent(new Event("blur"));
    expect(window.api.together.cancelPreview).toHaveBeenCalled();
    wrapper.unmount();
    const calls = vi.mocked(window.api.together.previewInvite).mock.calls.length;
    release({ ok: true, data: metadata });
    await flushPromises();
    window.dispatchEvent(new Event("focus"));
    expect(window.api.together.previewInvite).toHaveBeenCalledTimes(calls);
    expect(mocks.joinLink).not.toHaveBeenCalled();
  });
});
