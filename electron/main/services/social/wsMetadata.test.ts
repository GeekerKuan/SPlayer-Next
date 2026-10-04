import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wsEndpointMetadata,
  wsFrameMetadata,
  wsShape,
} from "../../../../scripts/social/wsMetadata";

test("WS metadata never includes payload secrets, messages or unknown field names", () => {
  const metadata = JSON.stringify(
    wsShape({
      data: {
        text: "private-message",
        MUSIC_U: "secret",
        "personal-text-as-key": "anything",
        roomId: "123456",
      },
    }),
  );
  for (const value of ["private-message", "MUSIC_U", "secret", "personal-text-as-key", "123456"])
    assert.equal(metadata.includes(value), false);
  assert.ok(metadata.includes("roomId"));
});
test("WS endpoint metadata strips path, query and credentials", () => {
  const metadata = wsEndpointMetadata(
    "wss://username:password@push.example.com/private/room?token=secret",
  );
  assert.deepEqual(metadata, { host: "push.example.com", scheme: "wss:" });
});
test("binary and invalid JSON are never persisted as raw frames", () => {
  const metadata = JSON.stringify(wsFrameMetadata("raw-private-payload", 2));
  assert.equal(metadata.includes("raw-private-payload"), false);
  assert.deepEqual(wsFrameMetadata("not-json", 1), { opcode: 1, length: 8, format: "non-json" });
});
