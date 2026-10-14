// failure-matrix.test.ts — F-08: FAILURE-SEMANTICS.md rows as executable
// conformance cases, driven through the REAL engine (scripted model only for
// cognition; all governance/effects/recovery are the production path).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type MissionHandle } from "../../src/engine/engine.js";
import { GrantStore, newMissionId } from "../../src/grants/grants.js";
import { openMission } from "../../src/ledger/index.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../../src/contracts/model.js";
import type { StageDecl } from "../../src/contracts/index.js";

function ws(): string {
  const w = mkdtempSync(join(tmpdir(), "forge-fm-ws-"));
  writeFileSync(join(w, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  writeFileSync(join(w, "test.js"), "process.exit(0)");
  return w;
}

function stageNoCriteria(id: string): StageDecl {
  return { id, purpose: "work", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } };
}

/** Build a one-stage mission with a shell argv-prefix ["node"] grant. */
function setup(model: ModelFn, opts?: { withShellGrant?: boolean }): { engine: Engine; h: MissionHandle; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-fm-data-"));
  const engine = new Engine({ dataDir, workspaceRoot: ws(), modelFn: model });
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();
  store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "x", goalSpec: { summary: "x", proposedCriteria: [] } } });
  const stages = [stageNoCriteria(`stg_${missionId.slice(4)}`)];
  store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages } });
  let grantIds: string[] = [];
  if (opts?.withShellGrant !== false) {
    const grants = new GrantStore(store);
    const g = grants.issue({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["node", "-e"] } }, expiresAt: null, issuer: "base-policy", parentGrantId: null });
    grantIds = [g.id];
  }
  store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages, grantIds } });
  store.close(); // the constructing writer releases; openHandle re-acquires
  const h = engine.openHandle(missionId);
  return { engine, h, dataDir };
}

const shellProposal = {
  capability: "shell" as const,
  args: { argv: ["node", "-e", "process.exit(0)"], cwd: "." },
};

// Row: "Provider HTTP 5xx → engine.error{Transport,retryable} → bounded retries → failed"
test("row: provider 5xx retries are bounded, ledgered, and end in failure", async () => {
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "error", error: { code: "Transport", message: "provider 5xx" } };
    },
  } as unknown as ModelFn;
  const { engine, h, dataDir } = setup(model);
  const r = await engine.executeMission(h);
  assert.equal(r.closure, "failed");
  const errors = h.store.read().filter((x) => x.kind === "engine.error");
  assert.ok(errors.length >= 3, "bounded retries happened");
  assert.ok(errors.every((e) => (e.body as { retryable: boolean }).retryable));
  // closure record exists (failed)
  assert.equal(h.store.read().some((x) => x.kind === "mission.closed" && (x.body as { closure: string }).closure === "failed"), true);
  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Row: "Proposal out-of-grant → grant.requested; denial → mission.closed{blocked}"
test("row: escalation denial closes mission blocked with an explanatory receipt (F-03)", async () => {
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "proposal", proposal: { capability: "shell", args: { argv: ["curl", "https://evil.example.com"], cwd: "." } }, meta: { rationale: "out of scope on purpose", citations: [] } };
    },
  } as unknown as ModelFn;
  const { engine, h, dataDir } = setup(model, { withShellGrant: false }); // nothing granted
  const r = await engine.executeMission(h);

  assert.equal(r.closure, "blocked");
  const closed = h.store.read().find((x) => x.kind === "mission.closed");
  assert.ok(closed, "blocked missions MUST have a mission.closed record (F-03)");
  const receipt = (closed!.body as { receipt: { authorityManifest: unknown[] } }).receipt;
  assert.ok(receipt, "the blocked receipt is generated");
  assert.ok(h.store.read().some((x) => x.kind === "grant.requested"), "the structured escalation is ledgered");
  assert.equal(h.store.read().some((x) => x.kind === "grant.issued"), false, "denial issues nothing");
  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Row: "Stage budget exhaustion → dispatch mechanically disabled; failed"
test("row: stage budget exhaustion mechanically stops dispatch (INV-7)", async () => {
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "proposal", proposal: shellProposal, meta: { rationale: "work", citations: [] } };
    },
  } as unknown as ModelFn;
  const { engine, h, dataDir } = setup(model);
  const r = await engine.executeMission(h);
  assert.equal(r.closure, "failed");
  const dispatched = h.store.read().filter((x) => x.kind === "proposal.dispatched").length;
  assert.equal(dispatched, 3, "dispatch stops exactly at the step budget");
  assert.ok(h.store.read().some((x) => x.kind === "engine.error" && (x.body as { code: string }).code === "stage-budget"));
  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Row: "Journal tampering → quarantine; no execution on a corrupted journal"
test("row: journal corruption quarantines the mission at open", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-fm-corr-"));
  const model: ModelFn = {
    async *complete(): AsyncGenerator<ModelEvent> { yield { type: "text-delta", text: "x" }; },
  } as unknown as ModelFn;
  const engine = new Engine({ dataDir, workspaceRoot: ws(), modelFn: model });
  const h = engine.openHandle(newMissionId());
  h.store.close();
  const journalPath = h.store.ledger["paths"].journal;
  writeFileSync(journalPath, "garbage line\n");
  assert.throws(() => engine.openHandle(h.missionId), /corruption|quarantin/i);
  rmSync(dataDir, { recursive: true, force: true });
});

// Row: "Projection rebuild after restart → identical semantics"
test("row: projections rebuild after restart with identical query results", async () => {
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "proposal", proposal: shellProposal, meta: { rationale: "work", citations: [] } };
      yield { type: "text-delta", text: "done" };
    },
  } as unknown as ModelFn;
  const { engine, h, dataDir } = setup(model);
  await engine.executeMission(h);
  const before = h.store.projections.recordCount();
  h.store.close();
  // simulate restart: reopen (openMission rebuilds if inconsistent)
  const h2 = engine.openHandle(h.missionId);
  assert.equal(h2.store.projections.recordCount(), before);
  assert.ok(h2.store.projections.consistentWith(h2.store.ledger));
  h2.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});
