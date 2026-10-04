import { createPlayProgress } from "../playProgress";
import type { TogetherSnapshot } from "@shared/types/together";
import type { PlayEventInput } from "@shared/types/stats";
import type { Track } from "@shared/types/player";

/** 复用宿主墙钟累计器和统计事件；未观察到的断线时段不推算、不再次向网易云打卡。 */
export const createTogetherStats = (record: (event: PlayEventInput) => void) => {
  const progress = createPlayProgress<Track>({
    onThreshold: () => {},
    thresholdMs: () => Infinity,
  });
  let current: Track | null = null;
  let startedAt = 0;
  let lastAt = 0;
  let wasPlaying = false;
  const flush = (unobservedMs = 0): void => {
    progress.setPlaying(false);
    const listenedMs = Math.floor(Math.max(0, progress.elapsedMs() - unobservedMs));
    if (current && listenedMs >= 5000) record({ track: current, startedAt, listenedMs });
    progress.reset();
    current = null;
  };
  return {
    stop: () => flush(),
    observe: (snapshot: TogetherSnapshot): void => {
      const song = snapshot.songs.find((item) => item.id === snapshot.songId);
      const now = Date.now();
      if (!snapshot.connected || !snapshot.roomId || !song) {
        flush(wasPlaying ? Math.max(0, now - lastAt) : 0);
        return;
      }
      if (current && now - lastAt > 5000) {
        flush(wasPlaying ? now - lastAt : 0);
      }
      lastAt = now;
      if (current?.id !== song.id) {
        flush();
        current = {
          id: song.id,
          source: "netease",
          title: song.name,
          artists: song.artists
            .split(" / ")
            .filter(Boolean)
            .map((name) => ({ name })),
          duration: song.durationMs,
        };
        startedAt = now;
        progress.load(song.durationMs / 1000, current, snapshot.playing);
      } else progress.setPlaying(snapshot.playing);
      wasPlaying = snapshot.playing;
    },
  };
};
