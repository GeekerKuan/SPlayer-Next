import { z } from "zod";
import type { Track } from "@shared/types/player";
import type { RemotePlayRecord } from "@shared/types/crossDevice";

const id = z
  .union([z.string().regex(/^[1-9]\d{0,19}$/), z.number().int().positive()])
  .transform(String);
const song = z.object({
  id,
  name: z.string().max(1000),
  dt: z.number().nonnegative(),
  ar: z.array(z.object({ id, name: z.string().max(500) })).max(100),
  al: z.object({ id, name: z.string().max(1000), picUrl: z.string().max(4096).optional() }),
  fee: z
    .union([z.literal(0), z.literal(1), z.literal(4), z.literal(8)])
    .optional()
    .catch(undefined),
});

/** 原生最近播放返回 Unix 毫秒，不用排行榜顺序推测播放时间。 */
export const decodeRecentSongs = (body: Record<string, unknown>): RemotePlayRecord[] => {
  const data = z.object({ data: z.object({ list: z.array(z.unknown()).max(300) }) }).parse(body);
  const result = new Map<string, RemotePlayRecord>();
  for (const value of data.data.list) {
    const row = z
      .object({
        playTime: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        data: song,
        multiTerminalInfo: z.object({ os: z.string().max(40).optional() }).optional(),
      })
      .safeParse(value);
    if (!row.success) continue;
    const item = row.data;
    const s = item.data;
    const track: Track = {
      id: s.id,
      source: "netease",
      title: s.name,
      duration: s.dt,
      artists: s.ar.map((artist) => ({ ...artist, source: "netease" })),
      album: { id: s.al.id, name: s.al.name },
      fee: s.fee,
    };
    if (s.al.picUrl && z.url().safeParse(s.al.picUrl).success && /^https?:\/\//.test(s.al.picUrl)) {
      const url = new URL(s.al.picUrl);
      url.protocol = "https:";
      track.coverOriginal = url.href;
      url.searchParams.set("param", "300y300");
      track.cover = url.href;
    }
    if (item.playTime > (result.get(s.id)?.playedAt ?? 0)) {
      result.set(s.id, { track, playedAt: item.playTime, device: item.multiTerminalInfo?.os });
    }
  }
  return [...result.values()].sort((a, b) => b.playedAt - a.playedAt);
};

export const decodeRelaySongs = (body: Record<string, unknown>): Track[] => {
  const values = z.object({ songs: z.array(z.unknown()).max(1000) }).parse(body).songs;
  return decodeRecentSongs({
    data: { list: values.slice(0, 300).map((data) => ({ data, playTime: 1 })) },
  }).map((item) => item.track);
};
