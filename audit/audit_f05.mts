import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine.js";
import { openMission } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

async function runAudit() {
  console.log("=== F-05 CLAIM EVIDENCE BOUNDARY AUDIT ===");

  const ws = mkdtempSync(join(tmpdir(), "f05-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "f05-data-"));

  // 1. Test citations referencing non-observation records
  const nonObservationKinds = [
    "mission.opened",
    "plan.proposed",
    "plan.confirmed",
    "grant.issued",
    "grant.requested",
    "grant.decided",
    "grant.revoked",
    "proposal.received",
    "proposal.validated",
    "proposal.dispatched",
    "stage.completed",
    "claim.asserted",
    "verdict.recorded",
    "engine.error",
  ];

  for (const targetKind of nonObservationKinds) {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    const mRec = store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "test", goalSpec: { summary: "test", proposedCriteria: [] } } });
    const pRec = store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    const gRec = store.append({ kind: "grant.issued", author: "runtime", ts, body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: {}, expiresAt: null, issuer: "base-policy", parentGrantId: null } } });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });

    // Pick an existing record matching targetKind or create one
    let targetId: string = mRec.id;
    if (targetKind === "grant.issued") targetId = gRec.id;
    else if (targetKind === "plan.proposed") targetId = pRec.id;
    else {
      // Create record of that kind
      if (targetKind === "grant.revoked") {
        const r = store.append({ kind: "grant.revoked", author: "runtime", ts, body: { grantId: `grt_${missionId.slice(4)}` as any, reason: "revoked" } });
        targetId = r.id;
      } else if (targetKind === "proposal.received") {
        const r = store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "fs", args: { op: "mkdir", path: "src/a" as any } }, meta: { rationale: "r", citations: [] } } });
        targetId = r.id;
      } else if (targetKind === "stage.completed") {
        const r = store.append({ kind: "stage.completed", author: "runtime", ts, body: { stageId: "stg_01ARZ3NDEKTSV4RRFFQ69G5FA1" as any, outcome: "proceed" } });
        targetId = r.id;
      } else if (targetKind === "verdict.recorded") {
        const r = store.append({ kind: "verdict.recorded", author: "runtime", ts, body: { criterionId: "cri_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, result: "pass", tier: "mechanical", by: "runtime", refs: [] } });
        targetId = r.id;
      }
    }
    store.close();

    // Now script model to cite targetId
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "claim", statement: `Claim citing ${targetKind}`, citations: [targetId] } as never;
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = engine.openHandle(missionId);
    await engine.executeMission(h);

    const rejected = h.store.read().find((r) => r.kind === "claim.rejected");
    assert.ok(rejected, `Claim citing non-observation record "${targetKind}" MUST be rejected`);
    const asserted = h.store.read().find((r) => r.kind === "claim.asserted");
    assert.equal(asserted, undefined, `No claim.asserted should exist when citing ${targetKind}`);
    h.store.close();
  }
  console.log("✔ Test 1 passed: All non-observation citations are rejected");

  // 2. Nonexistent observation ID (valid RecordId format but not in ledger)
  {
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "claim", statement: "claim citing ghost", citations: ["rec_01ARZ3NDEKTSV4RRFFQ69G5FA0" as any] } as never;
        yield { type: "text-delta", text: "done" } as never;
      },
    };
    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("nonexistent citation");
    await engine.executeMission(h);

    const rejected = h.store.read().find((r) => r.kind === "claim.rejected");
    assert.ok(rejected);
    assert.equal((rejected.body as any).reason, "unresolved-citation");
    h.store.close();
    console.log("✔ Test 2 passed: Nonexistent observation ID citation rejected");
  }

  // 2b. Malformed citation ID (fails RecordId schema)
  {
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "claim", statement: "claim citing malformed", citations: ["not_a_record_id" as any] } as never;
        yield { type: "text-delta", text: "done" } as never;
      },
    };
    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("malformed citation");
    await engine.executeMission(h);

    const asserted = h.store.read().find((r) => r.kind === "claim.asserted");
    assert.equal(asserted, undefined, "Malformed citation must NEVER become claim.asserted");
    h.store.close();
    console.log("✔ Test 2b passed: Malformed citation ID cannot create claim.asserted");
  }

  // 3. Cross-mission observation citation
  {
    // Create mission 1 with an observation
    const m1Id = newMissionId();
    const s1 = openMission({ dataDir, missionId: m1Id });
    const ts = new Date().toISOString();
    s1.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "m1", goalSpec: { summary: "m1", proposedCriteria: [] } } });
    const obsRec = s1.append({
      kind: "observation.fs", author: "runtime", ts,
      body: { op: "write", path: "src/f.txt" as any, beforeHash: null, afterHash: "0".repeat(64), diffRef: null },
    });
    s1.close();

    // Mission 2 attempts to cite mission 1's observation
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "claim", statement: "claim citing cross-mission obs", citations: [obsRec.id] } as never;
        yield { type: "text-delta", text: "done" } as never;
      },
    };
    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h2 = await engine.openQuickMission("m2 test");
    await engine.executeMission(h2);

    const rejected = h2.store.read().find((r) => r.kind === "claim.rejected");
    assert.ok(rejected, "Cross-mission citation MUST be rejected in mission 2");
    h2.store.close();
    console.log("✔ Test 3 passed: Cross-mission observation citation rejected");
  }

  // 4. Empty citation array
  {
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "claim", statement: "claim with empty citations", citations: [] } as never;
        yield { type: "text-delta", text: "done" } as never;
      },
    };
    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("empty citation");
    await engine.executeMission(h);

    const rejected = h.store.read().find((r) => r.kind === "claim.rejected");
    assert.ok(rejected, "Empty citation list must be rejected");
    h.store.close();
    console.log("✔ Test 4 passed: Empty citation array rejected");
  }

  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  console.log("ALL F-05 AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("F-05 AUDIT FAILED:", e);
  process.exit(1);
});
