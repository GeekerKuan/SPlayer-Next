import { mount, flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import { defineComponent } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SocialApi, SocialSnapshot } from "@shared/types/social";
import zh from "@/i18n/locales/zh-CN.json";
vi.mock("@/services/togetherPlayback", () => ({
  applyTogetherPlayback: vi.fn(),
  disposeTogetherPlayback: vi.fn(),
}));

vi.mock("@/stores/user", () => ({
  useUserStore: () => ({ isLoggedIn: true, profile: { userId: 1 } }),
}));
import Messages from "./Messages.vue";
import STabs from "@/components/ui/STabs.vue";
import SocialAvatar from "@/components/social/SocialAvatar.vue";
import SCard from "@/components/ui/SCard.vue";

const state: SocialSnapshot = {
  accountId: "1",
  status: "online",
  updatedAt: 1,
  notices: ["comment", "mention", "notice"].map((kind) => ({
    id: kind,
    kind: kind as "comment" | "mention" | "notice",
    text: `${kind} 的详情`,
    time: 10,
    locallyRead: true,
  })),
  readTimes: {},
  conversations: [
    { peerId: "2", name: "测试会话", avatar: "", preview: "你好", unread: 1, updatedAt: 10 },
  ],
  messages: {
    "2": [
      {
        id: "7",
        peerId: "2",
        senderId: "2",
        text: "你好",
        kind: "text",
        time: 10,
        delivery: "sent",
      },
    ],
  },
  capabilities: { nativeReadReceipt: false, together: false, transport: "eapi-poll" },
};
// eslint-disable-next-line vue/one-component-per-file -- 同一测试文件提供不同宿主组件的替身。
const stubList = defineComponent({
  props: { items: Array },
  data: () => ({ top: 0 }),
  methods: {
    scrollToIndex: () => {},
    scrollToBottom: () => {},
    getScrollTop() {
      return this.top;
    },
    getItemTop: () => 0,
    scrollTo(top: number) {
      this.top = top;
    },
  },
  template: '<div><slot v-for="item in items" :item="item" /></div>',
});
// eslint-disable-next-line vue/one-component-per-file -- 输入框与列表替身共用于页面交互测试。
const stubInput = defineComponent({
  props: { modelValue: [String, Number], type: String },
  emits: ["update:modelValue"],
  template:
    '<div v-if="type === \'textarea\'"><textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /><slot name="footer" /></div><input v-else :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
});
const send = vi.fn(async () => ({
  ok: true,
  data: { ...state.messages["2"][0], senderId: "1", delivery: "sent" },
}));
const stop = vi.fn(async () => {});
const createWrapper = () =>
  mount(Messages, {
    global: {
      components: { STabs, SocialAvatar, SCard },
      plugins: [
        createPinia(),
        createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zh } }),
      ],
      stubs: {
        SButton: { template: "<button><slot /></button>" },
        SInput: stubInput,
        SVirtualList: stubList,
        SImg: true,
        SocialMessageBubble: {
          props: ["message", "timeGroup", "timeLabel"],
          template: '<div><time v-if="timeGroup">{{ timeLabel }}</time>{{ message.text }}</div>',
        },
      },
    },
  });

describe("messages page lifecycle and composition", () => {
  beforeEach(() => {
    send.mockClear();
    stop.mockClear();
    const social: SocialApi = {
      start: async () => ({ ok: true, data: structuredClone(state) }),
      stop,
      snapshot: async () => ({ ok: true, data: structuredClone(state) }),
      refresh: async () => ({ ok: true, data: structuredClone(state) }),
      conversations: async () => ({
        ok: true,
        data: { items: state.conversations, more: false, cursor: 1 },
      }),
      open: async () => ({
        ok: true,
        data: { items: state.messages["2"], more: false, cursor: 10 },
      }),
      onUpdate: () => () => {},
      onNavigate: () => () => {},
      send: send as SocialApi["send"],
      retry: vi.fn(),
      history: vi.fn(),
      notifications: async (kind) => ({
        ok: true,
        data: {
          items: state.notices.filter((item) => item.kind === kind),
          more: false,
          cursor: 10,
        },
      }),
      localRead: vi.fn(),
      localReadNotices: vi.fn(),
      dismissInvite: vi.fn(),
    };
    Object.defineProperty(window, "api", { configurable: true, value: { social } });
  });
  it("opens a conversation, sends with Enter, and stops subscriptions on unmount", async () => {
    const wrapper = createWrapper();
    await flushPromises();
    const conversation = wrapper
      .findAll("button")
      .find((button) => button.text().includes("测试会话"))!;
    await conversation.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("你好");
    await wrapper.find("textarea").setValue("测试消息");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]).toHaveLength(1);
    wrapper.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("does not send during IME composition or Shift+Enter", async () => {
    const wrapper = createWrapper();
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("测试会话"))!
      .trigger("click");
    await flushPromises();
    await wrapper.find("textarea").setValue("中文输入");
    await wrapper.find("textarea").trigger("keydown", { key: "Enter", isComposing: true });
    await wrapper.find("textarea").trigger("keydown", { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("shares one detail area for all four tabs and preserves the chat draft", async () => {
    const wrapper = createWrapper();
    await flushPromises();
    await wrapper.find(".conversation-row").trigger("click");
    await flushPromises();
    await wrapper.find("textarea").setValue("保留草稿");
    for (const [index, kind] of ["comment", "mention", "notice"].entries()) {
      await wrapper.findAll('[role="tab"]')[index + 1].trigger("click");
      await flushPromises();
      expect(wrapper.find("textarea").exists()).toBe(false);
      await wrapper.find(".conversation-row").trigger("click");
      expect(wrapper.find(".detail-pane").text()).toContain(`${kind} 的详情`);
      expect(wrapper.findAll(".detail-pane")).toHaveLength(1);
    }
    await wrapper.findAll('[role="tab"]')[0].trigger("click");
    await flushPromises();
    expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("保留草稿");
    expect(wrapper.findAll("input")).toHaveLength(0);
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(4);
    wrapper.unmount();
  });
  it("does not start follow-up reads after unmounting during login resolution", async () => {
    let release!: (value: unknown) => void;
    const conversations = vi.fn();
    window.api.social.start = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ) as SocialApi["start"];
    window.api.social.conversations = conversations;
    const wrapper = createWrapper();
    wrapper.unmount();
    release({ ok: true, data: structuredClone(state) });
    await flushPromises();
    expect(conversations).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("keeps an independent scroll position for each message category", async () => {
    const wrapper = createWrapper();
    await flushPromises();
    const currentList = () => wrapper.findAllComponents(stubList)[0].vm;
    const positions = [760, 152, 380, 608];
    for (let index = 0; index < 4; index++) {
      await wrapper.findAll('[role="tab"]')[index].trigger("click");
      await flushPromises();
      expect(currentList().getScrollTop()).toBe(0);
      currentList().scrollTo(positions[index]);
    }
    for (let index = 0; index < 4; index++) {
      await wrapper.findAll('[role="tab"]')[index].trigger("click");
      await flushPromises();
      expect(currentList().getScrollTop()).toBe(positions[index]);
    }
    wrapper.unmount();
  });
  it("loads older messages on upward scrolling without a top button or concurrent requests", async () => {
    window.api.social.open = vi.fn(async () => ({
      ok: true as const,
      data: { items: state.messages["2"], more: true, cursor: 10 },
    }));
    let finish!: (value: unknown) => void;
    const history = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    window.api.social.history = history as SocialApi["history"];
    const wrapper = createWrapper();
    await flushPromises();
    await wrapper.find(".conversation-row").trigger("click");
    await flushPromises();
    expect(history).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain("加载更早消息");
    wrapper.findAllComponents(stubList)[1].vm.$emit("scrollIntent", -100);
    wrapper.findAllComponents(stubList)[1].vm.$emit("scrollIntent", -100);
    expect(history).toHaveBeenCalledExactlyOnceWith("2", 10);
    finish({ ok: true, data: { items: [], more: false, cursor: 10 } });
    await flushPromises();
    wrapper.findAllComponents(stubList)[1].vm.$emit("scrollIntent", -100);
    expect(history).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
