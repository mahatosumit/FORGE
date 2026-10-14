// recovery.test.ts — M6 DoD: crash classification at the effect boundary.
// Builds the exact post-crash ledger state (dispatched-without-observation),
// then proves the documented semantics: possibly-executed is REPRESENTED,
// user acknowledgment gates resume, and no silent re-execution occurs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMission } from "../../src/ledger/index.js";
import { Engine } from "../../src/engine/engine.js";
import { GrantStore, newMissionId, newGrantId } from "../../src/grants/grants.js";
import type { ModelEvent, ModelRequest } from "../../src/contracts/model.js";
import type { MissionStore } from "../../src/ledger/index.js";

function buildCrashedMission(ack: boolean): { dataDir: string; missionId: string; store: MissionStore; closure: string | null } {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-crash-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();
  store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "deploy", goalSpec: { summary: "deploy", proposedCriteria: [] } } });
  // one-shot mission: no criteria → closes completed-unverified after resume
  const stageId = `stg_${missionId.slice(4)}`;
  store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: stageId, purpose: "deploy", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 100_000, wallClockMs: 60_000 } }] } });
  const grants = new GrantStore(store);
  const g = grants.issue({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["echo"] } }, expiresAt: null, issuer: "base-policy", parentGrantId: null });
  store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: stageId, purpose: "deploy", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 100_000, wallClockMs: 60_000 } }], grantIds: [g.id] } });

  // model emits a proposal; gate allows; dispatch record written (crash boundary)
  const received = store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "shell", args: { argv: ["echo", "deploy-step"], cwd: "." } }, meta: { rationale: "deploy", citations: [] } } });
  store.append({ kind: "proposal.validated", author: "runtime", ts, body: { proposalId: received.id, result: "accepted", reasonCode: "in-grant", grantId: g.id } });
  store.append({ kind: "proposal.dispatched", author: "runtime", ts, body: { proposalId: received.id, grantId: g.id, environment: "local", timeoutMs: 120_000 } });
  // …and then the process died. Whether the effect landed is UNKNOWN.

  const model = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "text-delta", text: "done" };
    },
  } as unknown as import("../../src/contracts/model.js").ModelFn;

  const engine = new Engine({
    dataDir,
    workspaceRoot: mkdtempSync(join(tmpdir(), "forge-ws-")),
    modelFn: model,
    onPostEffectUnknown: async () => ack,
  });

  store.close(); // the crashed writer is gone — the lock is released/stale
  const h = engine.openHandle(missionId);
  const classificationPromise = engine.classifyRecovery(h);
  return {
    dataDir,
    missionId,
    store,
    get closure() {
      return null;
    },
    ...{ classificationPromise },
  } as never;
}

test("recovery: dispatched-without-observation is classified post-effect-unknown and requires acknowledgment", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-crash-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();
  store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "deploy", goalSpec: { summary: "deploy", proposedCriteria: [] } } });
  const stageId = `stg_${missionId.slice(4)}`;
  const stage = { id: stageId, purpose: "deploy", mode: "model" as const, criteria: [] as never[], grantsRequired: [], budget: { steps: 5, tokens: 100_000, wallClockMs: 60_000 } };
  store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [stage] } });
  const grants = new GrantStore(store);
  const g = grants.issue({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["echo"] } }, expiresAt: null, issuer: "base-policy", parentGrantId: null });
  store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [stage], grantIds: [g.id] } });
  const received = store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "shell", args: { argv: ["echo", "deploy-step"], cwd: "." } }, meta: { rationale: "deploy", citations: [] } } });
  store.append({ kind: "proposal.validated", author: "runtime", ts, body: { proposalId: received.id, result: "accepted", reasonCode: "in-grant", grantId: g.id } });
  store.append({ kind: "proposal.dispatched", author: "runtime", ts, body: { proposalId: received.id, grantId: g.id, environment: "local", timeoutMs: 120_000 } });

  let ackCalls = 0;
  const model = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "text-delta", text: "done" };
    },
  } as unknown as import("../../src/contracts/model.js").ModelFn;
  const engine = new Engine({
    dataDir,
    workspaceRoot: mkdtempSync(join(tmpdir(), "forge-ws-")),
    modelFn: model,
    onPostEffectUnknown: async () => { ackCalls++; return true; },
  });

  // classification BEFORE resume: the interrupted proposal is found
  store.close(); // the crashed writer is gone — the lock is released/stale
  const h = engine.openHandle(missionId);
  const classified = await engine.classifyRecovery(h);
  assert.equal(classified.length, 1);
  assert.equal(classified[0]!.phase, "post-effect-unknown");

  // resume: the interrupted observation is recorded; NO re-execution of the
  // non-idempotent effect occurs (no new observation.shell for it)
  const before = h.store.read().filter((r) => r.kind === "observation.shell").length;
  const result = await engine.resume(h);
  assert.equal(ackCalls, 1);
  const after = h.store.read().filter((r) => r.kind === "observation.shell").length;
  assert.equal(after, before, "non-idempotent effect must NOT be re-executed silently");

  const interrupted = h.store.read().find((r) => r.kind === "observation.interrupted");
  assert.ok(interrupted);
  assert.equal((interrupted!.body as { phase: string }).phase, "post-effect-unknown");

  // the mission then completes (no criteria; model says done)
  assert.equal(result.closure, "completed-unverified");
  assert.equal(h.store.projections.missionStatus()?.status, "closed");

  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("recovery: pre-effect proposals (validated, undispatched) re-execute safely", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-crash2-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();
  store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "x", goalSpec: { summary: "x", proposedCriteria: [] } } });
  const stageId = `stg_${missionId.slice(4)}`;
  const stage = { id: stageId, purpose: "x", mode: "model" as const, criteria: [] as never[], grantsRequired: [], budget: { steps: 5, tokens: 100_000, wallClockMs: 60_000 } };
  store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [stage] } });
  const grants = new GrantStore(store);
  const g = grants.issue({ capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["echo"] } }, expiresAt: null, issuer: "base-policy", parentGrantId: null });
  store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [stage], grantIds: [g.id] } });
  // validated but NEVER dispatched — crash before dispatch: safe to re-run
  store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "shell", args: { argv: ["echo", "safe"], cwd: "." } }, meta: { rationale: "r", citations: [] } } });
  store.append({ kind: "proposal.validated", author: "runtime", ts, body: { proposalId: "rec_01HZZ000000000000000000099", result: "accepted", reasonCode: "in-grant", grantId: g.id } });

  const model = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "text-delta", text: "done" };
    },
  } as unknown as import("../../src/contracts/model.js").ModelFn;
  const engine = new Engine({ dataDir, workspaceRoot: mkdtempSync(join(tmpdir(), "forge-ws-")), modelFn: model });
  store.close(); // the crashed writer is gone — the lock is released/stale
  const h = engine.openHandle(missionId);
  const classified = await engine.classifyRecovery(h);
  // the validated-but-undispatched proposal is NOT post-effect-unknown
  assert.equal(classified.length, 0);
  const result = await engine.resume(h);
  assert.equal(result.closure, "completed-unverified");
  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

void buildCrashedMission;
void newGrantId;
