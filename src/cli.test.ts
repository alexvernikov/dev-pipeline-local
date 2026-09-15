import assert from "node:assert/strict";
import test from "node:test";
import { retryConnection } from "./cli.js";

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
