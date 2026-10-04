import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

const mocks = vi.hoisted(() => ({ setRemote: vi.fn().mockResolvedValue(undefined) }));
const account = reactive({ profile: { userId: 1 } });
vi.mock("./user", () => ({ useUserStore: () => account }));
vi.mock("./settings", () => ({
  useSettingsStore: () => ({ system: { player: { crossDeviceResume: true } } }),
}));
vi.mock("./history", () => ({ useHistoryStore: () => ({ setRemote: mocks.setRemote }) }));
vi.mock("@/core/player", () => ({ playFrom: vi.fn() }));
import { useCrossDeviceStore } from "./crossDevice";

describe("cross-device entry refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.setRemote.mockClear();
    account.profile.userId = 1;
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        crossDevice: {
          refresh: vi.fn().mockResolvedValue({
            ok: true,
            data: { accountId: "1", records: [], canResume: true },
          }),
          cancel: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });
  it("retains history but clears a stale resume button after an explicit query failure", async () => {
    const store = useCrossDeviceStore();
    await store.refresh();
    expect(store.canResume).toBe(true);
    vi.mocked(window.api.crossDevice.refresh).mockResolvedValue({ ok: false, error: "offline" });
    await store.refresh();
    expect(store.canResume).toBe(false);
    expect(store.error).toBe("offline");
    expect(mocks.setRemote).toHaveBeenCalledTimes(1);
    expect(store.checking).toBe(false);
  });
  it("coalesces focus and manual reads and drops a late response after account cancellation", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(window.api.crossDevice.refresh).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }),
    );
    const store = useCrossDeviceStore();
    const first = store.refresh();
    const second = store.refresh();
    expect(window.api.crossDevice.refresh).toHaveBeenCalledOnce();
    expect(store.checking).toBe(true);
    store.cancel();
    account.profile.userId = 2;
    release({ ok: true, data: { accountId: "1", records: [], canResume: true } });
    await Promise.all([first, second]);
    expect(store.canResume).toBe(false);
    expect(store.error).toBe("");
    expect(store.checking).toBe(false);
    expect(mocks.setRemote).toHaveBeenCalledExactlyOnceWith("", []);
  });
  it("shows the relay-specific cooldown without removing remote history", async () => {
    vi.mocked(window.api.crossDevice.refresh).mockResolvedValue({
      ok: true,
      data: {
        accountId: "1",
        records: [],
        canResume: false,
        resumeError: "rate-limited",
      },
    });
    const store = useCrossDeviceStore();
    await store.checkResume();
    expect(store.error).toBe("rate-limited");
    expect(store.canResume).toBe(false);
    expect(mocks.setRemote).toHaveBeenCalledExactlyOnceWith("1", []);
  });
});
