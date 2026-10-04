import { z } from "zod";
import type { TogetherSong } from "@shared/types/together";

const wireId = z.union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive().safe()]);
const id = wireId.transform(String);
export const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const roomInfoSchema = z.object({
  roomId: roomIdSchema,
  creatorId: id,
  openHeartRcmd: z.boolean().optional().catch(undefined),
  effectiveDurationMs: z.number().finite().nonnegative().optional().catch(undefined),
  roomUsers: z
    .array(
      z.object({
        userId: id,
        nickname: z.string().max(500).optional(),
        avatarUrl: z.string().max(2048).optional().catch(undefined),
      }),
    )
    .max(10),
});
export const roomStatusSchema = z.object({
  data: z.object({
    inRoom: z.boolean(),
    roomInfo: roomInfoSchema.nullish(),
  }),
});
export const roomPlaylistSchema = z.object({
  data: z.object({
    playlist: z
      .object({
        displayList: z.object({
          result: z.array(id).max(500),
          rcmdSongIds: z.array(id).max(100).optional(),
        }),
        randomList: z.object({ result: z.array(id).max(500) }).nullish(),
        version: z
          .array(
            z.object({
              userId: wireId,
              version: z.number().int().nonnegative().safe(),
              outerId: z.string().max(128).nullish(),
            }),
          )
          .max(10),
        playMode: z.enum(["ORDER_LOOP", "RANDOM", "SINGLE_LOOP"]),
        listMode: z.literal("heart").optional().catch(undefined),
      })
      .nullish()
      .transform(
        (value) =>
          value || {
            displayList: { result: [], rcmdSongIds: [] },
            version: [],
            playMode: "ORDER_LOOP" as const,
            randomList: { result: [] },
          },
      ),
    playCommand: z
      .object({
        targetSongId: id,
        commandType: z.enum(["PLAY", "PAUSE", "PROGRESS", "NEXT", "PREVIOUS", "GOTO"]),
        playStatus: z.enum(["PLAY", "PAUSE"]),
        progress: z.number().finite().min(0).max(86400000),
        clientSeq: z.number().int().nonnegative().safe(),
        serverSeq: z.number().int().nonnegative().safe(),
      })
      .nullish(),
  }),
});

/** 服务端 schema 变化与用户输入错误分开报告，不把原始响应送入日志。 */
export const parseRoomResponse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("invalid-room-response");
  return result.data;
};

/** 官方歌曲详情只保留房间展示与原生播放器所需的轻量元数据。 */
export const decodeRoomSongs = (body: Record<string, unknown>): TogetherSong[] => {
  const source = z.object({ songs: z.array(z.unknown()).max(600) }).parse(body);
  const result: TogetherSong[] = [];
  for (const value of source.songs) {
    const parsed = z
      .object({
        id,
        name: z.string().max(500),
        dt: z.number().finite().min(0).max(86400000),
        ar: z.array(z.object({ name: z.string().max(100) })).max(20),
        al: z
          .object({
            id: id.optional(),
            name: z.string().max(500).optional(),
            picUrl: z.string().url().max(2000).optional(),
          })
          .optional(),
      })
      .safeParse(value);
    if (!parsed.success) continue;
    const song = parsed.data;
    result.push({
      id: song.id,
      name: song.name,
      artists: song.ar.map((a) => a.name).join(" / "),
      durationMs: song.dt,
      ...(song.al?.picUrl ? { cover: song.al.picUrl } : {}),
    });
  }
  return result;
};

/** 写请求只接受明确的 result，HTTP 200 本身不能证明操作成功。 */
export const requireRoomResult = (body: Record<string, unknown>): void => {
  if (!z.object({ data: z.object({ result: z.literal(true) }) }).safeParse(body).success)
    throw new Error("room-operation-failed");
};
