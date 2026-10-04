import { mount, flushPromises } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it, vi } from "vitest";
import SocialMessageImage from "./SocialMessageImage.vue";
import { openExternal } from "@/utils/url";
vi.mock("@/utils/url", () => ({ openExternal: vi.fn() }));
const options = {
  global: {
    plugins: [createI18n({ legacy: false, locale: "en", missingWarn: false, fallbackWarn: false })],
  },
};
describe("message attachment display", () => {
  it("preserves portrait proportions, loads lazily and opens the original only on click", async () => {
    const source = "https://p1.music.126.net/animated.gif";
    const wrapper = mount(SocialMessageImage, {
      ...options,
      props: { src: source, width: 600, height: 1200 },
    });
    expect(wrapper.attributes("style")).toContain("140px");
    expect(wrapper.attributes("style")).toContain("600 / 1200");
    expect(wrapper.find("img").attributes("src")).toBe(source);
    expect(wrapper.find("img").attributes("loading")).toBe("lazy");
    expect(openExternal).not.toHaveBeenCalled();
    await wrapper.find("button").trigger("click");
    expect(openExternal).toHaveBeenCalledWith(source);
    wrapper.unmount();
  });
  it("offers an explicit retry for a broken image without issuing background reloads", async () => {
    const wrapper = mount(SocialMessageImage, {
      ...options,
      props: { src: "https://p1.music.126.net/a.jpg" },
    });
    const first = wrapper.find("img").element;
    await wrapper.find("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toContain("social.image.retry");
    await wrapper.find("button").trigger("click");
    expect(wrapper.find("img").element).not.toBe(first);
    wrapper.unmount();
  });
  it("ignores decoded dimensions from a replaced attachment", async () => {
    let resolve!: () => void;
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const wrapper = mount(SocialMessageImage, {
      ...options,
      props: { src: "https://p1.music.126.net/a.jpg" },
    });
    const image = wrapper.find("img").element;
    Object.defineProperties(image, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 1200 },
    });
    await wrapper.find("img").trigger("load");
    await wrapper.setProps({ src: "https://p1.music.126.net/b.jpg" });
    resolve();
    await flushPromises();
    expect(wrapper.attributes("style")).toContain("240px");
    expect(wrapper.find("img").classes()).toContain("opacity-0");
    wrapper.unmount();
  });
});
