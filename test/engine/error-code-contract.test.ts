import test from "node:test";
import assert from "node:assert/strict";
import { parseBody } from "../../src/contracts/records.js";

test("engine.error record accepts capability-fault (used for deterministic misuses)", () => {
  const body = parseBody("engine.error", { code: "capability-fault", message: "x", retryable: false });
  assert.equal(body.code, "capability-fault");
});

test("engine.error record rejects unknown codes (contract enforcement)", () => {
  assert.throws(() => parseBody("engine.error", { code: "UsageError" as never, message: "x", retryable: false }));
});
