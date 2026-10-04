import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  history: vi.fn(),
  stop: vi.fn(),
  window: { webContents: { mainFrame: {}, removeListener: vi.fn(), once: vi.fn() } },
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock("@main/window/main", () => ({ getMainWindow: () => mocks.window }));
vi.mock("@main/services/social", () => ({
  socialService: { history: mocks.history, stop: mocks.stop },
}));
import { registerSocialIpc } from "./social";
const event = () => ({
  sender: mocks.window.webContents,
  senderFrame: mocks.window.webContents.mainFrame,
});
describe("social read IPC", () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.history.mockReset();
    registerSocialIpc();
  });
  it("coalesces identical reads and releases the result after completion", async () => {
    let release!: (value: unknown) => void;
    mocks.history.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const invoke = mocks.handlers.get("social:history")!;
    const first = invoke(event(), "1", 0);
    const next = invoke(event(), "1", 0);
    expect(mocks.history).toHaveBeenCalledTimes(1);
    release(["messages"]);
    expect(await first).toEqual(await next);
    mocks.history.mockResolvedValue([]);
    await invoke(event(), "1", 0);
    expect(mocks.history).toHaveBeenCalledTimes(2);
  });
  it("rejects other frames and unbounded arguments without starting requests", async () => {
    const invoke = mocks.handlers.get("social:history")!;
    expect(await invoke({ ...event(), senderFrame: {} }, "1", 0)).toEqual({
      ok: false,
      error: "forbidden",
    });
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(await invoke(event(), cyclic, 0)).toEqual({ ok: false, error: "invalid-input" });
    expect(await invoke(event(), "1".repeat(4096), 0)).toEqual({
      ok: false,
      error: "invalid-input",
    });
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("bounds concurrent distinct reads and releases the queue when the page stops", async () => {
    const releases: ((value: unknown) => void)[] = [];
    mocks.history.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const invoke = mocks.handlers.get("social:history")!;
    const pending = Array.from({ length: 16 }, (_, index) => invoke(event(), String(index + 1), 0));
    expect(await invoke(event(), "17", 0)).toEqual({ ok: false, error: "busy" });
    await mocks.handlers.get("social:stop")!(event());
    const fresh = invoke(event(), "1", 0);
    expect(mocks.history).toHaveBeenCalledTimes(17);
    releases.forEach((release) => release([]));
    await Promise.all([...pending, fresh]);
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});
