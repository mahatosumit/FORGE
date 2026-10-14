// checkout-mission.test.ts — the M4 Definition of Done: the full vertical
// slice against a fixture repo with a genuinely failing "checkout test", the
// REAL runtime (ledger, grants, gate, capability host, local environment,
// verifier) and a SCRIPTED model. Asserts the exact record sequence, receipt
// contents, and the claim/evidence separation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine/engine.js";
import type { ModelEvent, ModelRequest } from "../../src/contracts/model.js";
import type { ModelFn } from "../../src/contracts/model.js";
import { createHash } from "node:crypto";

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "forge-ws-"));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "node test.js" } }));
  // the "checkout test": passes only when the fix is present
  writeFileSync(join(ws, "test.js"), `
    const fs = require("fs");
    const src = fs.readFileSync("src/cart/totals.ts", "utf8");
    if (src.includes("roundToCent")) { console.log("1 test passed"); process.exit(0); }
    console.error("checkout test FAILED: totals not rounded"); process.exit(1);
  `);
  mkdirSync(join(ws, "src", "cart"), { recursive: true });
  writeFileSync(join(ws, "src", "cart", "totals.ts"), "export function total(items) { return items.reduce((a, b) => a + b, 0); }\n");
  return ws;
}

/** Scripted model: a deterministic ModelFn whose complete() calls yield the
 *  exact event sequence of VERTICAL-SLICE.md. */
function scriptedModel(steps: Array<(req: ModelRequest) => ModelEvent[]>): ModelFn & { calls: number } {
  let call = 0;
  return {
    get calls() { return call; },
    async *complete(req: ModelRequest) {
      const step = steps[Math.min(call, steps.length - 1)]!;
      call++;
      for (const ev of step(req)) yield ev;
    },
  };
}

test("vertical slice: fix the failing checkout test (real runtime)", async () => {
  const ws = makeWorkspace();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-data-"));

  const fixContent = "export function total(items: number[]) { return roundToCent(items.reduce((a, b) => a + b, 0)); }\nexport function roundToCent(n: number) { return Math.round(n * 100) / 100; }\n";
  const fixHash = sha(new TextEncoder().encode(fixContent));

  // step 1: run the test first (observed FAILING by the runtime)
  // step 2: upload content + fs write (within envelope)
  // step 3: narration + a citation-less claim (rejected per INV-2)
  const model = scriptedModel([
    (_req) => [
      { type: "text-delta", text: "diagnosing the rounding defect" },
      {
        type: "proposal",
        proposal: { capability: "shell", args: { argv: ["npm", "test"], cwd: "." } },
        meta: { rationale: "run the checkout suite", citations: [] },
      },
    ],
    (_req) => [
      { type: "content", sha256: fixHash, base64: Buffer.from(fixContent).toString("base64") },
      {
        type: "proposal",
        proposal: { capability: "fs", args: { op: "write", path: "src/cart/totals.ts", contentRef: fixHash } },
        meta: { rationale: "apply rounding fix to totals", citations: [] },
      },
      { type: "claim", statement: "checkout test passes after rounding fix", citations: [] }, // zero citations → rejected (INV-2)
      { type: "text-delta", text: "the tests pass now" },
    ],
  ]);

  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  const h = await engine.openQuickMission("Fix the failing checkout test");
  const result = await engine.executeMission(h);

  assert.equal(result.closure, "verified", `expected verified, got ${result.closure}`);

  const records = h.store.read();
  const kinds = records.map((r) => r.kind);

  // runtime-owned state: opened → criterion → plan → grants → proposals → observations → verdicts → closed
  assert.ok(kinds.includes("mission.opened"));
  assert.ok(kinds.includes("criterion.defined"));
  assert.ok(kinds.includes("plan.confirmed"));
  assert.ok(kinds.includes("grant.issued"));
  assert.ok(kinds.includes("proposal.received"));
  assert.ok(kinds.includes("proposal.validated"));
  assert.ok(kinds.includes("proposal.dispatched")); // crash boundary exists
  assert.ok(kinds.includes("observation.fs"));
  assert.ok(kinds.includes("observation.shell"));
  assert.ok(kinds.includes("observation.verify")); // verification is runtime-executed
  assert.ok(kinds.includes("verdict.recorded"));
  assert.ok(kinds.includes("claim.asserted") || kinds.includes("claim.rejected"));
  assert.ok(kinds.includes("mission.closed"));

  // evidence: the shell observation recorded the REAL failing exit code
  const shellObs = records.filter((r) => r.kind === "observation.shell")
    .map((r) => (r.body as { exit: number }).exit);
  assert.deepEqual(shellObs, [1], "the model-run suite must be observed failing (real effect)");
  const verifyMatched = records.filter((r) => r.kind === "observation.verify")
    .map((r) => (r.body as { matched: boolean }).matched);
  assert.deepEqual(verifyMatched, [false, true], "verifier must observe fail, then pass after the fix");

  // the file actually changed on disk (real effect through the whole pipeline)
  const after = readFileSync(join(ws, "src", "cart", "totals.ts"), "utf8");
  assert.ok(after.includes("roundToCent"));

  // claim/evidence separation: a claim with NO citations is rejected
  const claimRejected = records.find((r) => r.kind === "claim.rejected");
  assert.ok(claimRejected, "the citation-less claim must be rejected (INV-2)");

  // receipt: computed from the weakest link, mechanical tier, chain anchored
  const closed = records.find((r) => r.kind === "mission.closed")!;
  const receipt = (closed.body as { receipt: Record<string, unknown> }).receipt;
  assert.equal((closed.body as { closure: string }).closure, "verified");
  assert.equal(receipt["weakestTier"], "mechanical");
  const authority = receipt["authorityManifest"] as Array<{ issuer: string }>;
  assert.ok(authority.length >= 1);
  assert.ok(authority.every((a) => a.issuer === "base-policy")); // quick lane
  const changes = receipt["changeManifest"] as Array<{ kind: string; path: string | null }>;
  assert.ok(changes.some((c) => c.kind === "file" && c.path === "src/cart/totals.ts"));
  assert.equal(typeof receipt["chainTip"], "string");

  // ledger integrity after the whole mission (INV-5)
  assert.deepEqual(h.store.ledger.verify(), { ok: true, count: records.length });

  // narration never became state: no record body contains the raw text-delta
  const raw = JSON.stringify(records);
  assert.ok(!raw.includes("diagnosing the rounding defect"));

  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("slice failure path: model cannot talk its way past a failing criterion", async () => {
  const ws = makeWorkspace();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-data2-"));

  // model asserts success WITHOUT fixing anything — and never proposes
  const model = scriptedModel([
    (_req) => [{ type: "text-delta", text: "I am done, the tests pass." }],
  ]);

  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  const h = await engine.openQuickMission("Fix the failing checkout test");
  const result = await engine.executeMission(h);

  // the mechanical criterion fails ⇒ closure can never be "verified" (INV-11)
  assert.notEqual(result.closure, "verified");
  const verdicts = h.store.read().filter((r) => r.kind === "verdict.recorded");
  assert.ok(verdicts.some((r) => (r.body as { result: string }).result === "fail"));
  assert.equal(h.store.read().some((r) => r.kind === "mission.closed" && (r.body as { closure: string }).closure === "verified"), false);

  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
