import type { PlaybackContext, Track } from "@shared/types/player";
import type { NeteaseScrobbleMode } from "@shared/types/settings";
import {
  neteaseScrobbleThresholdMs,
  toNeteaseScrobbleTrack,
  type NeteaseScrobbleTrack,
} from "@shared/utils/neteaseScrobble";
import { store } from "@main/store";
import { callNetease, getNeteaseCookies } from "@main/apis/netease";
import { neteaseLog } from "@main/utils/logger";
import { createPlayProgress } from "@main/services/playProgress";

let current: NeteaseScrobbleTrack | null = null;
/** 上一次收到的源时间位置 */
let lastPositionMs = 0;
/** 当前播放轮次，用于丢弃旧请求回包 */
let cycleId = 0;
/** 当前 NCBL 曲目是否已经提交 PLV */
let ncblStarted = false;
/** 保证同一进程内 PLV、PLD 严格按播放顺序上传 */
let ncblQueue: Promise<void> = Promise.resolve();

const SHUTDOWN_FLUSH_TIMEOUT_MS = 3_000;

/** 是否看起来是网易云登录态 */
const isLoggedIn = (): boolean => Boolean(getNeteaseCookies().MUSIC_U);

/** 听歌打卡是否启用 */
const isScrobbleEnabled = (): boolean => Boolean(store.get("system.neteaseScrobbleEnabled"));

/** 当前配置启用的上报接口 */
const scrobbleApi = (): string => {
  const mode = (store.get("system.neteaseScrobbleMode") || "ncbl") as NeteaseScrobbleMode;
  return mode === "ncbl" ? "scrobble_v1" : "scrobble";
};

/** 检查接口业务码 */
const ensureScrobbleOk = (api: string, res: { body: any }): void => {
  if (res.body?.code === 200 || res.body?.data === "success") return;
  const msg = res.body?.msg || res.body?.message || JSON.stringify(res.body);
  throw new Error(`${api}: ${msg}`);
};

/** 构造听歌日志接口参数 */
const scrobbleParams = (track: NeteaseScrobbleTrack, playedSec: number) => ({
  id: track.id,
  sourceid: track.sourceId,
  source: track.sourceType,
  sourceType: track.sourceType,
  resourceType: track.resourceType,
  time: playedSec,
  total: track.durationSec,
  name: track.title,
  artist: track.artist,
  bitrate: track.bitrate,
  level: track.level,
  fee: track.fee,
});

/** 将 NCBL 请求加入串行队列，确保结束日志不会越过开始日志 */
const enqueueNcbl = (
  track: NeteaseScrobbleTrack,
  phase: "start" | "end",
  playedSec: number,
  end: "playend" | "interrupt" = "interrupt",
): void => {
  ncblQueue = ncblQueue
    .then(async () => {
      const res = await callNetease("scrobble_v1", {
        ...scrobbleParams(track, playedSec),
        phase,
        end,
      });
      ensureScrobbleOk("scrobble_v1", res);
      neteaseLog.debug(`听歌日志(${phase}): ${track.title}`);
    })
    .catch((err) => neteaseLog.warn(`听歌日志失败(${phase}):`, err));
};

/** 在音频真正开始播放时提交 PLV */
const startNcbl = (): void => {
  if (
    ncblStarted ||
    !current ||
    !isScrobbleEnabled() ||
    !isLoggedIn() ||
    scrobbleApi() !== "scrobble_v1"
  ) {
    return;
  }
  ncblStarted = true;
  enqueueNcbl(current, "start", 0);
};

/** 切歌、播放结束或退出时提交实际播放时长的 PLD */
const endNcbl = (end: "playend" | "interrupt" = "interrupt"): void => {
  if (!ncblStarted || !current) return;
  const track = current;
  const playedSec = Math.max(
    1,
    Math.min(track.durationSec, Math.round(progress.elapsedMs() / 1000)),
  );
  ncblStarted = false;
  enqueueNcbl(track, "end", playedSec, end);
};

/** 达标提交一次打卡（登录态判定在此，关着开关由 shouldFire 拦截） */
const submit = (track: NeteaseScrobbleTrack, playedMs: number): void => {
  if (!isLoggedIn()) return;
  const requestCycleId = cycleId;
  const playedSec = Math.max(1, Math.min(track.durationSec, Math.round(playedMs / 1000)));
  const api = scrobbleApi();
  if (api === "scrobble_v1") return;
  callNetease(api, {
    ...scrobbleParams(track, playedSec),
  })
    .then((res) => {
      ensureScrobbleOk(api, res);
      if (requestCycleId === cycleId) neteaseLog.debug(`听歌打卡(${api}): ${track.title}`);
    })
    .catch((err) => {
      if (requestCycleId === cycleId) neteaseLog.warn(`听歌打卡失败(${api}):`, err);
    });
};

const progress = createPlayProgress<NeteaseScrobbleTrack>({
  onThreshold: submit,
  shouldFire: isScrobbleEnabled,
  thresholdMs: neteaseScrobbleThresholdMs,
});

/**
 * 新曲目加载
 * @param track - 渲染层下发的权威 Track
 * @param context - 本次播放的来源上下文
 * @param durationMs - 引擎确认后的时长
 * @param autoPlay - 是否自动播放
 */
export const onTrackLoaded = (
  track: Track | null,
  context: PlaybackContext | undefined,
  durationMs: number,
  autoPlay: boolean,
): void => {
  endNcbl();
  cycleId++;
  current = toNeteaseScrobbleTrack(track, context, durationMs);
  progress.load(current?.durationSec ?? 0, current, autoPlay);
  lastPositionMs = 0;
  ncblStarted = false;
  if (autoPlay) {
    startNcbl();
  }
};

/**
 * 播放/暂停状态变化
 * @param playing - 是否正在播放
 */
export const onState = (playing: boolean): void => {
  progress.setPlaying(playing);
  if (playing) {
    startNcbl();
  }
};

/**
 * 播放进度推进
 * @param positionMs - 当前源时间位置
 */
export const onPosition = (positionMs: number): void => {
  // 已打卡后若用户跳回阈值之前，视为重新收听，重置本轮计时以便再次打卡
  if (current && progress.hasFired()) {
    const limit = progress.thresholdMs();
    const returnedBeforeThreshold = lastPositionMs >= limit && positionMs < limit;
    const jumpedBack = positionMs + 1000 < lastPositionMs;
    if (positionMs < limit && (returnedBeforeThreshold || jumpedBack)) {
      cycleId++;
      progress.rearm();
    }
  }
  lastPositionMs = positionMs;
  progress.tick();
};

/** 自然播放结束 */
export const onEnded = (): void => {
  endNcbl("playend");
  cycleId++;
  progress.end();
  current = null;
  lastPositionMs = 0;
  ncblStarted = false;
};

/** 应用退出前提交最后进度并清理内存状态 */
export const shutdown = async (): Promise<void> => {
  endNcbl();
  cycleId++;
  progress.reset();
  current = null;
  lastPositionMs = 0;
  ncblStarted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ncblQueue,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
