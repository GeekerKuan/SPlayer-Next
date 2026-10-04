import { safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { socialCacheDir } from "@main/utils/paths";

const schema = z
  .object({
    accountId: z.string().regex(/^[1-9]\d{0,19}$/),
    roomId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    joinedAt: z.number().int().positive(),
  })
  .strict();
export type RoomResume = z.infer<typeof schema>;
const target = path.join(socialCacheDir, "together-room.bin");
let queue = Promise.resolve();
const available = (): boolean =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text");

/** 只恢复本机已验证加入的房间；不缓存音频、Cookie 或待重放的控制。 */
export const loadRoomResume = async (): Promise<RoomResume | null> => {
  if (!available()) return null;
  await queue;
  try {
    const bytes = await readFile(target);
    if (bytes.length > 4096) return null;
    const result = schema.parse(JSON.parse(safeStorage.decryptString(bytes)));
    return Date.now() - result.joinedAt < 12 * 60 * 60 * 1000 ? result : null;
  } catch {
    return null;
  }
};
export const saveRoomResume = (value: RoomResume | null): Promise<void> => {
  queue = queue
    .catch(() => {})
    .then(async () => {
      if (!value) {
        await rm(target, { force: true });
        return;
      }
      if (!available()) return;
      const text = JSON.stringify(schema.parse(value));
      await mkdir(socialCacheDir, { recursive: true });
      await writeFile(target + ".tmp", safeStorage.encryptString(text));
      await rename(target + ".tmp", target);
    });
  return queue;
};
