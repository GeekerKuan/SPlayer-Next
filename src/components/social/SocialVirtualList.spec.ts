import { mount } from "@vue/test-utils";
import { h, nextTick, ref } from "vue";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vueuse/core", async (original) => ({
  ...(await original<typeof import("@vueuse/core")>()),
  useElementSize: () => ({ height: ref(600), width: ref(800) }),
}));
import SVirtualList from "@/components/ui/SVirtualList.vue";

describe("social virtual lists", () => {
  it.each([true, false])("bounds mounted rows with 10,000 records (fixed=%s)", async (fixed) => {
    const wrapper = mount(SVirtualList, {
      props: {
        items: Array.from({ length: 10000 }, (_, id) => ({ id })),
        itemHeight: 76,
        itemFixed: fixed,
        height: 600,
      },
      slots: {
        default: ({ item }: { item: unknown }) => h("div", String((item as { id: number }).id)),
      },
    });
    await nextTick();
    await nextTick();
    const count = wrapper.findAll("[data-index]").length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(25);
    wrapper.unmount();
  });
});
