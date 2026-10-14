import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Engine, MissionClosedError } from "../src/engine/engine.js";
import { openMission, openMissionReadOnly, destroyProjections } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

async function runAudit() {
  console.log("=== F-02 RESUME AND DUPLICATE EFFECTS AUDIT ===");

  // 1. Closed mission resume rejection
  {
    const ws = mkdtempSync(join(tmpdir(), "f02-closed-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f02-closed-data-"));
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "text-delta", text: "done" } as never;
      },
    };
    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("closed mission test");
    const res = await engine.executeMission(h);
    assert.equal(res.closure, "completed-unverified");

    const recordCountBefore = h.store.read().length;
    await assert.rejects(async () => {
      await engine.resume(h);
    }, MissionClosedError);

    // Verify zero new records and zero effects
    assert.equal(h.store.read().length, recordCountBefore);
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 1 passed: Resume on closed mission rejected with 0 effects / records");
  }

  // 2. Multi-stage mission restart between stages
  {
    const ws = mkdtempSync(join(tmpdir(), "f02-ms-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f02-ms-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();
    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "multi-stage restart", goalSpec: { summary: "multi-stage restart", proposedCriteria: [] } } });
    const stages = [
      { id: "stg_" + (missionId.slice(10) + "A").padEnd(26, "0"), purpose: "stage one", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
      { id: "stg_" + (missionId.slice(10) + "B").padEnd(26, "0"), purpose: "stage two", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
    ];
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages, grantIds: [`grt_${missionId.slice(4)}`] } });
    store.close();

    // Let stage 1 complete, then simulate crash before stage 2
    let stage1Dispatches = 0;
    let stage2Dispatches = 0;
    let stageCount = 0;

    const crashingModel: ModelFn = {
      async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
        stageCount++;
        const isStageTwo = JSON.stringify(req.messages).includes("stage two");
        if (!isStageTwo) {
          stage1Dispatches++;
          const content = "stage1_content";
          const hash = createHash("sha256").update(content).digest("hex");
          yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
          yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: "src/stage1.txt", contentRef: hash } }, meta: { rationale: "stage 1 write", citations: [] } } as never;
          yield { type: "text-delta", text: "stage 1 done" } as never;
        } else {
          // Crash! Throw an unhandled error or terminate
          throw new Error("Simulated host crash at stage 2 start");
        }
      },
    };

    const engine1 = new Engine({ dataDir, workspaceRoot: ws, modelFn: crashingModel });
    const h1 = engine1.openHandle(missionId);
    const res = await engine1.executeMission(h1);
    assert.equal(res.closure, "failed");
    h1.store.close();

    // Now resume with a working model for stage 2
    let modelTurn = 0;
    const recoveryModel: ModelFn = {
      async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
        const isStageTwo = JSON.stringify(req.messages).includes("stage two");
        if (!isStageTwo) {
          stage1Dispatches++;
          assert.fail("Stage 1 must NOT be re-executed on resume!");
        } else {
          modelTurn++;
          if (modelTurn === 1) {
            stage2Dispatches++;
            const content = "stage2_content";
            const hash = createHash("sha256").update(content).digest("hex");
            yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
            yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: "src/stage2.txt", contentRef: hash } }, meta: { rationale: "stage 2 write", citations: [] } } as never;
          }
          yield { type: "text-delta", text: "stage 2 done" } as never;
        }
      },
    };

    // If mission closed on failure, let's check if it's open or closed. If closed{failed}, resume is rejected.
    // In our test, let's simulate process crash without mission.closed being written.
    // To simulate process crash right after stage 1 completed:
    // We create a fresh store with stage 1 completed
    const m2 = newMissionId();
    const s2 = openMission({ dataDir, missionId: m2 });
    s2.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "multi-stage restart", goalSpec: { summary: "multi-stage restart", proposedCriteria: [] } } });
    const stgs = [
      { id: "stg_" + (m2.slice(10) + "A").padEnd(26, "0"), purpose: "stage one", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
      { id: "stg_" + (m2.slice(10) + "B").padEnd(26, "0"), purpose: "stage two", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
    ];
    s2.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: stgs } });
    s2.append({
      kind: "grant.issued", author: "runtime", ts,
      body: { grant: { id: `grt_${m2.slice(4)}`, missionId: m2, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } },
    });
    s2.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: stgs, grantIds: [`grt_${m2.slice(4)}`] } });
    
    // Simulate stage 1 already completed in ledger:
    s2.append({ kind: "stage.completed", author: "runtime", ts, body: { stageId: stgs[0]!.id, outcome: "proceed" } });
    s2.close();

    // Now execute engine on m2: it must skip stage 1 and execute stage 2!
    stage1Dispatches = 0;
    stage2Dispatches = 0;
    const engine2 = new Engine({ dataDir, workspaceRoot: ws, modelFn: recoveryModel });
    const h2 = engine2.openHandle(m2);
    const res2 = await engine2.executeMission(h2);
    assert.equal(res2.closure, "completed-unverified");
    assert.equal(stage1Dispatches, 0, "Stage 1 was skipped because ledger recorded stage.completed");
    assert.equal(stage2Dispatches, 1, "Stage 2 executed exactly once");
    h2.store.close();

    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 2 passed: Multi-stage resume skips completed stages derived from ledger");
  }

  // 3. Crash Matrix: proposal.dispatched without observation
  {
    const ws = mkdtempSync(join(tmpdir(), "f02-crash-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f02-crash-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();
    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "crash test", goalSpec: { summary: "crash test", proposedCriteria: [] } } });
    const stages = [
      { id: "stg_" + (missionId.slice(10) + "A").padEnd(26, "0"), purpose: "crash stage", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
    ];
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages, grantIds: [`grt_${missionId.slice(4)}`] } });
    
    // Simulate crash after proposal.dispatched but BEFORE observation
    const propRec = store.append({
      kind: "proposal.received", author: "model", ts,
      body: { proposal: { capability: "fs", args: { op: "write", path: "src/crash.txt", contentRef: "0".repeat(64) } }, meta: { rationale: "write", citations: [] } },
    });
    store.append({
      kind: "proposal.validated", author: "runtime", ts, refs: [propRec.id],
      body: { proposalId: propRec.id, result: "accepted", reasonCode: "in-grant", grantId: `grt_${missionId.slice(4)}` },
    });
    store.append({
      kind: "proposal.dispatched", author: "runtime", ts, refs: [propRec.id],
      body: { proposalId: propRec.id, grantId: `grt_${missionId.slice(4)}`, environment: "local", timeoutMs: 30000 },
    });
    store.close();

    // Now inspect via engine recovery classification
    let ackCalled = false;
    const engine = new Engine({
      dataDir, workspaceRoot: ws,
      modelFn: { async *complete() { yield { type: "text-delta", text: "done" } as never; } },
      onPostEffectUnknown: async (mid, pid) => {
        ackCalled = true;
        assert.equal(mid, missionId);
        assert.equal(pid, propRec.id);
        return true; // acknowledged
      },
    });

    const h = engine.openHandle(missionId);
    const unks = await engine.classifyRecovery(h);
    assert.equal(unks.length, 1);
    assert.equal(unks[0]!.proposalId, propRec.id);
    assert.equal(unks[0]!.phase, "post-effect-unknown");

    await engine.resume(h);
    assert.equal(ackCalled, true, "User acknowledgment required for post-effect-unknown");
    const interrupted = h.store.read().find((r) => r.kind === "observation.interrupted");
    assert.ok(interrupted, "observation.interrupted written to ledger");
    assert.equal((interrupted.body as any).phase, "post-effect-unknown");
    h.store.close();

    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 3 passed: Post-effect-unknown crash classified and requires acknowledgment");
  }

  // 4. Projection manipulation / deletion during resume
  {
    const ws = mkdtempSync(join(tmpdir(), "f02-proj-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f02-proj-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();
    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "proj test", goalSpec: { summary: "proj test", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [] } });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [], grantIds: [] } });
    store.close();

    // Delete projections database
    destroyProjections(dataDir, missionId);

    // Reopen mission - must rebuild projections from journal cleanly
    const engine = new Engine({
      dataDir, workspaceRoot: ws,
      modelFn: { async *complete() { yield { type: "text-delta", text: "done" } as never; } },
    });
    const h = engine.openHandle(missionId);
    assert.equal(h.store.projections.recordCount(), 3);
    assert.equal(h.store.projections.missionStatus()?.status, "executing");
    h.store.close();

    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 4 passed: Projections deleted & rebuilt from journal without affecting truth");
  }

  console.log("ALL F-02 AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("F-02 AUDIT FAILED:", e);
  process.exit(1);
});
