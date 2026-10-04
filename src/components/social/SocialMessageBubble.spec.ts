import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import SCard from "@/components/ui/SCard.vue";
import SocialAvatar from "./SocialAvatar.vue";
import SocialMessageImage from "./SocialMessageImage.vue";
vi.mock("@/core/player", () => ({ playFrom: vi.fn() }));
vi.mock("@/utils/navigate", () => ({ navigateToResource: vi.fn() }));
vi.mock("@/apis/song/netease", () => ({ songsByIds: vi.fn(async () => []) }));
import SocialMessageBubble from "./SocialMessageBubble.vue";
import type { SocialMessage } from "@shared/types/social";

const i18n = createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false });
const message: SocialMessage = {
  id: "1",
  peerId: "2",
  senderId: "2",
  time: 10,
  delivery: "sent",
  kind: "text",
  text: '<img src="x" onerror="alert(1)">hello',
};

describe("social message rendering", () => {
  it("uses one centered group timestamp and a layout-independent detail timestamp", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message, own: true, timeLabel: "昨天 10:30", timeGroup: true },
      global: { plugins: [i18n], components: { SCard, SocialAvatar } },
    });
    expect(wrapper.find(".message-time-group").text()).toBe("昨天 10:30");
    expect(wrapper.find(".message-time-detail").classes()).toContain("absolute");
    expect(wrapper.findAll("time")).toHaveLength(2);
    expect(wrapper.find(".message-content > time").exists()).toBe(false);
    wrapper.unmount();
  });
  it("hides successful delivery labels and only retries a definite failed local message", async () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message: { ...message, clientId: "local-id" }, own: true, canRetry: true },
      global: { plugins: [i18n], components: { SCard, SocialAvatar } },
    });
    expect(wrapper.text()).not.toContain("social.delivery.sent");
    expect(wrapper.find(".message-retry").exists()).toBe(false);
    await wrapper.setProps({ message: { ...message, clientId: "local-id", delivery: "failed" } });
    await wrapper.find(".message-retry").trigger("click");
    expect(wrapper.emitted("retry")).toEqual([[message.id]]);
    await wrapper.setProps({ canRetry: false });
    expect(wrapper.find(".message-retry").attributes()).toHaveProperty("disabled");
    await wrapper.setProps({ message: { ...message, clientId: "local-id", delivery: "unknown" } });
    expect(wrapper.find(".message-retry").exists()).toBe(false);
    expect(wrapper.text()).toContain("social.delivery.unknown");
    await wrapper.setProps({
      own: false,
      message: { ...message, clientId: "local-id", delivery: "failed" },
    });
    expect(wrapper.find(".message-retry").exists()).toBe(false);
    wrapper.unmount();
  });
  it("renders untrusted text without creating HTML elements", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message, own: false },
      global: { plugins: [i18n], components: { SCard, SocialAvatar } },
    });
    expect(wrapper.text()).toContain(message.text);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("script").exists()).toBe(false);
  });
  it("does not advertise unverified native invitation actions as enabled", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message: { ...message, kind: "invite" }, own: false },
      global: {
        plugins: [i18n],
        components: { SCard, SocialAvatar },
        stubs: { SButton: { template: '<button :disabled="$attrs.disabled"><slot /></button>' } },
      },
    });
    expect(wrapper.find("button").attributes()).toHaveProperty("disabled");
  });
  it("shows ambiguous send status instead of an invented peer receipt", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message: { ...message, delivery: "unknown" }, own: true },
      global: { plugins: [i18n], components: { SCard, SocialAvatar } },
    });
    expect(wrapper.text()).toContain("social.delivery.unknown");
  });
  it("sizes text independently of timestamps and offers no local-ignore invitation button", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: { message: { ...message, text: "嗯嗯" }, own: true },
      global: { plugins: [i18n], components: { SCard, SocialAvatar } },
    });
    expect(wrapper.find(".message-bubble").classes()).toContain("w-fit");
    expect(wrapper.find(".message-bubble").text()).toBe("嗯嗯");
    expect(wrapper.find(".message-content").classes()).toContain("items-end");
    wrapper.unmount();
  });
  it("enlarges complete emoji sequences while keeping mixed text and unknown expressions intact", () => {
    for (const [text, emoji] of [
      ["👍🏽 👨‍👩‍👧‍👦 🇨🇳 1️⃣", true],
      ["🙂你好", false],
      ["123", false],
      ["[大笑]", false],
    ] as const) {
      const wrapper = mount(SocialMessageBubble, {
        props: { message: { ...message, text }, own: false },
        global: { plugins: [i18n], components: { SCard, SocialAvatar } },
      });
      expect(wrapper.find(".message-bubble").classes().includes("message-emoji")).toBe(emoji);
      expect(wrapper.find(".message-bubble").text()).toBe(text);
      wrapper.unmount();
    }
  });
  it("renders image attachments separately from resource tiles without an extra image-message label", () => {
    const wrapper = mount(SocialMessageBubble, {
      props: {
        message: {
          ...message,
          kind: "card",
          text: "image-message",
          card: {
            type: "image",
            title: "",
            cover: "https://p1.music.126.net/image.jpg",
            width: 600,
            height: 300,
          },
        },
        own: true,
      },
      global: { plugins: [i18n], components: { SCard, SocialAvatar, SocialMessageImage } },
    });
    expect(wrapper.findComponent(SocialMessageImage).props()).toMatchObject({
      width: 600,
      height: 300,
    });
    expect(wrapper.find(".message-resource").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("image-message");
    wrapper.unmount();
  });
});
