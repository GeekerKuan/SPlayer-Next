import type { TogetherInvitation } from "../types/together";

/** 隐形标记只用于识别应用分享，不作为鉴权或房间归属依据。 */
export const TOGETHER_SHARE_MARKER = "@Splayer\u200B-Next";

export const parseTogetherLink = (raw: string): TogetherInvitation | null => {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.port) return null;
    const h5 =
      url.protocol === "https:" &&
      url.hostname === "st.music.163.com" &&
      url.pathname === "/listen-together/share/";
    const native =
      url.protocol === "orpheus:" &&
      url.hostname === "nm" &&
      url.pathname.toLowerCase() === "/play/listentogether";
    if (!h5 && !native) return null;
    const roomId = url.searchParams.get("roomId") || "";
    const inviterId = url.searchParams.get("inviterId") || "";
    if (
      url.searchParams.getAll("roomId").length !== 1 ||
      url.searchParams.getAll("inviterId").length !== 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) ||
      !/^[1-9]\d{0,19}$/.test(inviterId)
    )
      return null;
    return { roomId, inviterId };
  } catch {
    return null;
  }
};

export const isTogetherShortLink = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      url.hostname === "163cn.tv" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/[A-Za-z0-9]{1,32}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
};

/** 剪贴板只接收单个受限平台链接，普通文本、多个链接和超长内容不触发操作。 */
export const extractTogetherShare = (text: string): { url: string; marked: boolean } | null => {
  if (text.length > 8192) return null;
  const links = text.match(/(?:https:\/\/|orpheus:\/\/)[^\s<>"'\u200B-\u200D\uFEFF]+/gu) || [];
  if (links.length !== 1) return null;
  const url = links[0];
  if (!isTogetherShortLink(url) && !parseTogetherLink(url)) return null;
  return { url, marked: text.includes(TOGETHER_SHARE_MARKER) };
};
