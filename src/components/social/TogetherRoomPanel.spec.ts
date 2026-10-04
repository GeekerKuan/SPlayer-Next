import { mount, flushPromises } from "@vue/test-utils";
import { reactive, defineComponent } from "vue";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.json";
const mocks = vi.hoisted(() => ({ add: vi.fn(), setSystem: vi.fn() }));
const together = reactive({
  snapshot: {
    mode: "native",
    playbackOwned: true,
    creatorId: "1",
    connected: true,
    status: "togetherOwner",
    roomId: "room",
    songId: "10",
    songs: [{ id: "10", name: "queued", artists: "artist" }],
    members: [
      { id: "1", name: "self" },
      { id: "2", name: "friend" },
    ],
    recommendations: [],
    awaitingNext: false,
  },
  error: "",
  busy: false,
  recommendationsLoading: true,
  recommendations: [
    { id: "10", name: "queued", artists: "artist" },
    { id: "11", name: "candidate", artists: "artist" },
  ],
  ...mocks,
});
const settings = reactive({
  system: { player: { togetherAutoRecommend: true } },
  setSystem: mocks.setSystem,
});
vi.mock("@/stores/together", () => ({ useTogetherStore: () => together }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => settings }));
vi.mock("@/stores/user", () => ({ useUserStore: () => ({ profile: { userId: 1 } }) }));
vi.mock("@/stores/history", () => ({ useHistoryStore: () => ({ tracks: [], load: vi.fn() }) }));
vi.mock("@/composables/useCopyText", () => ({ useCopyText: () => ({ copy: vi.fn() }) }));
vi.mock("@/composables/useDialog", () => ({ dialog: { confirm: vi.fn() } }));
import TogetherRoomPanel from "./TogetherRoomPanel.vue";
const Select = defineComponent({
  props: ["options", "modelValue"],
  emits: ["update:modelValue"],
  template: "<div />",
});
const List = defineComponent({
  props: ["items"],
  template:
    '<div><slot v-for="item in items" :item="item" /><slot v-if="!items.length" name="empty" /></div>',
});
const create = () =>
  mount(TogetherRoomPanel, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } })],
      components: { SSelect: Select, SVirtualList: List },
      stubs: {
        TogetherFriendPicker: true,
        SInput: true,
        SButton: true,
        SocialAvatar: true,
        IconLucidePlus: true,
      },
    },
  });
describe("together room lists and roles", () => {
  beforeEach(() => {
    together.snapshot.creatorId = "1";
    together.snapshot.awaitingNext = false;
    settings.system.player.togetherAutoRecommend = true;
  });
  it("shares two independent list regions and adds only a recommendation not already queued", async () => {
    const wrapper = create();
    const lists = wrapper.findAllComponents(List);
    expect(lists).toHaveLength(2);
    expect(wrapper.findComponent({ name: "TogetherFriendPicker" }).exists()).toBe(false);
    expect(wrapper.text()).not.toContain("复制邀请链接");
    expect(lists[0].props("items")).toHaveLength(1);
    expect(lists[1].props("items")).toEqual([{ id: "11", name: "candidate", artists: "artist" }]);
    await wrapper.find("button").trigger("click");
    expect(mocks.add).toHaveBeenCalledWith("11");
    wrapper.findComponent(Select).vm.$emit("update:modelValue", "playlistOnly");
    expect(mocks.setSystem).toHaveBeenCalledWith("player.togetherAutoRecommend", false);
    wrapper.unmount();
  });
  it("keeps room recommendation empty text in the right list and hides host-only options for members", async () => {
    together.snapshot.creatorId = "2";
    const wrapper = create();
    expect(wrapper.text()).toContain("房员 · 跟随房间播放");
    expect(
      wrapper
        .findComponent(Select)
        .props("options")
        .some((item: { value: string }) => item.value === "playlistOnly"),
    ).toBe(false);
    wrapper.findComponent(Select).vm.$emit("update:modelValue", "room");
    await flushPromises();
    expect(wrapper.findAllComponents(List)[1].text()).toContain("房间暂未提供推荐");
    expect(mocks.setSystem).not.toHaveBeenCalled();
    together.snapshot.awaitingNext = true;
    await flushPromises();
    expect(wrapper.text()).toContain("正在等待房间下一首");
    wrapper.unmount();
  });
});
