import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDesktopEndpoint } from "../../../../scripts/social/desktopCdp";

test("desktop CDP only accepts its exact loopback port and page endpoint", () => {
  assert.equal(
    validateDesktopEndpoint("ws://127.0.0.1:9229/devtools/page/abc-123", 9229).port,
    "9229",
  );
  for (const endpoint of [
    "ws://example.com:9229/devtools/page/x",
    "ws://127.0.0.1:9222/devtools/page/x",
    "ws://127.0.0.1:9229/devtools/browser/x",
    "ws://u:p@127.0.0.1:9229/devtools/page/x",
    "ws://127.0.0.1:9229/devtools/page/x?token=private",
    "ws://127.0.0.1:9229/devtools/page/x#fragment",
  ])
    assert.throws(() => validateDesktopEndpoint(endpoint, 9229));
});
