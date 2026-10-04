import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import SVirtualList from "./SVirtualList.vue";

vi.mock("@vueuse/core", () => ({
  useElementSize: () => ({ height: ref(200), width: ref(300) }),
  useResizeObserver: () => ({ stop: () => {} }),
}));

describe("chat virtual list anchoring", () => {
  it("preserves a visible message across keyed prepends and keeps ordinary lists bounded", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
      this: HTMLElement,
      options: ScrollToOptions | number,
    ) {
      this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return {
        height: this.dataset.index === undefined ? 200 : 50,
        width: 300,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 300,
        bottom: 50,
        toJSON: () => ({}),
      };
    });
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const wrapper = mount(SVirtualList, {
      props: {
        items,
        itemHeight: 50,
        getItemKey: (item: unknown) => (item as { id: number }).id,
        preserveAnchor: true,
      },
      slots: { default: "<span>{{ params.item.id }}</span>" },
    });
    await flushPromises();
    const list = wrapper.vm as unknown as {
      scrollTo: (top: number) => void;
      getScrollTop: () => number;
      getItemTop: (index: number) => number;
      scrollToBottom: () => void;
    };
    list.scrollTo(1010);
    await flushPromises();
    const before = list.getItemTop(20) - list.getScrollTop();
    await wrapper.setProps({ items: [{ id: -2 }, { id: -1 }, ...items] });
    await flushPromises();
    expect(list.getItemTop(22) - list.getScrollTop()).toBe(before);
    expect(wrapper.findAll("[data-index]").length).toBeLessThan(30);
    await wrapper.setProps({ followBottom: true });
    await flushPromises();
    expect(list.getScrollTop()).toBe(102 * 50 - 200);
    await wrapper.setProps({ items: [...wrapper.props("items"), { id: 100 }] });
    await flushPromises();
    expect(list.getScrollTop()).toBe(103 * 50 - 200);
    wrapper.unmount();
    const count = scroll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(scroll.mock.calls.length).toBe(count);
  });
});
