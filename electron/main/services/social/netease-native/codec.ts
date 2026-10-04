import { z } from "zod";
import type {
  NoticeKind,
  SocialContent,
  SocialConversation,
  SocialMessage,
  SocialNotice,
  SocialPage,
} from "@shared/types/social";

const nativeId = z
  .union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()])
  .transform(String);
const nativeUser = z.object({
  userId: nativeId,
  nickname: z.string().catch(""),
  avatarUrl: z.string().catch(""),
});
const conversationRow = z.object({
  fromUser: nativeUser,
  toUser: nativeUser,
  lastMsg: z.string(),
  lastMsgTime: z.number(),
  newMsgCount: z.number().int().nonnegative().catch(0),
});
const messageRow = z.object({
  id: nativeId,
  fromUser: nativeUser,
  msg: z.string(),
  time: z.number(),
});

/** 卡片仅接受可点击的 HTTPS 链接，协议命令仍由邀请解码器单独处理。 */
const cardUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port)
      return;
    if (url.hostname === "localhost" || /^[\d.:]+$/.test(url.hostname)) return;
    url.protocol = "https:";
    return url.href;
  } catch {
    return;
  }
};

/** 与 Windows 消息枚举一致，原始卡片内容不穿透 IPC。 */
const decodeCard = (value: Record<string, unknown>): SocialContent["card"] => {
  const types: Record<number, [NonNullable<SocialContent["card"]>["type"], string]> = {
    1: ["song", "song"],
    14: ["song", "song"],
    2: ["album", "album"],
    3: ["artist", "artist"],
    4: ["playlist", "playlist"],
    5: ["program", "program"],
    7: ["mv", "mv"],
    8: ["topic", "topic"],
    10: ["user", "user"],
    13: ["radio", "djRadio"],
    16: ["image", "picInfo"],
    23: ["general", "generalMsg"],
  };
  const mapping = types[Number(value.type)];
  if (!mapping) return;
  const [type, field] = mapping;
  const parsed = z.record(z.string(), z.unknown()).safeParse(value[field]);
  if (!parsed.success) return;
  const raw = parsed.data;
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v.length <= 2000 ? v : undefined;
  const id = nativeId.safeParse(raw.id ?? raw.userId);
  const title =
    text(raw.name ?? raw.title ?? raw.nickname ?? raw.inboxBriefContent) ||
    (type === "image" ? "" : text(value.msg));
  const album = z.record(z.string(), z.unknown()).safeParse(raw.album ?? raw.al);
  const cover = cardUrl(
    raw.picUrl ??
      raw.coverImgUrl ??
      raw.cover ??
      raw.avatarUrl ??
      (album.success ? album.data.picUrl : undefined),
  );
  if (!title && !cover) return;
  const resourceUrl: Partial<Record<NonNullable<SocialContent["card"]>["type"], string>> = {
    song: "song",
    album: "album",
    artist: "artist",
    playlist: "playlist",
    program: "program",
    mv: "mv",
    user: "user/home",
    radio: "djradio",
    topic: "topic",
  };
  const url =
    cardUrl(raw.webUrl) ||
    (id.success && resourceUrl[type]
      ? `https://music.163.com/#/${resourceUrl[type]}?id=${id.data}`
      : undefined);
  return {
    type,
    id: id.success ? id.data : undefined,
    title: title || "",
    subtitle: text(raw.subTitle ?? raw.description),
    cover,
    url,
  };
};

/** Windows 3.1.40 的通用卡片只提取房间标识，不把原始 URL 交给渲染进程。 */
const decodeInvite = (nativeUrl: string): SocialContent["invite"] => {
  try {
    const outer = new URL(nativeUrl);
    if (
      outer.protocol !== "orpheus:" ||
      outer.hostname !== "open" ||
      outer.username ||
      outer.password
    )
      return;
    if (outer.searchParams.getAll("url1").length !== 1) return;
    const inner = new URL(outer.searchParams.get("url1")!);
    if (
      inner.protocol !== "orpheus:" ||
      inner.hostname !== "nm" ||
      inner.pathname.toLowerCase() !== "/play/listentogether" ||
      inner.username ||
      inner.password
    )
      return;
    const roomId = inner.searchParams.get("roomId") || "";
    const inviterId = inner.searchParams.get("inviterId") || "";
    if (
      inner.searchParams.getAll("roomId").length !== 1 ||
      inner.searchParams.getAll("inviterId").length !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
      !/^[1-9]\d{0,19}$/.test(inviterId)
    )
      return;
    return { roomId, inviterId };
  } catch {
    return;
  }
};

/** 未验证的消息类型提供文本预览；邀请识别与接受能力分开。 */
export const decodeContent = (raw: string): SocialContent => {
  if (raw.length > 16000) return { kind: "unsupported", text: "message-too-large" };
  try {
    const value: unknown = JSON.parse(raw);
    const parsed = z
      .object({
        type: z.number(),
        msg: z.string().max(16000).optional(),
        generalMsg: z
          .object({
            nativeUrl: z.string().max(4096).optional(),
            title: z.string().max(500).optional(),
          })
          .optional(),
      })
      .passthrough()
      .safeParse(value);
    if (!parsed.success) return { kind: "unsupported", text: "unsupported-message" };
    if (parsed.data.type === 23 && parsed.data.generalMsg) {
      const invite = decodeInvite(parsed.data.generalMsg.nativeUrl || "");
      if (invite)
        return { kind: "invite", text: parsed.data.generalMsg.title || "invite-message", invite };
    }
    const card = decodeCard(parsed.data);
    if (card) return { kind: "card", text: parsed.data.msg || card.title || "image-message", card };
    return {
      kind: parsed.data.type === 6 ? "text" : "unsupported",
      text: parsed.data.msg || "unsupported-message",
    };
  } catch {
    return { kind: "text", text: raw };
  }
};

export const decodeConversations = (
  body: Record<string, unknown>,
  accountId: string,
  offset: number,
): SocialPage<SocialConversation> => {
  const response = z
    .object({ msgs: z.array(conversationRow).max(30), more: z.boolean() })
    .parse(body);
  return {
    items: response.msgs.map((item) => {
      const peer = item.fromUser.userId === accountId ? item.toUser : item.fromUser;
      return {
        peerId: peer.userId,
        name: peer.nickname,
        avatar: peer.avatarUrl,
        preview: decodeContent(item.lastMsg).text,
        content: decodeContent(item.lastMsg),
        updatedAt: item.lastMsgTime,
        unread: item.newMsgCount,
      };
    }),
    more: response.more,
    cursor: offset + response.msgs.length,
  };
};

export const decodeMessages = (
  body: Record<string, unknown>,
  peerId: string,
): SocialPage<SocialMessage> => {
  const response = z.object({ msgs: z.array(messageRow).max(30), more: z.boolean() }).parse(body);
  const items = response.msgs
    .map((item): SocialMessage => ({
      id: item.id,
      peerId,
      senderId: item.fromUser.userId,
      senderName: item.fromUser.nickname,
      senderAvatar: item.fromUser.avatarUrl,
      time: item.time,
      delivery: "sent",
      ...decodeContent(item.msg),
    }))
    .sort((a, b) => a.time - b.time);
  return { items, more: response.more, cursor: items[0]?.time ?? 0 };
};

/** 通知保留可读字段，不向渲染进程透传整个用户资料或私有 payload。 */
export const decodeNotices = (
  body: Record<string, unknown>,
  kind: NoticeKind,
  cursor: number,
): SocialPage<SocialNotice> => {
  const field = kind === "notice" ? "notices" : kind === "mention" ? "forwards" : "comments";
  const rows = z.array(z.record(z.string(), z.unknown())).max(30).parse(body[field]);
  const items = rows.map((row): SocialNotice => {
    const time = z.number().parse(row.time ?? row.timeStamp);
    const id = nativeId.parse(row.id ?? row.commentId);
    const content = row.notice ?? row.json ?? row.content ?? "";
    return {
      id: `${kind}:${id}`,
      kind,
      time,
      locallyRead: false,
      text: typeof content === "string" ? decodeContent(content).text : "unsupported-message",
    };
  });
  return {
    items,
    more: body.more === true,
    cursor:
      kind === "mention" && typeof body.lasttime === "number"
        ? body.lasttime
        : kind === "notice" && typeof body.lastTime === "number"
          ? body.lastTime
          : items.length
            ? Math.min(...items.map((item) => item.time))
            : Math.max(0, cursor),
  };
};
