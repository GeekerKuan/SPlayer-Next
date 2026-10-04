const keys = new Set([
  "type",
  "code",
  "cmd",
  "command",
  "commandType",
  "data",
  "payload",
  "event",
  "result",
  "id",
  "seq",
  "clientSeq",
  "version",
  "roomId",
  "userId",
  "message",
  "msg",
  "text",
  "timestamp",
  "time",
  "progress",
  "playStatus",
  "songId",
  "targetSongId",
  "ack",
  "heartbeat",
]);

/** 只记录允许字段的类型与字符串长度，未知 key 也可能携带用户输入，不能直接保存。 */
export const wsShape = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return "depth-limit";
  if (value === null) return "null";
  if (typeof value === "string") return { type: "string", length: value.length };
  if (Array.isArray(value))
    return {
      type: "array",
      count: value.length,
      item: value.length ? wsShape(value[0], depth + 1) : null,
    };
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      unknownKeys: entries.filter(([key]) => !keys.has(key)).length,
      fields: Object.fromEntries(
        entries
          .filter(([key]) => keys.has(key))
          .slice(0, 40)
          .map(([key, item]) => [key, wsShape(item, depth + 1)]),
      ),
    };
  }
  return typeof value;
};

export const wsEndpointMetadata = (raw: string): { host: string; scheme: string } => {
  try {
    const url = new URL(raw);
    return { host: url.hostname, scheme: url.protocol };
  } catch {
    return { host: "unknown", scheme: "unknown" };
  }
};

export const wsFrameMetadata = (payload: string, opcode: number): Record<string, unknown> => {
  const metadata: Record<string, unknown> = { opcode, length: payload.length };
  if (opcode === 1 && payload.length < 65536) {
    try {
      metadata.shape = wsShape(JSON.parse(payload));
    } catch {
      metadata.format = "non-json";
    }
  } else metadata.format = "binary-or-large";
  return metadata;
};
