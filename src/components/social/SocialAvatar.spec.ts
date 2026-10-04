import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import SocialAvatar from "./SocialAvatar.vue";

describe("social avatar identity and failure recovery", () => {
  it("keeps the same image across polling snapshots and recovers when the source changes", async () => {
    const wrapper = mount(SocialAvatar, {
      props: { src: "https://p1.music.126.net/a.jpg", name: "好友" },
    });
    await flushPromises();
    const image = wrapper.find("img").element;
    for (let index = 0; index < 30; index++) await wrapper.setProps({ name: `好友 ${index}` });
    expect(wrapper.find("img").element).toBe(image);
    expect(wrapper.find("img").attributes("src")).toContain("param=80y80");
    await wrapper.find("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.text()).toContain("好");
    await wrapper.setProps({ src: "https://p1.music.126.net/b.jpg" });
    await flushPromises();
    expect(wrapper.find("img").exists()).toBe(true);
    expect(wrapper.find("img").element).not.toBe(image);
    wrapper.unmount();
  });
  it("keeps the old image while decoding and ignores an obsolete image after rapid updates", async () => {
    const tasks: { resolve: () => void; reject: (error: Error) => void }[] = [];
    vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          tasks.push({ resolve, reject });
        }),
    );
    const wrapper = mount(SocialAvatar, {
      props: { src: "https://p1.music.126.net/a.jpg", name: "好友" },
    });
    tasks[0].resolve();
    await flushPromises();
    const image = wrapper.find("img").element;
    await wrapper.setProps({ src: "https://p1.music.126.net/b.jpg" });
    expect(wrapper.find("img").attributes("src")).toContain("a.jpg");
    await wrapper.setProps({ src: "https://p1.music.126.net/c.jpg" });
    tasks[2].resolve();
    await flushPromises();
    tasks[1].resolve();
    await flushPromises();
    expect(wrapper.find("img").element).toBe(image);
    expect(wrapper.find("img").attributes("src")).toContain("c.jpg");
    await wrapper.setProps({ src: "https://p1.music.126.net/broken.jpg" });
    tasks[3].reject(new Error("unavailable"));
    await flushPromises();
    expect(wrapper.find("img").attributes("src")).toContain("c.jpg");
    await wrapper.setProps({ src: "https://p1.music.126.net/late.jpg" });
    wrapper.unmount();
    tasks[4].resolve();
    await flushPromises();
  });
});
