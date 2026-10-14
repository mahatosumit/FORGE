// FORGE Step 7B — Adversarial Persistence & Crash Recovery Acceptance Test Suite
// Exhaustively verifies CRASH-021 through CRASH-030:
// Real external side effects, checkpoint tampering/injection, wrong chain tip, cross-mission isolation,
// multi-mission concurrency, stale vs active lock coexistence, mixed recovery sweep,
// and the timing seams between effect, evidence, and ledger commit.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMission,
  type MissionStore,
  JournalCorruptionError,
  LockError,
} from "../../src/ledger/index.js";
import { LOCK_STALE_MS } from "../../src/ledger/lock.js";
import { AutonomousMissionStore } from "../../src/mission-engine/store.js";
import { MissionRecovery } from "../../src/mission-engine/recovery.js";
import { newMissionId, newGrantId } from "../../src/grants/grants.js";
import { ForgeRuntime } from "../../src/runtime/runtime.js";
import { sha256Hex } from "../../src/environments/local.js";
import type { MissionModel } from "../../src/contracts/mission.js";
import type { Plan } from "../../src/contracts/plan.js";

function setupTempDir(): { dataDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "forge-step7b-adv-"));
  return {
    dataDir: dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // ignore transient Windows file lock on temp cleanup
      }
    },
  };
}

function createDummyMissionModel(missionId: string): MissionModel {
  const now = new Date().toISOString() as any;
  return {
    missionId: missionId as any,
    intent: "test-mission",
    goalSpec: { summary: "test-goal", proposedCriteria: [] },
    successCriteria: [],
    constraints: {},
    riskPolicy: { allowedCapabilities: ["*"], escalationPermitted: true, requireVerificationTiers: ["mechanical"], autonomyLevel: "L3_GOVERNED_AUTONOMOUS" },
    budget: { maxPlannerTurns: 50, maxModelCalls: 100, maxTokens: 2_000_000, maxCapabilityCalls: 100, maxRetries: 20, maxExecutionTimeMs: 3600_000, maxArtifactBytes: 100 * 1024 * 1024, maxConcurrentTasks: 1, maxDelegationDepth: 2 },
    budgetConsumed: { plannerTurns: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, capabilityCalls: 0, retries: 0, executionTimeMs: 0, artifactBytes: 0 },
    deadline: null,
    status: "executing",
    currentPlanId: null,
    currentMilestoneId: null,
    createdAt: now,
    updatedAt: now,
    checkpoint: null,
  };
}

function dummyReceipt(tip: string) {
  return {
    closure: "completed-unverified" as const,
    weakestTier: "none" as const,
    criteria: [],
    authorityManifest: [],
    changeManifest: [],
    costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
    chainTip: tip,
  };
}

function createTestPlan(missionId: string, planId = "pln_1", taskPrefix = "tsk"): Plan {
  const mId = "mls_1";
  const t1Id = `${taskPrefix}_1`;
  const t2Id = `${taskPrefix}_2`;
  return {
    planId,
    missionId: missionId as any,
    version: 1,
    objective: "Test plan",
    assumptions: [],
    milestones: [
      {
        milestoneId: mId,
        objective: "Milestone 1",
        dependencies: [],
        status: "pending" as const,
        successCriteria: [],
        verificationCriteria: [],
        tasks: [
          {
            taskId: t1Id,
            milestoneId: mId,
            title: "Task 1",
            description: "First task",
            capability: "fs",
            args: { op: "write", path: "a.txt" },
            dependsOn: [],
            status: "ready" as const,
            attempt: 0,
            maxAttempts: 3,
            evidenceRefs: [],
            error: null,
          },
          {
            taskId: t2Id,
            milestoneId: mId,
            title: "Task 2",
            description: "Second task",
            capability: "fs",
            args: { op: "write", path: "b.txt" },
            dependsOn: [t1Id],
            status: "pending" as const,
            attempt: 0,
            maxAttempts: 3,
            evidenceRefs: [],
            error: null,
          },
        ],
      },
    ],
    dependencies: {},
    verificationStrategy: "mechanical" as const,
  };
}

// ============================================================================
// CRASH-021: REAL EXTERNAL SIDE EFFECT → CRASH → RECOVERY
// ============================================================================

test("CRASH-021: External side effect completes, crash before ledger commit, fails closed as post-effect-unknown", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const externalWorkDir = join(dataDir, "external_workspace");
    mkdirSync(externalWorkDir, { recursive: true });
    const targetFile = join(externalWorkDir, "mutation.txt");

    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "external-side-effect", goalSpec: { summary: "test", proposedCriteria: [] } } });

    // Step 1: Proposal received for external non-idempotent append
    const pRec = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["write-file", targetFile, "important-payload"], cwd: "." } }, meta: { rationale: "external write", citations: [] } },
    });

    // Step 2: Proposal dispatched and fsync'd to ledger
    store.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { proposalId: pRec.id, grantId: newGrantId(), environment: "local", timeoutMs: 30000 },
    });

    // Step 3: REAL EXTERNAL EFFECT COMPLETES in the physical world!
    writeFileSync(targetFile, "important-payload\n", "utf8");
    assert.ok(existsSync(targetFile), "Real external file was created on disk");

    // Step 4: FORGE CRASHES! Process dies before observation or task.completed is committed!
    store.close();

    // Step 5: Restart & Recover
    const store2 = openMission({ dataDir, missionId });
    const model = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store2, model);

    const analysis = MissionRecovery.analyzeLedger(store2.read());
    assert.equal(analysis.isInterrupted, true);
    assert.equal(analysis.hasPostEffectUnknown, true, "Dispatched shell action without observation must be post-effect-unknown");
    assert.deepEqual(analysis.nonIdempotentDispatchedProposalIds, [pRec.id]);

    // INVARIANT: Automatic recovery without operator acknowledgement MUST fail closed!
    // Automatic replay would double-mutate external state.
    const resBlocked = await MissionRecovery.recoverMission(missionStore, null);
    assert.equal(resBlocked.recovered, false);
    assert.equal(missionStore.getMission().status, "failed");

    // Step 6: With operator reconciliation, operator verifies external file and confirms
    let operatorReconciled = false;
    const missionStoreReconcile = new AutonomousMissionStore(store2, model);
    model.status = "executing";
    const resReconciled = await MissionRecovery.recoverMission(
      missionStoreReconcile,
      null,
      async (mId, propId) => {
        // Operator inspects external file on disk
        if (existsSync(targetFile) && readFileSync(targetFile, "utf8").includes("important-payload")) {
          operatorReconciled = true;
          return true; // operator confirms effect landed
        }
        return false;
      },
    );

    assert.equal(operatorReconciled, true);
    assert.equal(resReconciled.recovered, true);
    assert.equal(missionStoreReconcile.getMission().status, "executing");
    store2.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-022: CHECKPOINT TAMPERING DEFENSE
// ============================================================================

test("CRASH-022: Checkpoint record tampering in journal fails closed with JournalCorruptionError", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const model = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, model);
    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    missionStore.createCheckpoint("chk_legit_1");
    store.close();

    // Attacker modifies the checkpoint record directly inside journal.jsonl
    const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    // Find checkpoint line and tamper completedTasks count from 0 to 999
    const cpIndex = lines.findIndex((l) => l.includes("checkpoint.created"));
    assert.ok(cpIndex >= 0);
    lines[cpIndex] = lines[cpIndex]!.replace('"completedTasks":0', '"completedTasks":999');
    writeFileSync(journalPath, lines.join("\n") + "\n");

    // Reopening mission must detect broken hash chain and fail closed
    assert.throws(
      () => {
        openMission({ dataDir, missionId });
      },
      (err: any) => err instanceof JournalCorruptionError,
      "Tampered checkpoint record in journal must raise JournalCorruptionError",
    );
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-023: WRONG CHAIN-TIP CHECKPOINT REJECTION
// ============================================================================

test("CRASH-023: Checkpoint referencing forged or wrong chainTip is rejected on resume", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const model = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, model);
    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    const cp = missionStore.createCheckpoint("chk_test");
    // Adversary forges the in-memory checkpoint's chainTip to an alien hash
    cp.chainTip = "0000000000000000000000000000000000000000000000000000000000000000";

    assert.throws(
      () => {
        missionStore.resumeFromCheckpoint("chk_test");
      },
      /chain tip mismatch/i,
      "Resuming from checkpoint with wrong chainTip must be rejected",
    );
    store.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-024: CROSS-MISSION CHECKPOINT REJECTION
// ============================================================================

test("CRASH-024: Checkpoint from Mission A cannot be resumed in Mission B", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const midA = newMissionId();
    const midB = newMissionId();

    const storeA = openMission({ dataDir, missionId: midA });
    const modelA = createDummyMissionModel(midA);
    const mStoreA = new AutonomousMissionStore(storeA, modelA);
    const planA = createTestPlan(midA, "pln_A", "tskA");
    mStoreA.acceptPlan(planA);
    const cpA = mStoreA.createCheckpoint("chk_from_A");
    storeA.close();

    const storeB = openMission({ dataDir, missionId: midB });
    const modelB = createDummyMissionModel(midB);
    const mStoreB = new AutonomousMissionStore(storeB, modelB);
    const planB = createTestPlan(midB, "pln_B", "tskB");
    mStoreB.acceptPlan(planB);

    // Attack 1: Mission B attempts to resume Checkpoint A directly
    assert.throws(
      () => {
        mStoreB.resumeFromCheckpoint(cpA.checkpointId);
      },
      /not found in mission history/i,
      "Mission B must reject foreign checkpoint not found in its history",
    );

    // Attack 2: Adversary pushes Checkpoint A summary directly into Mission B projections
    mStoreB.checkpoints.push(cpA);
    assert.throws(
      () => {
        mStoreB.resumeFromCheckpoint(cpA.checkpointId);
      },
      /plan mismatch/i,
      "Mission B must reject checkpoint referencing alien planId",
    );

    storeB.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-025: CROSS-MISSION TASK CONTAMINATION DEFENSE
// ============================================================================

test("CRASH-025: Mission B cannot mutate or acknowledge tasks belonging to Mission A", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const midA = newMissionId();
    const midB = newMissionId();

    const storeA = openMission({ dataDir, missionId: midA });
    const modelA = createDummyMissionModel(midA);
    const mStoreA = new AutonomousMissionStore(storeA, modelA);
    const planA = createTestPlan(midA, "pln_A", "tskA");
    mStoreA.acceptPlan(planA);

    const storeB = openMission({ dataDir, missionId: midB });
    const modelB = createDummyMissionModel(midB);
    const mStoreB = new AutonomousMissionStore(storeB, modelB);
    const planB = createTestPlan(midB, "pln_B", "tskB");
    mStoreB.acceptPlan(planB);

    // Direct update: Mission B tries to update Task from Plan A
    const res = mStoreB.updateTaskState("tskA_1", (t) => { t.status = "succeeded"; });
    assert.equal(res, null, "Updating alien task in Mission B must return null");

    // Plan B tasks remain in their initial state
    assert.equal(mStoreB.getActivePlan()!.milestones[0]!.tasks[0]!.status, "ready");
    assert.equal(mStoreB.getActivePlan()!.milestones[0]!.tasks[1]!.status, "pending");

    storeA.close();
    storeB.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-026: SIMULTANEOUS MULTI-MISSION CONCURRENT WRITES
// ============================================================================

test("CRASH-026: Simultaneous concurrent writes across independent missions have zero lock contention", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const midA = newMissionId();
    const midB = newMissionId();

    const storeA = openMission({ dataDir, missionId: midA });
    const storeB = openMission({ dataDir, missionId: midB });

    const recA0 = storeA.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "A", goalSpec: { summary: "A", proposedCriteria: [] } } });
    const recB0 = storeB.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "B", goalSpec: { summary: "B", proposedCriteria: [] } } });

    // Concurrently write 25 records to Mission A and 25 records to Mission B
    const writes: Promise<any>[] = [];
    for (let i = 0; i < 25; i++) {
      writes.push(
        Promise.resolve().then(() =>
          storeA.append({
            kind: "claim.asserted",
            author: "model",
            ts: new Date().toISOString(),
            body: { statement: `Statement A-${i}`, citations: [recA0.id] },
          }),
        ),
      );
      writes.push(
        Promise.resolve().then(() =>
          storeB.append({
            kind: "claim.asserted",
            author: "model",
            ts: new Date().toISOString(),
            body: { statement: `Statement B-${i}`, citations: [recB0.id] },
          }),
        ),
      );
    }

    await Promise.all(writes);

    // Both ledgers must have exactly 26 records (1 opened + 25 claims), separate hash tips, zero interleaved data
    assert.equal(storeA.ledger.lastSeq(), 26);
    assert.equal(storeB.ledger.lastSeq(), 26);
    assert.notEqual(storeA.ledger.current()!.hash, storeB.ledger.current()!.hash);

    storeA.close();
    storeB.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-027: STALE LOCK THEFT DOES NOT DISTURB ACTIVE WRITER
// ============================================================================

test("CRASH-027: Stale lock on dead Mission A is stolen while active Mission B lock is respected", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const midA = newMissionId();
    const midB = newMissionId();

    // 1. Mission A: Dead writer with expired lock
    const dirA = join(dataDir, "missions", midA);
    mkdirSync(dirA, { recursive: true });
    writeFileSync(
      join(dirA, ".lock"),
      JSON.stringify({ pid: 999999, host: "dead-host", acquiredAt: Date.now() - (LOCK_STALE_MS + 10000) }),
    );
    const past = (Date.now() - (LOCK_STALE_MS + 10000)) / 1000;
    utimesSync(join(dirA, ".lock"), past, past);

    // 2. Mission B: Active live writer
    const storeB = openMission({
      dataDir,
      missionId: midB,
      writer: { pid: process.pid, host: "live-worker-b" },
    });

    // 3. New writer attempts to open Mission A -> Stale lock is stolen cleanly
    const storeA = openMission({
      dataDir,
      missionId: midA,
      writer: { pid: process.pid, host: "new-worker-a" },
    });
    assert.ok(storeA, "Stale lock on dead Mission A must be stolen cleanly");

    // 4. Second writer attempts to open Mission B -> Rejected fast with LockError
    assert.throws(
      () => {
        openMission({
          dataDir,
          missionId: midB,
          writer: { pid: 8888, host: "intruder" },
        });
      },
      (err: any) => err instanceof LockError,
      "Active Mission B must reject competing writer with LockError",
    );

    storeA.close();
    storeB.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-028: RECOVERY SWEEP WITH MIXED MISSION STATES
// ============================================================================

test("CRASH-028: Runtime boot recovery sweep accurately classifies mixed mission states", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    // 1. Closed mission
    const midClosed = newMissionId();
    const sClosed = openMission({ dataDir, missionId: midClosed });
    sClosed.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "c", goalSpec: { summary: "c", proposedCriteria: [] } } });
    const tip = sClosed.ledger.current()!.hash;
    sClosed.append({ kind: "mission.closed", author: "runtime", ts: new Date().toISOString(), body: { closure: "completed-unverified", receipt: dummyReceipt(tip) } });
    sClosed.close();

    // 2. Active healthy mission (live lock)
    const midActive = newMissionId();
    const sActive = openMission({ dataDir, missionId: midActive });
    sActive.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "a", goalSpec: { summary: "a", proposedCriteria: [] } } });
    // Keep lock active! (Do not close sActive yet)

    // 3. Interrupted mission with idempotent proposal (stale lock)
    const midIdempotent = newMissionId();
    const sIdemp = openMission({ dataDir, missionId: midIdempotent });
    sIdemp.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "i", goalSpec: { summary: "i", proposedCriteria: [] } } });
    const pIdemp = sIdemp.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "fs", args: { op: "write", path: "test.txt", contentRef: sha256Hex(new Uint8Array([1, 2, 3])) } }, meta: { rationale: "w", citations: [] } },
    });
    sIdemp.append({ kind: "proposal.dispatched", author: "runtime", ts: new Date().toISOString(), body: { proposalId: pIdemp.id, grantId: newGrantId(), environment: "local", timeoutMs: 1000 } });
    sIdemp.close();
    // Inject dead lock
    writeFileSync(join(dataDir, "missions", midIdempotent, ".lock"), JSON.stringify({ pid: 111, host: "crashed", acquiredAt: Date.now() - (LOCK_STALE_MS + 5000) }));
    const past = (Date.now() - (LOCK_STALE_MS + 5000)) / 1000;
    utimesSync(join(dataDir, "missions", midIdempotent, ".lock"), past, past);

    // 4. Interrupted mission with non-idempotent proposal (post-effect-unknown, stale lock)
    const midUnknown = newMissionId();
    const sUnknown = openMission({ dataDir, missionId: midUnknown });
    sUnknown.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "u", goalSpec: { summary: "u", proposedCriteria: [] } } });
    const pUnknown = sUnknown.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["rm", "-rf", "temp"], cwd: "." } }, meta: { rationale: "rm", citations: [] } },
    });
    sUnknown.append({ kind: "proposal.dispatched", author: "runtime", ts: new Date().toISOString(), body: { proposalId: pUnknown.id, grantId: newGrantId(), environment: "local", timeoutMs: 1000 } });
    sUnknown.close();
    // Inject dead lock
    writeFileSync(join(dataDir, "missions", midUnknown, ".lock"), JSON.stringify({ pid: 222, host: "crashed", acquiredAt: Date.now() - (LOCK_STALE_MS + 5000) }));
    utimesSync(join(dataDir, "missions", midUnknown, ".lock"), past, past);

    // 5. Corrupted journal mission
    const midCorrupt = newMissionId();
    const sCorrupt = openMission({ dataDir, missionId: midCorrupt });
    const recX0 = sCorrupt.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "x", goalSpec: { summary: "x", proposedCriteria: [] } } });
    sCorrupt.append({ kind: "claim.asserted", author: "model", ts: new Date().toISOString(), body: { statement: "orig", citations: [recX0.id] } });
    sCorrupt.append({ kind: "claim.asserted", author: "model", ts: new Date().toISOString(), body: { statement: "orig2", citations: [recX0.id] } });
    sCorrupt.close();
    // Tamper with record 2
    const jPath = join(dataDir, "missions", midCorrupt, "journal.jsonl");
    const rawLines = readFileSync(jPath, "utf8").trim().split("\n");
    rawLines[1] = rawLines[1]!.replace("orig", "tampered_byte");
    writeFileSync(jPath, rawLines.join("\n") + "\n");

    // RUN SWEEP
    const runtime = new ForgeRuntime({ dataDir, workspaceRoot: dataDir });
    const reports = await runtime.bootRecoverySweep();

    assert.equal(reports.length, 5);

    const rClosed = reports.find((r) => r.missionId === midClosed);
    const rActive = reports.find((r) => r.missionId === midActive);
    const rIdemp = reports.find((r) => r.missionId === midIdempotent);
    const rUnknown = reports.find((r) => r.missionId === midUnknown);
    const rCorrupt = reports.find((r) => r.missionId === midCorrupt);

    assert.equal(rClosed?.status, "closed");
    assert.equal(rClosed?.recovered, false);

    assert.equal(rActive?.status, "active");
    assert.equal(rActive?.recovered, false);

    assert.equal(rIdemp?.status, "interrupted");
    assert.equal(rIdemp?.recovered, true);

    assert.equal(rUnknown?.status, "post-effect-unknown");
    assert.equal(rUnknown?.recovered, false, "Post-effect-unknown must NOT be marked recovered without operator ack");

    assert.equal(rCorrupt?.status, "quarantined");
    assert.equal(rCorrupt?.recovered, false);

    sActive.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-029: CRASH BETWEEN EFFECT AND EVIDENCE CAPTURE
// ============================================================================

test("CRASH-029: Crash after external effect but before evidence artifact is captured fails closed", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const externalWorkDir = join(dataDir, "external_ws");
    mkdirSync(externalWorkDir, { recursive: true });
    const outputTarget = join(externalWorkDir, "generated_output.bin");

    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "produce-artifact", goalSpec: { summary: "test", proposedCriteria: [] } } });

    const pRec = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["build-binary", outputTarget], cwd: "." } }, meta: { rationale: "compile", citations: [] } },
    });

    store.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { proposalId: pRec.id, grantId: newGrantId(), environment: "local", timeoutMs: 30000 },
    });

    // 1. External effect lands on physical storage
    writeFileSync(outputTarget, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); // ELF binary magic
    assert.ok(existsSync(outputTarget));

    // 2. CRASH! Process dies before runtime can read bytes, hash them, or write to artifacts dir!
    store.close();

    // 3. Artifact dir has 0 files for this proposal
    const artifactDir = join(dataDir, "missions", missionId, "artifacts");
    const artifactFiles = existsSync(artifactDir) ? readdirSync(artifactDir) : [];
    assert.equal(artifactFiles.length, 0, "No evidence artifact was captured before crash");

    // 4. Recover
    const store2 = openMission({ dataDir, missionId });
    const model = createDummyMissionModel(missionId);
    const mStore = new AutonomousMissionStore(store2, model);

    const analysis = MissionRecovery.analyzeLedger(store2.read());
    assert.equal(analysis.hasPostEffectUnknown, true);
    assert.deepEqual(analysis.nonIdempotentDispatchedProposalIds, [pRec.id]);

    // Fails closed without operator acknowledgement
    const res = await MissionRecovery.recoverMission(mStore, null);
    assert.equal(res.recovered, false);
    assert.equal(mStore.getMission().status, "failed");

    store2.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// CRASH-030: CRASH BETWEEN EVIDENCE AND LEDGER COMMIT
// ============================================================================

test("CRASH-030: Crash after evidence artifact written but before observation record committed fails closed", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "uncommitted-evidence", goalSpec: { summary: "test", proposedCriteria: [] } } });

    const pRec = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["generate-token"], cwd: "." } }, meta: { rationale: "token", citations: [] } },
    });

    store.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { proposalId: pRec.id, grantId: newGrantId(), environment: "local", timeoutMs: 30000 },
    });

    // 1. Evidence artifact is written and fsync'd into the mission artifact repository
    const evidencePayload = new TextEncoder().encode("token-abc-123");
    const evidenceHash = sha256Hex(evidencePayload);
    const artifactPath = store.ledger.writeArtifact(evidencePayload, evidenceHash);
    assert.ok(existsSync(artifactPath), "Evidence artifact was committed to artifact directory");

    // 2. CRASH! Process dies BEFORE store.append(observation.shell) can commit to journal!
    store.close();

    // 3. Reopen & Recover
    const store2 = openMission({ dataDir, missionId });
    const model = createDummyMissionModel(missionId);
    const mStore = new AutonomousMissionStore(store2, model);

    // Ledger history does NOT have observation
    const records = store2.read();
    const hasObservation = records.some((r) => r.kind.startsWith("observation."));
    assert.equal(hasObservation, false, "Observation record must NOT be in ledger");

    const analysis = MissionRecovery.analyzeLedger(records);
    // Dangling artifact on disk cannot substitute for cryptographic ledger commitment!
    assert.equal(analysis.hasPostEffectUnknown, true);
    assert.deepEqual(analysis.nonIdempotentDispatchedProposalIds, [pRec.id]);

    const res = await MissionRecovery.recoverMission(mStore, null);
    assert.equal(res.recovered, false);
    assert.equal(mStore.getMission().status, "failed", "Dangling uncommitted artifact must not allow automatic recovery");

    store2.close();
  } finally {
    cleanup();
  }
});
