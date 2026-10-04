import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSocialStore } from "./social";
import type { SocialSnapshot } from "@shared/types/social";

const state = (id = "1"): SocialSnapshot => ({
  accountId: id,
  conversations: [],
  messages: {},
  notices: [],
  readTimes: {},
  status: "online",
  updatedAt: 0,
  capabilities: { nativeReadReceipt: false, together: false, transport: "eapi-poll" },
});
describe("social store", () => {
  let update: (snapshot: SocialSnapshot) => void;
  const cancel = vi.fn();
  const stop = vi.fn(async () => {});
  const send = vi.fn(async () => ({ ok: true, data: { delivery: "sent" } }));
  beforeEach(() => {
    setActivePinia(createPinia());
    cancel.mockClear();
    stop.mockClear();
    send.mockClear();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        social: {
          onUpdate: (callback: typeof update) => {
            update = callback;
            return cancel;
          },
          start: async () => ({ ok: true, data: state() }),
          stop,
          send,
        },
      },
    });
  });
  it("unsubscribes and stops the main poller when the page closes", async () => {
    const store = useSocialStore();
    await store.start();
    store.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it("clears drafts and the selected peer on account switch", async () => {
    const store = useSocialStore();
    await store.start();
    store.selected = "2";
    store.draft = "private";
    update(state("3"));
    expect(store.selected).toBe("");
    expect(Object.keys(store.drafts)).toHaveLength(0);
  });
  it("retains a draft when sending returns an unknown result", async () => {
    send.mockResolvedValueOnce({ ok: true, data: { delivery: "unknown" } });
    const store = useSocialStore();
    await store.start();
    store.selected = "2";
    store.draft = "hello";
    await store.send();
    expect(store.draft).toBe("hello");
    expect(store.error).toBe("send-unknown");
  });
  it("blocks blank messages before reaching IPC", async () => {
    const store = useSocialStore();
    await store.start();
    store.selected = "2";
    store.draft = "\u200B";
    await store.send();
    expect(send).not.toHaveBeenCalled();
    expect(store.error).toBe("empty-message");
  });
});
