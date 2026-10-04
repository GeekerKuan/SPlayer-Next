import type { Track } from "@shared/types/player";
import type { TogetherSnapshot } from "@shared/types/together";
import { useMediaStore } from "@/stores/media";
import { useStatusStore } from "@/stores/status";
import * as queue from "@/stores/queue";
import { load, seekLocally, clearLocalSeek, invalidatePlaybackOperation } from "@/core/player";
import { resolveTrackSource } from "./audioSource";
import { getCurrentTime, setCurrentTime, setDuration, setPlaying } from "./playback";
import { setTogetherSession } from "./togetherSession";
import { beginLoad as beginLyricLoad } from "./lyric/loader";

let pending: { snapshot: TogetherSnapshot; seekEcho: boolean } | null = null;
let applying = false;
let generation = 0;
let roomId = "";
let appliedSeq = -1;
let queueKey = "";
let identity = "";
let failedKey = "";
let retryAt = 0;
let reportError: ((error: string) => void) | undefined;
let localSeekPending = false;
let localSeekSerial = 0;

/** 在主进程停止普通音频前记录记忆位置；已在房间中时不会覆盖原队列状态。 */
export const prepareTogetherPlayback = (): void => {
  const status = useStatusStore();
  queue.prepareTemporaryPlayback({
    playIndex: status.playIndex,
    position: status.position,
    duration: status.duration,
    repeatMode: status.repeatMode,
    shuffleMode: status.shuffleMode,
    heartMode: status.heartMode,
    fmMode: status.fmMode,
  });
};
export const discardPreparedTogetherPlayback = (): void => {
  queue.discardPreparedPlayback();
};
const restoreRoomQueue = (): void => {
  const previous = queue.restoreTemporaryQueue();
  if (!previous) return;
  invalidatePlaybackOperation();
  // 退出房间后，旧歌词请求也必须失效，避免迟到内容写入恢复的普通歌曲。
  beginLyricLoad();
  const status = useStatusStore();
  Object.assign(status, previous, { currentSource: null, state: "stopped", trackLoading: false });
  const media = useMediaStore();
  media.clear();
  const entry = queue.getQueueItem(previous.playIndex);
  if (entry) {
    media.setTrack(entry.track);
    media.setPlaybackContext(entry.context);
  } else {
    status.playIndex = -1;
    status.position = 0;
    status.duration = 0;
  }
  setPlaying(false);
  setDuration(status.duration);
  setCurrentTime(status.position, { force: true });
};

/** 合并迟到快照并复用原生加载链，歌词、SMTC 和听歌时长随实际音频更新。 */
export const applyTogetherPlayback = (
  snapshot: TogetherSnapshot,
  onError?: (error: string) => void,
  localSeek = false,
  seekEcho = false,
): void => {
  if (localSeek) {
    localSeekPending = true;
    localSeekSerial++;
    generation++;
  }
  if (onError) reportError = onError;
  setTogetherSession(snapshot);
  const nextIdentity = `${snapshot.roomId}:${snapshot.playbackRevision ?? snapshot.commandSeq ?? 0}:${snapshot.playbackOwned}:${snapshot.connected}:${snapshot.songId}:${snapshot.awaitingNext}`;
  if (nextIdentity !== identity) {
    generation++;
    identity = nextIdentity;
  }
  if ((snapshot.mode !== "native" || !snapshot.playbackOwned) && queue.getTemporaryPlaybackState())
    restoreRoomQueue();
  pending = { snapshot, seekEcho };
  if (!applying) void drain();
};
const drain = async (): Promise<void> => {
  applying = true;
  try {
    while (pending) {
      const { snapshot, seekEcho } = pending;
      pending = null;
      const token = generation;
      const seekSerial = localSeekSerial;
      if (snapshot.mode !== "native" || !snapshot.playbackOwned) {
        localSeekPending = false;
        clearLocalSeek();
        roomId = "";
        appliedSeq = -1;
        queueKey = "";
        // 连接过程的只读快照不取消预备状态；拥有的房间结束后才释放临时队列。
        if (queue.getTemporaryPlaybackState()) restoreRoomQueue();
        continue;
      }
      if (!snapshot.connected) {
        localSeekPending = false;
        clearLocalSeek();
        await window.api.player.pause();
        continue;
      }
      if (snapshot.roomId !== roomId) {
        roomId = snapshot.roomId;
        appliedSeq = -1;
        queueKey = "";
      }
      const tracks: Track[] = snapshot.songs.map((song) => ({
        id: song.id,
        source: "netease",
        title: song.name,
        artists: [{ name: song.artists }],
        duration: song.durationMs,
        cover: song.cover,
      }));
      const context = {
        provider: "netease" as const,
        originType: "page" as const,
        originId: roomId,
        originName: "一起听歌",
      };
      const status = useStatusStore();
      const media = useMediaStore();
      const key = tracks.map((t) => t.id).join(",");
      if (key !== queueKey || !queue.getTemporaryPlaybackState()) {
        queue.setTemporaryQueue(tracks, context, {
          playIndex: status.playIndex,
          position: status.position,
          duration: status.duration,
          repeatMode: status.repeatMode,
          shuffleMode: status.shuffleMode,
          heartMode: status.heartMode,
          fmMode: status.fmMode,
        });
        queueKey = key;
      }
      status.fmMode = false;
      status.heartMode = false;
      status.shuffleMode = "off";
      status.repeatMode = snapshot.playMode === "SINGLE_LOOP" ? "one" : "list";
      const index = tracks.findIndex((t) => t.id === snapshot.songId);
      if (index < 0) {
        localSeekPending = false;
        continue;
      }
      status.playIndex = index;
      const track = tracks[index];
      if (snapshot.awaitingNext) {
        localSeekPending = false;
        clearLocalSeek();
        continue;
      }
      const revision = snapshot.playbackRevision ?? snapshot.commandSeq ?? 0;
      const newCommand = revision > appliedSeq;
      if (
        media.track?.source !== "netease" ||
        media.track.id !== track.id ||
        !status.currentSource ||
        ["idle", "stopped"].includes(status.state)
      ) {
        const failureKey = `${snapshot.roomId}:${track.id}:${revision}`;
        if (failedKey === failureKey && Date.now() < retryAt) {
          reportError?.("room-audio-unavailable");
          continue;
        }
        const source = await resolveTrackSource(track, { officialOnly: true, silent: true });
        if (token !== generation) continue;
        if (!source) {
          failedKey = failureKey;
          retryAt = Date.now() + 15000;
          reportError?.("room-audio-unavailable");
          await window.api.player.pause();
          status.state = "paused";
          continue;
        }
        media.setTrack(track);
        media.setPlaybackContext(context);
        const result = await load(source.source, false, track, {
          context,
          suppressErrorToast: true,
        });
        if (token !== generation) continue;
        if (!result.ok) {
          failedKey = failureKey;
          retryAt = Date.now() + 15000;
          reportError?.("room-audio-unavailable");
          continue;
        }
        failedKey = "";
        reportError?.("");
      }
      if (
        localSeekPending ||
        // 本机拖动的确认回声只在明显偏离时校准，避免 ACK 再次打断解码。
        (newCommand && !seekEcho) ||
        Math.abs(getCurrentTime() - snapshot.progressMs) > 3000
      ) {
        if (token !== generation) continue;
        await seekLocally(Math.round(snapshot.progressMs));
        if (seekSerial === localSeekSerial) localSeekPending = false;
      }
      if (token !== generation) continue;
      if (snapshot.playing && !status.isPlaying) await window.api.player.play();
      else if (!snapshot.playing && status.isPlaying) await window.api.player.pause();
      appliedSeq = revision;
    }
  } catch (error) {
    console.warn("[together] 播放同步失败", error);
  } finally {
    applying = false;
    if (pending) void drain();
  }
};

/** 销毁前端订阅时取消等待中的加载效果与 seek 截止保护，不替用户退出房间。 */
export const disposeTogetherPlayback = (): void => {
  generation++;
  pending = null;
  roomId = "";
  appliedSeq = -1;
  queueKey = "";
  identity = "";
  failedKey = "";
  retryAt = 0;
  reportError = undefined;
  localSeekPending = false;
  localSeekSerial++;
  clearLocalSeek();
  restoreRoomQueue();
};
