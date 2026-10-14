import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPACT_EST_CHARS,
  deriveCheckpointSummary,
  estimateRequestChars,
  renderCheckpointBlock,
  shouldCompact,
} from "../../src/engine/compaction.js";

test("estimateRequestChars sums message content", () => {
  assert.equal(estimateRequestChars([{ role: "system", content: "abcd" }, { role: "user", content: "xy" }]), 6);
});

test("shouldCompact triggers only past the threshold", () => {
  const small = [{ role: "user", content: "hello" }];
  assert.equal(shouldCompact(small), false);
  const big = [{ role: "user", content: "x".repeat(COMPACT_EST_CHARS + 1) }];
  assert.equal(shouldCompact(big), true);
});

test("deriveCheckpointSummary is mechanical over real records", () => {
  const records = [
    { kind: "plan.proposed", body: { planId: "pln_A", stages: [{}, {}, {}] } },
    { kind: "stage.completed", body: { stageId: "stg_1", outcome: "proceed" } },
    { kind: "verdict.recorded", body: { criterionId: "cri_1", result: "fail" } },
    { kind: "engine.error", body: { code: "stage-budget" } },
  ];
  const d = deriveCheckpointSummary(records, "chk_000009");
  assert.equal(d.checkpointId, "chk_000009");
  assert.equal(d.planId, "pln_A");
  assert.equal(d.totalTasks, 3);
  assert.equal(d.completedTasks, 1);
  assert.deepEqual(d.unresolved, ["cri_1", "error:stage-budget"]);
});

test("renderCheckpointBlock is compact and carries provenance markers", () => {
  const d = deriveCheckpointSummary([], "chk_x");
  const text = renderCheckpointBlock(d, "goal text");
  assert.ok(text.includes("CHECKPOINT chk_x"));
  assert.ok(text.includes("runtime-authored"));
  assert.ok(text.length < 500, `block should stay small: ${text.length}`);
});
