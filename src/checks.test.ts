import assert from "node:assert/strict";
import test from "node:test";
import { CheckLog } from "./checks.js";

test("green verification is not rejected by TDD bookkeeping", () => {
  const checks = new CheckLog();
  checks.checked("npm test", { code: 0, text: "5 tests passed" });

  assert.match(checks.finish(), /npm test[\s\S]*5 tests passed/);
});
