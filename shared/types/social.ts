export type NoticeKind = "notice" | "mention" | "comment";
export type SocialResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SocialContent {
  kind: "text" | "invite" | "card" | "unsupported";
  text: string;
  invite?: { roomId: string; inviterId: string };
  card?: {
    type:
      | "song"
      | "album"
      | "artist"
      | "playlist"
      | "program"
      | "mv"
      | "topic"
      | "user"
      | "radio"
      | "image"
      | "general";
    id?: string;
    title: string;
    subtitle?: string;
    cover?: string;
    width?: number;
    height?: number;
    url?: string;
  };
}

export interface SocialConversation {
  peerId: string;
  name: string;
  avatar: string;
  preview: string;
  updatedAt: number;
  unread: number;
  content?: SocialContent;
}

export interface SocialMessage extends SocialContent {
  id: string;
  peerId: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  time: number;
  delivery: "sent" | "sending" | "failed" | "unknown";
  clientId?: string;
}

export interface SocialNotice {
  id: string;
  kind: NoticeKind;
  text: string;
  time: number;
  locallyRead: boolean;
}

export interface SocialPage<T> {
  items: T[];
  more: boolean;
  cursor: number;
}

export interface SocialSnapshot {
  accountId: string;
  conversations: SocialConversation[];
  messages: Record<string, SocialMessage[]>;
  notices: SocialNotice[];
  readTimes: Record<string, number>;
  status: "online" | "offline" | "auth-required";
  error?: string;
  updatedAt: number;
  capabilities: { nativeReadReceipt: false; together: false; transport: "eapi-poll" };
}

export interface SocialSendInput {
  peerId: string;
  text: string;
  clientId: string;
}

export interface SocialApi {
  start: () => Promise<SocialResult<SocialSnapshot>>;
  stop: () => Promise<void>;
  snapshot: () => Promise<SocialResult<SocialSnapshot>>;
  refresh: () => Promise<SocialResult<SocialSnapshot>>;
  open: (peerId: string) => Promise<SocialResult<SocialPage<SocialMessage>>>;
  conversations: (offset: number) => Promise<SocialResult<SocialPage<SocialConversation>>>;
  history: (peerId: string, before: number) => Promise<SocialResult<SocialPage<SocialMessage>>>;
  notifications: (
    kind: NoticeKind,
    cursor: number,
  ) => Promise<SocialResult<SocialPage<SocialNotice>>>;
  send: (input: SocialSendInput) => Promise<SocialResult<SocialMessage>>;
  retry: (messageId: string) => Promise<SocialResult<SocialMessage>>;
  localRead: (peerId: string, time: number) => Promise<SocialResult<SocialSnapshot>>;
  localReadNotices: (kind: NoticeKind, time: number) => Promise<SocialResult<SocialSnapshot>>;
  dismissInvite: (peerId: string, messageId: string) => Promise<SocialResult<SocialSnapshot>>;
  onUpdate: (callback: (snapshot: SocialSnapshot) => void) => () => void;
  onNavigate: (callback: (peerId: string) => void) => () => void;
}
