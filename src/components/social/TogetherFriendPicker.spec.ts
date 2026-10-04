import { mount, flushPromises } from "@vue/test-utils";
import { reactive, defineComponent } from "vue";
import { createI18n } from "vue-i18n";
import { beforeEach, describe, expect, it, vi } from "vitest";
import zh from "@/i18n/locales/zh-CN.json";
const user = reactive({ profile: { userId: 1 } });
vi.mock("@/stores/user", () => ({ useUserStore: () => user }));
vi.mock("@/stores/social", () => ({
  useSocialStore: () => ({ snapshot: { conversations: [{ peerId: "4", name: "recent" }] } }),
}));
import TogetherFriendPicker from "./TogetherFriendPicker.vue";
const Select = defineComponent({
  props: ["options", "modelValue", "disabled", "placeholder"],
  template: "<div />",
});
const create = () =>
  mount(TogetherFriendPicker, {
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } })],
      components: { SSelect: Select },
      stubs: { SButton: true },
    },
  });
describe("together friend picker", () => {
  beforeEach(() => {
    user.profile.userId = 1;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        together: {
          friends: vi.fn(async (kind) => ({
            ok: true,
            data: {
              items:
                kind === "following"
                  ? [
                      { id: "1", name: "self", mutual: false },
                      { id: "2", name: "mutual", mutual: true },
                      { id: "3", name: "following", mutual: false },
                    ]
                  : [
                      { id: "2", name: "duplicate", mutual: true },
                      { id: "6", name: "mutual from later following page", mutual: true },
                      { id: "5", name: "fan", mutual: false },
                    ],
              more: false,
            },
          })),
        },
      },
    });
  });
  it("always displays a picker and groups deduplicated mutual, following and followers before recent conversations", async () => {
    const wrapper = create();
    expect(wrapper.findComponent(Select).exists()).toBe(true);
    await flushPromises();
    expect(wrapper.findComponent(Select).props("options")).toEqual([
      { value: "2", label: "mutual", group: "互关好友" },
      { value: "6", label: "mutual from later following page", group: "互关好友" },
      { value: "3", label: "following", group: "我的关注" },
      { value: "5", label: "fan", group: "我的粉丝" },
      { value: "4", label: "recent", group: "最近会话" },
    ]);
    expect(window.api.together.friends).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
  it("keeps recent conversations on failure and does not apply a late response after account changes", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(window.api.together.friends)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve as typeof release;
          }),
      )
      .mockResolvedValue({ ok: false, error: "offline" });
    const wrapper = create();
    await flushPromises();
    user.profile.userId = 6;
    await flushPromises();
    release({ ok: true, data: { items: [{ id: "7", name: "stale", mutual: true }], more: true } });
    await flushPromises();
    expect(wrapper.findComponent(Select).props("options")).toEqual([
      { value: "4", label: "recent", group: "最近会话" },
    ]);
    expect(wrapper.text()).toContain("好友列表暂不可用");
    wrapper.unmount();
  });
});
