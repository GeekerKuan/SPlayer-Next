import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TogetherDiagnostics } from "./diagnostics";

test("diagnostics default off, redact unknown fields, bound writes and stop after disposal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "splayer-diagnostics-"));
  const log = new TogetherDiagnostics(path.join(directory, "logs"));
  try {
    log.record("control", { action: "seek", positionMs: 1000 });
    await assert.rejects(stat(log.directory), { code: "ENOENT" });
    assert.deepEqual(log.status(), { enabled: false });
    await log.setEnabled(true);
    log.record("operation-end", {
      operation: "control",
      ok: false,
      durationMs: 30,
      error: "secret-cookie-value",
      ...{
        Cookie: "private-cookie",
        roomId: "private-room",
        message: "private-message",
        action: "secret-action",
      },
    });
    for (let index = 0; index < 1000; index++)
      log.record("control", { action: "seek", positionMs: index });
    await log.setEnabled(false);
    const before = await readFile(path.join(log.directory, "current.jsonl"), "utf8");
    assert.ok(before.split("\n").filter(Boolean).length <= 64);
    assert.ok(!before.includes("private-") && !before.includes("secret-"));
    assert.ok(before.includes('"error":"other"'));
    log.record("state", { progressMs: 10 });
    await log.dispose();
    await log.dispose();
    assert.equal(await readFile(path.join(log.directory, "current.jsonl"), "utf8"), before);
    await assert.rejects(log.setEnabled(true), /cancelled/);
  } finally {
    await log.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics rotates two bounded files and reports unavailable storage without crashing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "splayer-diagnostics-"));
  const log = new TogetherDiagnostics(directory);
  try {
    await writeFile(path.join(directory, "current.jsonl"), "x".repeat(2 * 1024 * 1024));
    await log.setEnabled(true);
    await log.setEnabled(false);
    assert.ok((await stat(path.join(directory, "current.jsonl"))).size < 1024);
    assert.equal((await stat(path.join(directory, "previous.jsonl"))).size, 2 * 1024 * 1024);
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "file");
    const unavailable = new TogetherDiagnostics(blocked);
    await assert.rejects(unavailable.setEnabled(true), /diagnostics-unavailable/);
    assert.deepEqual(unavailable.status(), { enabled: false, error: "diagnostics-unavailable" });
    await unavailable.dispose();
  } finally {
    await log.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
