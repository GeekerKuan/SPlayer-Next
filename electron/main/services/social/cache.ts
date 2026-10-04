import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { socialCacheDir } from "@main/utils/paths";
import type { SocialSnapshot } from "@shared/types/social";
import type { SocialCache } from "./service";

let writeQueue = Promise.resolve();
let pendingWrite: { target: string; text: string } | null = null;
let writing = false;
const cachePath = (accountId: string): string =>
  path.join(socialCacheDir, createHash("sha256").update(accountId).digest("hex") + ".bin");
const available = (): boolean =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");

/** 最多保留一次在途和一次最新写入，退出删除在写入之后执行。 */
export const socialCache: SocialCache = {
  async load(accountId) {
    if (!available()) return null;
    await writeQueue;
    try {
      const bytes = await readFile(cachePath(accountId));
      if (bytes.byteLength > 3 * 1024 * 1024) return null;
      const value = JSON.parse(safeStorage.decryptString(bytes)) as {
        version: number;
        snapshot: SocialSnapshot;
      };
      if (value.version !== 1 || value.snapshot.accountId !== accountId) return null;
      return value.snapshot;
    } catch {
      return null;
    }
  },
  save(snapshot) {
    if (!available()) return Promise.resolve();
    const text = JSON.stringify({ version: 1, snapshot });
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return Promise.resolve();
    const target = cachePath(snapshot.accountId);
    pendingWrite = { target, text };
    if (writing) return writeQueue;
    writing = true;
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          await mkdir(socialCacheDir, { recursive: true });
          while (pendingWrite) {
            const next = pendingWrite;
            pendingWrite = null;
            await writeFile(next.target + ".tmp", safeStorage.encryptString(next.text));
            await rename(next.target + ".tmp", next.target);
          }
        } finally {
          writing = false;
          pendingWrite = null;
        }
      });
    return writeQueue;
  },
  remove(accountId) {
    writeQueue = writeQueue.catch(() => {}).then(() => rm(cachePath(accountId), { force: true }));
    return writeQueue;
  },
};
