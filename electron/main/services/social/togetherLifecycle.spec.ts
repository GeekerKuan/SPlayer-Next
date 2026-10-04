import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TogetherSnapshot } from "@shared/types/together";

const mocks = vi.hoisted(() => ({
  windowDestroyed: false,
  contentsDestroyed: false,
  send: vi.fn(),
  nativeStop: vi.fn(),
  desktopStop: vi.fn(),
  nativeConnect: vi.fn(),
  desktopConnect: vi.fn(),
  configuredMode: "native",
}));
const state: TogetherSnapshot = {
  connected: false,
  status: "alone",
  roomId: "",
  members: [],
  songs: [],
  songId: "",
  playing: false,
  progressMs: 0,
  updatedAt: 0,
};
vi.mock("@main/window/main", () => ({
  getMainWindow: () => ({
    isDestroyed: () => mocks.windowDestroyed,
    isVisible: () => {
      if (mocks.windowDestroyed) throw new Error("Object has been destroyed");
      return true;
    },
    isMinimized: () => false,
    webContents: { isDestroyed: () => mocks.contentsDestroyed, send: mocks.send },
  }),
}));
vi.mock("@main/apis/netease", () => ({
  getNeteaseCookies: () => ({}),
  mergeNeteaseCookies: vi.fn(),
}));
vi.mock("@main/store", () => ({ store: { get: () => mocks.configuredMode } }));
vi.mock("@main/utils/proxy", () => ({ fetchWithProxy: vi.fn() }));
vi.mock("@main/services/engine", () => ({ getPlayer: vi.fn() }));
vi.mock("@main/utils/logger", () => ({ coreLog: { warn: vi.fn() } }));
vi.mock("@main/services/nowPlaying", () => ({ lightSnapshot: vi.fn() }));
vi.mock("@main/database/playStats", () => ({ insertPlayEvent: vi.fn() }));
vi.mock("./index", () => ({ socialService: { snapshot: vi.fn() } }));
vi.mock("./roomSession", () => ({ loadRoomResume: vi.fn(), saveRoomResume: vi.fn() }));
vi.mock("./nativeTogetherService", () => ({
  NativeTogetherService: class {
    constructor(private options: { update: (value: TogetherSnapshot) => void }) {}
    stop() {
      mocks.nativeStop();
      this.options.update({ ...state, mode: "native" });
    }
    snapshot() {
      return state;
    }
    async connect() {
      mocks.nativeConnect();
      return { ...state, mode: "native" };
    }
  },
}));
vi.mock("./togetherService", () => ({
  TogetherService: class {
    constructor(private options: { update: (value: TogetherSnapshot) => void }) {}
    stop() {
      mocks.desktopStop();
      this.options.update(state);
    }
    async connect() {
      mocks.desktopConnect();
      return state;
    }
  },
}));
import { togetherService } from "./together";

describe("together shutdown publication", () => {
  beforeEach(() => {
    mocks.windowDestroyed = false;
    mocks.contentsDestroyed = false;
    mocks.configuredMode = "native";
  });
  it("stops both transports without sending to destroyed WebContents", () => {
    mocks.contentsDestroyed = true;
    mocks.send.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    expect(() => togetherService.stop()).not.toThrow();
    expect(mocks.nativeStop).toHaveBeenCalledOnce();
    expect(mocks.desktopStop).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not access visibility or send after the window is destroyed", () => {
    mocks.windowDestroyed = true;
    expect(() => togetherService.stop()).not.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("still publishes the stop snapshot while the window is alive", () => {
    mocks.send.mockImplementation(() => {});
    togetherService.stop();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][0]).toBe("together:update");
  });
  it.each(["darwin", "linux"])(
    "%s always uses independent mode when importing Windows CDP preferences",
    async (platform) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        Object.defineProperty(process, "platform", { value: platform });
        mocks.configuredMode = "desktop-cdp";
        const snapshot = await togetherService.connect();
        expect(snapshot.mode).toBe("native");
        expect(mocks.nativeConnect).toHaveBeenCalledOnce();
        expect(mocks.desktopConnect).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, "platform", descriptor);
      }
    },
  );
});
