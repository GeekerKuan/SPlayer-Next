import { beforeEach, expect, it, vi } from "vitest";
import path from "node:path";

const mocks = vi.hoisted(() => {
  const createProtocol = () => {
    const handlers = new Map<string, (request: Request) => Response | Promise<Response>>();
    return {
      handlers,
      isProtocolHandled: (scheme: string) => handlers.has(scheme),
      handle: vi.fn(
        (scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
          if (handlers.has(scheme)) throw new Error(`Failed to register protocol: ${scheme}`);
          handlers.set(scheme, handler);
        },
      ),
      registerSchemesAsPrivileged: vi.fn(),
    };
  };
  return {
    defaultProtocol: createProtocol(),
    mainProtocol: createProtocol(),
    otherProtocol: createProtocol(),
    fetch: vi.fn(async () => new Response("cached")),
    cacheDir: "",
  };
});
vi.mock("electron", () => ({
  protocol: mocks.defaultProtocol,
  session: {
    fromPartition: (partition: string) => ({
      protocol: partition === "persist:main" ? mocks.mainProtocol : mocks.otherProtocol,
    }),
  },
  net: { fetch: mocks.fetch },
}));
vi.mock("./config", () => ({ getAppCacheDir: () => mocks.cacheDir }));

import { handleCacheProtocol, handleCacheProtocolOnPartition, MAIN_PARTITION } from "./protocol";

beforeEach(() => {
  mocks.cacheDir = path.resolve("cache-root");
  for (const protocol of [mocks.defaultProtocol, mocks.mainProtocol, mocks.otherProtocol]) {
    protocol.handlers.clear();
    protocol.handle.mockClear();
  }
  mocks.fetch.mockClear();
});

it("retains session handlers across repeated registrations and window recreation", () => {
  handleCacheProtocol();
  handleCacheProtocolOnPartition(MAIN_PARTITION);
  const first = mocks.mainProtocol.handlers.get("cache");
  for (let reopen = 0; reopen < 3; reopen++) {
    handleCacheProtocol();
    handleCacheProtocolOnPartition(MAIN_PARTITION);
  }
  expect(mocks.defaultProtocol.handle).toHaveBeenCalledTimes(1);
  expect(mocks.mainProtocol.handle).toHaveBeenCalledTimes(1);
  expect(mocks.mainProtocol.handlers.get("cache")).toBe(first);
});

it("registers independent partitions without replacing an existing handler", () => {
  const existing = () => new Response("existing");
  mocks.mainProtocol.handlers.set("cache", existing);
  handleCacheProtocolOnPartition(MAIN_PARTITION);
  handleCacheProtocolOnPartition("persist:other");
  expect(mocks.mainProtocol.handle).not.toHaveBeenCalled();
  expect(mocks.mainProtocol.handlers.get("cache")).toBe(existing);
  expect(mocks.otherProtocol.handle).toHaveBeenCalledTimes(1);
});

it("can register again after an explicit unhandle without a stale process flag", () => {
  handleCacheProtocolOnPartition(MAIN_PARTITION);
  mocks.mainProtocol.handlers.delete("cache");
  handleCacheProtocolOnPartition(MAIN_PARTITION);
  expect(mocks.mainProtocol.handle).toHaveBeenCalledTimes(2);
});

it("keeps the cache path boundary and query-based cache invalidation", async () => {
  handleCacheProtocolOnPartition(MAIN_PARTITION);
  const handler = mocks.mainProtocol.handlers.get("cache")!;
  const rejected = await handler({ url: "cache://../outside.jpg" } as Request);
  expect(rejected.status).toBe(403);
  expect(mocks.fetch).not.toHaveBeenCalled();
  await handler({ url: "cache://covers/current.jpg?v=2" } as Request);
  const expected = path.join(mocks.cacheDir, "covers", "current.jpg").replace(/\\/g, "/");
  expect(mocks.fetch).toHaveBeenCalledWith(`file://${expected}`);
});
