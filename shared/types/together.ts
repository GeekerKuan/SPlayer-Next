import type { SocialResult } from "./social";
export interface TogetherInvitation {
  roomId: string;
  inviterId: string;
}
export interface TogetherClipboardInvite {
  url: string;
  marked: boolean;
  invitation: TogetherInvitation | null;
}

export interface TogetherSong {
  id: string;
  name: string;
  artists: string;
  durationMs: number;
  cover?: string;
}
export interface TogetherSnapshot {
  mode?: "native" | "desktop-cdp";
  playbackOwned?: boolean;
  commandSeq?: number;
  playbackRevision?: number;
  playMode?: "ORDER_LOOP" | "RANDOM" | "SINGLE_LOOP";
  /** 仅展示已核验的服务端推荐模式，不据此推断切换参数或会员权限。 */
  recommendationMode?: "heart";
  recommendations?: TogetherSong[];
  connected: boolean;
  status: "alone" | "waiting" | "togetherOwner" | "together" | "timeout";
  roomId: string;
  members: { id: string; name: string; avatar?: string }[];
  /** 服务端累计的有效一起听时长，缺失时不以本地墙钟代替。 */
  effectiveDurationMs?: number;
  songs: TogetherSong[];
  songId: string;
  playing: boolean;
  progressMs: number;
  updatedAt: number;
  error?: string;
}
export type TogetherControl =
  | { action: "pause" | "resume" | "next" | "previous" }
  | { action: "seek"; positionMs: number }
  | { action: "goto"; songId: string };
export interface TogetherApi {
  chooseClient: () => Promise<SocialResult<string>>;
  connect: (chooseClient?: boolean) => Promise<SocialResult<TogetherSnapshot>>;
  stop: () => Promise<SocialResult<void>>;
  create: (peerId?: string) => Promise<SocialResult<TogetherSnapshot>>;
  invite: (peerId: string) => Promise<SocialResult<TogetherSnapshot>>;
  invitationLink: () => Promise<SocialResult<string>>;
  replace: (expectedRoomId: string) => Promise<SocialResult<TogetherSnapshot>>;
  takeOver: (expectedRoomId: string) => Promise<SocialResult<TogetherSnapshot>>;
  closeExternal: (expectedRoomId: string) => Promise<SocialResult<TogetherSnapshot>>;
  joinLink: (invitation: TogetherInvitation) => Promise<SocialResult<TogetherSnapshot>>;
  readClipboardInvite: () => Promise<SocialResult<TogetherClipboardInvite | null>>;
  openInviteLink: (url: string) => Promise<SocialResult<void>>;
  accept: (peerId: string, messageId: string) => Promise<SocialResult<TogetherSnapshot>>;
  leave: () => Promise<SocialResult<TogetherSnapshot>>;
  control: (input: TogetherControl) => Promise<SocialResult<TogetherSnapshot>>;
  recommendations: () => Promise<SocialResult<TogetherSong[]>>;
  add: (songId: string) => Promise<SocialResult<TogetherSnapshot>>;
  onUpdate: (callback: (snapshot: TogetherSnapshot) => void) => () => void;
}
