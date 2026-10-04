import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { wsEndpointMetadata, wsFrameMetadata } from "./wsMetadata";
import { connectDesktopCdp } from "./desktopCdp";

const port = Number(process.argv[2] || 9229);
const output = process.argv[3];
const executable = process.argv[4];
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !output || !executable)
  throw new Error(
    "用法：tsx scripts/social/capture-ws.ts <端口> <仓库外输出.json> <cloudmusic.exe 完整路径>",
  );

/** 被动观测已有客户端；不启动客户端、不执行 action、不保存原始帧或握手 headers。 */
async function capture(): Promise<void> {
  const { cdp, metadata } = await connectDesktopCdp(port, executable);
  const records: Record<string, unknown>[] = [];
  const sockets = new Map<string, number>();
  const ws = cdp.socket;
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve();
    }, 60000);
    const finish = (): void => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    void cdp.request("Network.enable").catch(() => {
      clearTimeout(timer);
      reject(new Error("CDP Network 不可用"));
      ws.close();
    });
    ws.once("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP 连接失败"));
    });
    ws.once("close", finish);
    ws.on("message", (rawBytes) => {
      const bytes = Array.isArray(rawBytes)
        ? Buffer.concat(rawBytes)
        : Buffer.from(rawBytes as ArrayBuffer);
      if (records.length >= 500 || bytes.byteLength > 1024 * 1024) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const event = parsed as {
        method?: string;
        error?: unknown;
        params?: {
          requestId: string;
          url?: string;
          response?: { opcode: number; payloadData: string };
        };
      };
      if (event.error) {
        clearTimeout(timer);
        ws.close();
        reject(new Error("此客户端不支持 CDP Network 观测"));
        return;
      }
      if (!event.params) return;
      const { requestId } = event.params;
      if (event.method === "Network.webSocketCreated" && sockets.size < 50) {
        const socket = sockets.size + 1;
        sockets.set(requestId, socket);
        records.push({
          elapsedMs: Date.now() - started,
          socket,
          kind: "created",
          ...wsEndpointMetadata(event.params.url || ""),
        });
      }
      if (
        ["Network.webSocketFrameSent", "Network.webSocketFrameReceived"].includes(
          event.method || "",
        ) &&
        event.params.response
      ) {
        const frame = event.params.response;
        records.push({
          elapsedMs: Date.now() - started,
          socket: sockets.get(requestId) ?? 0,
          direction: event.method === "Network.webSocketFrameSent" ? "sent" : "received",
          ...wsFrameMetadata(frame.payloadData, frame.opcode),
        });
      }
      if (records.length >= 500) finish();
    });
  });
  cdp.close();
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      { version: 1, metadataOnly: true, clientBuild: metadata.build, records },
      null,
      2,
    ),
  );
  process.stdout.write(`已保存 ${records.length} 条脱敏元数据；没有记录原始帧。\n`);
}

capture().catch(() => {
  process.stderr.write("无法连接已有网易云 CDP 调试目标。未修改或重启客户端。\n");
  process.exitCode = 1;
});
