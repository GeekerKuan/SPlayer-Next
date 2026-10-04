import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TogetherAvatars from "./TogetherAvatars.vue";
import SocialAvatar from "./SocialAvatar.vue";

describe("together avatar transition identity", () => {
  it("preserves the rendered images through interrupted waiting/joined changes and bounds larger rooms", async () => {
    const members = [
      { id: "1", name: "自己", avatar: "self.jpg" },
      { id: "2", name: "好友", avatar: "peer.jpg", waiting: true },
    ];
    const wrapper = mount(TogetherAvatars, {
      props: { participants: members, joined: false, visible: true },
      global: { components: { SocialAvatar } },
    });
    await flushPromises();
    const images = wrapper.findAll("img").map((item) => item.element);
    for (let index = 0; index < 10; index++) {
      await wrapper.setProps({
        joined: index % 2 === 0,
        participants: members.map((member) => ({
          ...member,
          waiting: index % 2 !== 0 && member.id === "2",
        })),
      });
      expect(wrapper.findAll("img").map((item) => item.element)).toEqual(images);
    }
    await wrapper.setProps({
      participants: [
        ...members,
        ...[3, 4, 5, 6].map((id) => ({ id: String(id), name: `成员${id}` })),
      ],
    });
    expect(wrapper.findAll(".together-avatar")).toHaveLength(3);
    expect(wrapper.find(".together-extra-count").text()).toBe("+3");
    await wrapper.setProps({ visible: false });
    expect(wrapper.find(".is-visible").exists()).toBe(false);
    wrapper.unmount();
  });
});
