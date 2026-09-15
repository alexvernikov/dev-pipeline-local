import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { retryConnection } from "./connection.js";

test("the connector starts when invoked through an npx-style executable link", () => {
  const directory = mkdtempSync(join(tmpdir(), "dev-pipeline-local-"));
  const executable = join(directory, "dev-pipeline-local");
  symlinkSync(fileURLToPath(new URL("./cli.js", import.meta.url)), executable);

  try {
    const result = spawnSync(process.execPath, [executable, "invalid"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: dev-pipeline-local connect/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("a timed-out runner poll retries instead of stopping the connector", async () => {
  let attempts = 0;
  const result = await retryConnection(async () => {
    if (++attempts === 1) throw new DOMException("Timed out", "TimeoutError");
    return "connected";
  }, async () => {});

  assert.equal(result, "connected");
  assert.equal(attempts, 2);
});

test("a non-network error still stops the connector", async () => {
  await assert.rejects(() => retryConnection(async () => {
    throw new Error("Invalid setup");
  }, async () => {}), /Invalid setup/);
});
