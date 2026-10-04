import type { RemotePlayRecord } from "../types/crossDevice";

/** 跨设备历史只合并展示，不能变成本机播放次数或有效听歌时长。 */
export const mergePlayHistory = (
  local: RemotePlayRecord[],
  remote: RemotePlayRecord[],
  hidden: Record<string, number>,
): RemotePlayRecord[] => {
  const latest = new Map<string, RemotePlayRecord>();
  for (const item of [...local, ...remote]) {
    const key = `${item.track.source}:${item.track.id}`;
    if (item.playedAt <= (hidden[key] ?? 0)) continue;
    if (!latest.has(key) || latest.get(key)!.playedAt < item.playedAt) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => b.playedAt - a.playedAt).slice(0, 500);
};
