import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  quitting: false,
  create: vi.fn(),
  closed: null as (() => void) | null,
}));
vi.mock("electron", () => ({ BrowserWindow: {}, shell: { openExternal: vi.fn() } }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: true } }));
vi.mock("./create", () => ({ createWindow: mocks.create }));
vi.mock("@main/services/thumbar", () => ({ initThumbar: vi.fn() }));
vi.mock("@main/services/thumbnail", () => ({ enableTaskbarThumbnail: vi.fn() }));
vi.mock("@main/services/tray", () => ({ initTray: vi.fn() }));
vi.mock("@main/store", () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock("@main/utils/protocol", () => ({ MAIN_PARTITION: "persist:main" }));
vi.mock("@main/utils/lifecycle", () => ({ isAppQuitting: () => mocks.quitting }));
vi.mock("@main/utils/broadcast", () => ({ broadcast: vi.fn() }));
vi.mock("@main/utils/config", () => ({ isWin: false }));

beforeEach(() => {
  vi.resetModules();
  mocks.quitting = false;
  mocks.closed = null;
  mocks.create.mockReset();
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
  mocks.create.mockImplementation(() => ({
    isDestroyed: () => false,
    once: vi.fn(),
    on: (event: string, callback: () => void) => {
      if (event === "closed") mocks.closed = callback;
    },
    webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    loadURL: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllEnvs());

it("reuses a live main window and can reopen after closed without registering protocols", async () => {
  const { createMainWindow, getMainWindow } = await import("./main");
  const first = createMainWindow();
  expect(createMainWindow()).toBe(first);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  mocks.closed!();
  expect(getMainWindow()).toBeNull();
  expect(createMainWindow()).not.toBe(first);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});

it("does not create a new renderer during application shutdown", async () => {
  const { createMainWindow, getMainWindow } = await import("./main");
  createMainWindow();
  mocks.quitting = true;
  mocks.closed!();
  for (let activation = 0; activation < 3; activation++) expect(createMainWindow()).toBeNull();
  expect(getMainWindow()).toBeNull();
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
