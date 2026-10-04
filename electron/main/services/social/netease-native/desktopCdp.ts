import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";

/** 参考 netease-desktop-mcp；端口、进程归属、页面身份分别校验。 */
export const validateDesktopEndpoint = (raw: string, port: number): URL => {
  const url = new URL(raw);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/page\/[\w-]+$/.test(url.pathname)
  )
    throw new Error("invalid-cdp-endpoint");
  return url;
};

/** 仅返回构建、登录布尔值与固定模型存在性，不读取账号标识、Cookie、正文或房间 ID。 */
export const desktopMetadataExpression = String.raw`(() => {
  const visibleCount = selector => [...document.querySelectorAll(selector)].filter(element =>
    element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' &&
    getComputedStyle(element).display !== 'none').length;
  const element = document.querySelector('[data-testid="tid_createplaylist_section"]');
  let fiber = element?.[Object.keys(element).find(k => /^__react(?:InternalInstance|Fiber)/.test(k)) || ""];
  let state;
  for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
    const store = fiber.memoizedProps?.value?.store;
    if (typeof store?.getState === "function" && typeof store.dispatch === "function") { state = store.getState(); break; }
  }
  const models = ["async:listenTogether", "async:listenTogetherPlayer", "async:listenTogetherPlayList",
    "async:listenTogetherPlayStatus", "page:messagesheet"];
  const script = [...document.scripts].map(item => item.src.match(/\/app\.chunk\.([\w]+)\.js(?:$|\?)/)?.[1]).find(Boolean);
  return {
    recognized: !!script && !!state && (!!state['async:listenTogether'] ||
      (visibleCount('[id="btn_pc_minibar_play"]') === 1 && visibleCount('[class*="SearchWrapper_"] input') === 1)),
    build: script || "unknown", storeFound: !!state,
    models: Object.fromEntries(models.map(name => [name, !!state?.[name]])),
  };
})()`;

const metadataSchema = z.object({
  recognized: z.boolean(),
  build: z.string().max(80),
  storeFound: z.boolean(),
  models: z.record(z.string(), z.boolean()),
});
export type DesktopMetadata = z.infer<typeof metadataSchema>;

class DesktopCdp {
  private sequence = 0;
  private jobs = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let event: { id?: number; result?: Record<string, unknown>; error?: unknown };
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!event.id) return;
      const job = this.jobs.get(event.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.jobs.delete(event.id);
      if (event.error) job.reject(new Error("cdp-operation-failed"));
      else job.resolve(event.result || {});
    });
    socket.once("close", () => this.close());
    socket.on("error", () => this.close());
  }
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.socket.readyState !== WebSocket.OPEN || this.jobs.size >= 20)
      return Promise.reject(new Error("cdp-unavailable"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id);
        reject(new Error("cdp-timeout"));
      }, 5000);
      this.jobs.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void {
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.reject(new Error("cdp-closed"));
    }
    this.jobs.clear();
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}

/** 开发工具只连接用户已经启用的调试客户端，所有失败释放连接。 */
export async function connectDesktopCdp(port: number, executable: string) {
  if (
    process.platform !== "win32" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    !executable
  )
    throw new Error("windows-client-required");
  const inspect = async () => {
    const { stdout } = await promisify(execFile)(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        String.raw`
        $ErrorActionPreference='Stop'
        $resolvedMusicPath=(Resolve-Path -LiteralPath $env:SPLAYER_SOCIAL_CLIENT).ProviderPath
        if ([IO.Path]::GetFileName($resolvedMusicPath) -ine 'cloudmusic.exe') { throw 'Wrong executable' }
        $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:SPLAYER_SOCIAL_PORT) -ErrorAction Stop)
        $owners=@($listeners.OwningProcess | Select-Object -Unique)
        if ($owners.Count -ne 1) { throw 'Ambiguous owner' }
        $owner=Get-CimInstance Win32_Process -Filter ("ProcessId = " + $owners[0])
        if ($owner.ExecutablePath -ine $resolvedMusicPath) { throw 'Wrong process' }
        if (@($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count -gt 0) { throw 'Non-loopback listener' }
        @{processId=[int]$owners[0];expectedPath=$resolvedMusicPath;actualPath=$owner.ExecutablePath;addresses=@($listeners.LocalAddress)} | ConvertTo-Json -Compress
      `,
      ],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 32768,
        env: {
          ...process.env,
          SPLAYER_SOCIAL_CLIENT: executable,
          SPLAYER_SOCIAL_PORT: String(port),
        },
      },
    );
    const owner = z
      .object({
        processId: z.number().int().positive(),
        expectedPath: z.string(),
        actualPath: z.string(),
        addresses: z.array(z.literal("127.0.0.1")).min(1),
      })
      .parse(JSON.parse(stdout.replace(/^\uFEFF/, "")));
    if (owner.actualPath.toLowerCase() !== owner.expectedPath.toLowerCase())
      throw new Error("wrong-cdp-owner");
  };
  await inspect();
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("cdp-discovery-failed");
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw new Error("cdp-discovery-too-large");
  const targets = z
    .array(z.object({ type: z.string(), webSocketDebuggerUrl: z.string().optional() }))
    .max(30)
    .parse(JSON.parse(raw));
  const matches: { cdp: DesktopCdp; metadata: DesktopMetadata }[] = [];
  try {
    for (const target of targets.filter(
      (item) => item.type === "page" && item.webSocketDebuggerUrl,
    )) {
      const url = validateDesktopEndpoint(target.webSocketDebuggerUrl!, port);
      const socket = new WebSocket(url, { maxPayload: 1024 * 1024, handshakeTimeout: 5000 });
      const cdp = new DesktopCdp(socket);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", () => reject(new Error("cdp-connect-failed")));
        });
        const result = await cdp.request("Runtime.evaluate", {
          expression: desktopMetadataExpression,
          returnByValue: true,
        });
        const metadata = metadataSchema.parse((result.result as { value?: unknown })?.value);
        if (metadata.recognized) matches.push({ cdp, metadata });
        else cdp.close();
      } catch {
        cdp.close();
      }
    }
    if (matches.length !== 1) throw new Error("ambiguous-or-unsupported-client");
    await inspect();
    return matches[0];
  } catch (error) {
    for (const item of matches) item.cdp.close();
    throw error;
  }
}
