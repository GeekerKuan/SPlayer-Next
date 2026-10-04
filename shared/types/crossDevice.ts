import type { Track } from "./player";
import type { SocialResult } from "./social";

export interface RemotePlayRecord {
  track: Track;
  playedAt: number;
  device?: string;
}

export type RelayPlayMode = "order" | "random" | "single_loop" | "list_loop";

export interface CrossDeviceSnapshot {
  accountId: string;
  records: RemotePlayRecord[];
  canResume: boolean;
}

export interface CrossDevicePlayback {
  tracks: Track[];
  index: number;
  playMode: RelayPlayMode;
}

export interface CrossDeviceSource {
  songIds: string[];
  currentId: string;
  playMode: RelayPlayMode;
}

export interface CrossDeviceApi {
  refresh: () => Promise<SocialResult<CrossDeviceSnapshot>>;
  resume: () => Promise<SocialResult<CrossDevicePlayback>>;
  publish: (source: CrossDeviceSource) => Promise<SocialResult<void>>;
  cancel: () => Promise<void>;
}
