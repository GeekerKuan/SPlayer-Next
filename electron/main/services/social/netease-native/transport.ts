import { createCipheriv, createHash, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** 此表只描述社交通道，不路由到原有音乐 API 模块。 */
export const nativeEndpoints = {
  account: "/api/w/nuser/account/get",
  userDetail: "/api/w/v1/user/detail/",
  conversations: "/api/msg/private/users",
  history: "/api/msg/private/history",
  send: "/api/msg/private/send",
  notice: "/api/msg/notices",
  mention: "/api/forwards/get",
  comment: "/api/v1/user/comments/",
  recommendations: "/api/v3/discovery/recommend/songs",
  roomStatus: "/api/listen/together/status/get",
  roomCheck: "/api/listen/together/room/check",
  roomPlaylist: "/api/listen/together/sync/playlist/get",
  roomCreate: "/api/listen/together/room/create",
  roomAccept: "/api/listen/together/play/invitation/accept",
  roomLeave: "/api/listen/together/end/v2",
  roomHeartbeat: "/api/listen/together/heartbeat",
  roomCommand: "/api/listen/together/play/command/report",
  roomAdd: "/api/listen/together/sync/list/command/report",
  roomInvite: "/api/listen/together/invite/message/send",
  shortLink: "/api/middle/shorturl/generate",
  roomSongs: "/api/v3/song/detail",
  recentSongs: "/api/play-record/song/list",
  relayConfig: "/api/relay/config/get",
  relayPosition: "/api/link/position/show/resource",
  relayPull: "/api/relay/play/pull",
  relayPlaylist: "/api/v6/playlist/detail",
  relaySubmitSource: "/api/relay/songlist/submit",
  relaySubmitState: "/api/relay/play/state/submit",
} as const;

export type NativeOperation = keyof typeof nativeEndpoints;
export interface NativeTransport {
  call: (
    operation: NativeOperation,
    data: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

/**
 * eapi 的签名路径与 HTTP 路径不同，必须在变换路径前签名。
 * @param path - /api 开头的签名路径
 * @param data - 业务参数和 PC header
 * @returns URL 编码的密文表单
 */
export const encodeNativeEapi = (path: string, data: Record<string, unknown>): string => {
  const text = JSON.stringify(data);
  const digest = createHash("md5").update(`nobody${path}use${text}md5forencrypt`).digest("hex");
  const cipher = createCipheriv("aes-128-ecb", Buffer.from("e82ckenh8dichen8"), null);
  const encrypted = Buffer.concat([
    cipher.update(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, "utf8"),
    cipher.final(),
  ]);
  return new URLSearchParams({ params: encrypted.toString("hex").toUpperCase() }).toString();
};

export class NativeSocialError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface NativeTransportOptions {
  cookies: () => Record<string, string>;
  mergeCookies: (cookies: Record<string, string>) => void;
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** 创建固定域名的 PC eapi 传输，只读请求可重试，发送永不自动重放。 */
export const createNativeTransport = (options: NativeTransportOptions): NativeTransport => ({
  async call(operation, data, signal) {
    const cookies = options.cookies();
    if (!cookies.MUSIC_U) throw new NativeSocialError("auth-required");
    let path: string = nativeEndpoints[operation];
    if (operation === "comment") path += String(data.uid);
    // 复用原项目 user_detail_new 的 eapi 路径和参数，限定数字 ID。
    if (operation === "userDetail") {
      if (!/^[1-9]\d{0,19}$/.test(String(data.userId)))
        throw new NativeSocialError("invalid-input");
      path += String(data.userId);
    }
    const header: Record<string, string> = {
      os: "pc",
      appver: "3.1.29.205117",
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      channel: "netease",
      deviceId: cookies.deviceId || "",
      __csrf: cookies.__csrf || "",
      MUSIC_U: cookies.MUSIC_U,
      requestId: `${Date.now()}_${randomInt(10000).toString().padStart(4, "0")}`,
    };
    if (cookies.NMTID) header.NMTID = cookies.NMTID;
    const body = encodeNativeEapi(path, {
      ...data,
      csrf_token: cookies.__csrf || "",
      e_r: false,
      header,
    });
    const mutation = [
      "send",
      "roomCreate",
      "roomAccept",
      "roomLeave",
      "roomHeartbeat",
      "roomCommand",
      "roomAdd",
      "roomInvite",
      "shortLink",
      "relayPull",
      "relaySubmitSource",
      "relaySubmitState",
    ].includes(operation);
    for (let attempt = 0; attempt < (mutation ? 1 : 3); attempt++) {
      signal.throwIfAborted();
      if (options.cookies().MUSIC_U !== cookies.MUSIC_U)
        throw new NativeSocialError("account-changed");
      const deadline = new AbortController();
      const onAbort = (): void => deadline.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => deadline.abort(new Error("request-timeout")), 8000);
      try {
        const response = await options.fetch(
          `https://interfacepc.music.163.com/eapi/${path.slice(5)}`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: Object.entries(header)
                .map(([key, value]) => `${key}=${value}`)
                .join("; "),
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; WOW64) Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.29.205117",
            },
            body,
            signal: deadline.signal,
          },
        );
        if (response.status === 401 || response.status === 403)
          throw new NativeSocialError("auth-required");
        if (response.status === 429) throw new NativeSocialError("rate-limited");
        if (!response.ok)
          throw new NativeSocialError(`http-${response.status}`, response.status >= 500);
        // 限制响应大小，避免异常服务端数据撑满 IPC 与离线缓存。
        const reader = response.body?.getReader();
        if (!reader) throw new NativeSocialError("invalid-response");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 2 * 1024 * 1024) throw new NativeSocialError("response-too-large");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result || typeof result !== "object" || Array.isArray(result))
          throw new NativeSocialError("invalid-response");
        const record = result as Record<string, unknown>;
        if (Number(record.code) === 301 || Number(record.code) === 302)
          throw new NativeSocialError("auth-required");
        if (Number(record.code) !== 200) throw new NativeSocialError(`api-${record.code}`);
        signal.throwIfAborted();
        if (options.cookies().MUSIC_U !== cookies.MUSIC_U)
          throw new NativeSocialError("account-changed");
        // 社交请求不接管登录 token，只吸收服务器的辅助会话标识。
        const setCookies = response.headers.getSetCookie();
        const nmtid = setCookies.map((value) => /^NMTID=([^;]+)/.exec(value)?.[1]).find(Boolean);
        if (nmtid) options.mergeCookies({ NMTID: nmtid });
        return record;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof NativeSocialError && !error.retryable) throw error;
        if (mutation)
          throw new NativeSocialError(operation === "send" ? "send-unknown" : "operation-unknown");
        if (attempt === 2) throw new NativeSocialError("offline");
        await delay(250 * 2 ** attempt, undefined, { signal });
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      }
    }
    throw new NativeSocialError("offline");
  },
});
