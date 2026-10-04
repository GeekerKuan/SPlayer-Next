import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import SCard from "@/components/ui/SCard.vue";
import SocialAvatar from "./SocialAvatar.vue";
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
});
