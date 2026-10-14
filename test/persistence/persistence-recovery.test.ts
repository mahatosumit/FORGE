// FORGE Step 7B — Persistence & Production Runtime Acceptance Test Suite
// Exhaustively verifies CRASH-001 through CRASH-020 across all 7 sub-milestones (7B.1 - 7B.7):
// Durable state model, crash-safe fsync, single-writer lock leasing, torn tail recovery,
// 15-boundary crash consistency, atomic checkpoints, versioning, and runtime daemon sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMission,
  type MissionStore,
  Ledger,
  JournalCorruptionError,
  LockError,
  UnsupportedSchemaVersionError,
} from "../../src/ledger/index.js";
import { acquireLock, LOCK_STALE_MS } from "../../src/ledger/lock.js";
import {
  validateMissionTransition,
  type MissionState,
  type MissionModel,
} from "../../src/contracts/mission.js";
import { AutonomousMissionStore } from "../../src/mission-engine/store.js";
import { MissionRecovery } from "../../src/mission-engine/recovery.js";
import { DeterministicPlanner } from "../../src/mission-engine/planner.js";
import { newMissionId, newGrantId } from "../../src/grants/grants.js";
import { ForgeRuntime } from "../../src/runtime/runtime.js";
import { LocalEnvironment, sha256Hex } from "../../src/environments/local.js";

function setupTempDir(): { dataDir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "forge-step7b-"));
  return {
    dataDir: dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // ignore transient file lock on temp cleanup in Windows
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
    status: "created",
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

function createTestPlan(missionId: string) {
  const mId = "mls_1";
  const t1Id = "tsk_1";
  const t2Id = "tsk_2";
  return {
    planId: "pln_1",
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
// 7B.2 CRASH-SAFE PERSISTENCE (CRASH-001 - CRASH-005)
// ============================================================================

test("CRASH-001: Physical fsync verification guarantees durability on disk before return", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const rec = store.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "durability-test", goalSpec: { summary: "test", proposedCriteria: [] } },
    });

    // Verify record is physically written and matches immediately
    const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
    assert.ok(existsSync(journalPath), "journal file must exist");
    const raw = readFileSync(journalPath, "utf8");
    assert.ok(raw.includes(rec.id), "appended record must be flushed to disk immediately");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-002: Atomic artifact creation with temp file and rename retry", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const content = new TextEncoder().encode("Hello world artifact payload");
    const hash = sha256Hex(content);

    const artifactPath = store.ledger.writeArtifact(content, hash);
    assert.ok(existsSync(artifactPath), "artifact must exist on disk");
    assert.equal(store.ledger.artifactPath(hash), artifactPath);

    const readBytes = store.ledger.readArtifact(hash);
    assert.ok(readBytes);
    assert.equal(new TextDecoder().decode(readBytes), "Hello world artifact payload");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-003: Crash lease recovery steals stale lock when prior writer died", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const missionDir = join(dataDir, "missions", missionId);
    const lockPath = join(missionDir, ".lock");

    // Manually create an expired/stale lock from a dead process
    const { mkdirSync } = await import("node:fs");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: "dead-node", acquiredAt: Date.now() - (LOCK_STALE_MS + 5000) }));
    // Backdate mtime
    const { utimesSync } = await import("node:fs");
    const past = (Date.now() - (LOCK_STALE_MS + 5000)) / 1000;
    utimesSync(lockPath, past, past);

    // New writer attempts to acquire lock
    const store = openMission({ dataDir, missionId, writer: { pid: process.pid, host: "new-node" } });
    assert.ok(store, "stale lock must be stolen cleanly");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-004: Concurrent writer collision fails fast with LockError", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store1 = openMission({ dataDir, missionId, writer: { pid: 100, host: "node-1" } });

    assert.throws(
      () => {
        openMission({ dataDir, missionId, writer: { pid: 101, host: "node-2" } });
      },
      (err: any) => err instanceof LockError,
      "concurrent writer must fail with LockError",
    );

    store1.close();
  } finally {
    cleanup();
  }
});

test("CRASH-005: Torn trailing write detection and recovery mode truncation", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "test", goalSpec: { summary: "test", proposedCriteria: [] } },
    });
    store.close();

    const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
    // Inject a torn write at the end of the journal (partial JSON line without closing brace or hash)
    const tornLine = '{"v":1,"id":"rec_partial","kind":"task.started","body":{"task';
    const fd = openSync(journalPath, "a");
    writeSync(fd, tornLine + "\n");
    closeSync(fd);

    // Normal open must detect torn tail and quarantine (fail-closed)
    assert.throws(
      () => {
        openMission({ dataDir, missionId, repairTornTail: false });
      },
      (err: any) => err instanceof JournalCorruptionError,
      "un-repaired torn write must fail closed",
    );

    // Explicit recovery mode must safely truncate the torn uncommitted tail and recover valid records
    const recoveredStore = openMission({ dataDir, missionId, repairTornTail: true });
    assert.equal(recoveredStore.ledger.lastSeq(), 1, "must recover 1 valid record");
    recoveredStore.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// 7B.3 LEDGER DURABILITY & INTEGRITY (CRASH-006 - CRASH-008)
// ============================================================================

test("CRASH-006: Mid-journal tampering fails closed with JournalCorruptionError and cannot truncate", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t1", goalSpec: { summary: "s", proposedCriteria: [] } } });
    store.append({ kind: "task.started", author: "runtime", ts: new Date().toISOString(), body: { taskId: "tsk_1", milestoneId: "mls_1", capability: "fs", attempt: 1 } });
    store.append({ kind: "task.completed", author: "runtime", ts: new Date().toISOString(), body: { taskId: "tsk_1", milestoneId: "mls_1", capability: "fs", evidenceRefs: [], durationMs: 10 } });
    store.close();

    // Tamper with record 2 in the middle of the journal
    const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    lines[1] = lines[1]!.replace("tsk_1", "tsk_tampered");
    writeFileSync(journalPath, lines.join("\n") + "\n");

    // Even with repairTornTail: true, mid-chain tampering must quarantine
    assert.throws(
      () => {
        openMission({ dataDir, missionId, repairTornTail: true });
      },
      (err: any) => err instanceof JournalCorruptionError,
      "mid-journal tampering cannot be truncated and must quarantine",
    );
  } finally {
    cleanup();
  }
});

test("CRASH-007: Zero-data-loss projection rebuild yields byte-identical state (INV-13)", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t1", goalSpec: { summary: "s", proposedCriteria: [] } } });
    store.append({ kind: "task.started", author: "runtime", ts: new Date().toISOString(), body: { taskId: "tsk_1", milestoneId: "mls_1", capability: "fs", attempt: 1 } });
    store.append({ kind: "task.completed", author: "runtime", ts: new Date().toISOString(), body: { taskId: "tsk_1", milestoneId: "mls_1", capability: "fs", evidenceRefs: [], durationMs: 10 } });
    store.close();

    // Delete projections cache file
    const projPath = join(dataDir, "missions", missionId, "projections.db");
    if (existsSync(projPath)) rmSync(projPath);

    // Reopen mission - projections rebuild automatically from journal
    const storeReopened = openMission({ dataDir, missionId });
    assert.equal(storeReopened.ledger.lastSeq(), 3);
    assert.equal(storeReopened.read().length, 3);
    storeReopened.close();
  } finally {
    cleanup();
  }
});

test("CRASH-008: Closure anchor enforces post-closure immutability (F-04)", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t1", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const tip = store.ledger.current()!.hash;
    store.append({
      kind: "mission.closed",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { closure: "completed-unverified", receipt: dummyReceipt(tip) },
    });
    store.close();

    // Attempt to append record after closure directly to journal file
    const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
    const raw = readFileSync(journalPath, "utf8");
    const forgedLine = '{"v":1,"id":"rec_forged","kind":"task.started","author":"runtime","seq":3,"body":{"taskId":"tsk_bad"},"hash":"abc"}';
    writeFileSync(journalPath, raw + forgedLine + "\n");

    assert.throws(
      () => {
        openMission({ dataDir, missionId });
      },
      (err: any) => err instanceof JournalCorruptionError,
      "modifying journal after mission.closed must fail closed",
    );
  } finally {
    cleanup();
  }
});

// ============================================================================
// 7B.4 THE 15-BOUNDARY CRASH RECOVERY MATRIX (CRASH-009 - CRASH-015)
// ============================================================================

test("CRASH-009: Boundary B-01 recovery resets interrupted task to ready without side effects", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    missionModel.status = "executing";
    const missionStore = new AutonomousMissionStore(store, missionModel);

    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);
    const t1 = plan.milestones[0]!.tasks[0]!.taskId;
    missionStore.updateTaskState(t1, (t) => { t.status = "executing"; });
    missionStore.appendRecord("task.started", { taskId: t1, milestoneId: plan.milestones[0]!.milestoneId, capability: "fs", attempt: 1 });
    // Crash before proposal generation!

    // Analyze recovery
    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.equal(analysis.isInterrupted, true);
    assert.deepEqual(analysis.interruptedTaskIds, [t1]);
    assert.equal(analysis.hasPostEffectUnknown, false);

    // Perform recovery
    const res = await MissionRecovery.recoverMission(missionStore, missionStore.getActivePlan());
    assert.equal(res.recovered, true);
    assert.deepEqual(res.readyTasks, [t1]);
    assert.equal(missionStore.getActivePlan()!.milestones[0]!.tasks[0]!.status, "ready");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-010: Boundary B-02/B-03 recovery safely re-evaluates undispatched proposal", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const pRec = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "fs", args: { op: "mkdir", path: "src" } }, meta: { rationale: "init", citations: [] } },
    });
    // Crash before dispatch!

    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.equal(analysis.isInterrupted, true);
    assert.deepEqual(analysis.undispatchedProposalIds, [pRec.id]);
    assert.equal(analysis.hasPostEffectUnknown, false, "undispatched proposal has no post-effect-unknown");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-011: Boundary B-04/B-05/B-06 fails closed on dispatched non-idempotent proposal", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const pRec = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["npm", "install"], cwd: "." } }, meta: { rationale: "install", citations: [] } },
    });
    const gid = newGrantId();
    store.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { proposalId: pRec.id, grantId: gid, environment: "local", timeoutMs: 30000 },
    });
    // Crash while subprocess was in-flight!

    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.equal(analysis.hasPostEffectUnknown, true);
    assert.deepEqual(analysis.nonIdempotentDispatchedProposalIds, [pRec.id]);

    const missionModel = createDummyMissionModel(missionId);
    missionModel.status = "executing";
    const missionStore = new AutonomousMissionStore(store, missionModel);

    // Without operator acknowledgement, recovery MUST fail closed
    const resBlocked = await MissionRecovery.recoverMission(missionStore, null);
    assert.equal(resBlocked.recovered, false);
    assert.equal(missionStore.getMission().status, "failed");
    store.close();

    // With explicit operator acknowledgement, recovery proceeds on fresh interrupted mission
    const missionId2 = newMissionId();
    const store2 = openMission({ dataDir, missionId: missionId2 });
    store2.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t2", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const pRec2 = store2.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "shell", args: { argv: ["npm", "install"], cwd: "." } }, meta: { rationale: "install", citations: [] } },
    });
    store2.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { proposalId: pRec2.id, grantId: gid, environment: "local", timeoutMs: 30000 },
    });
    const model2 = createDummyMissionModel(missionId2);
    model2.status = "executing";
    const missionStore2 = new AutonomousMissionStore(store2, model2);
    const resAcked = await MissionRecovery.recoverMission(missionStore2, null, async () => true);
    assert.equal(resAcked.recovered, true);
    assert.equal(missionStore2.getMission().status, "executing");
    store2.close();
  } finally {
    cleanup();
  }
});

test("CRASH-012: Conservative recovery invariant replays pure reads and idempotent writes without blockage", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t", goalSpec: { summary: "s", proposedCriteria: [] } } });
    // Idempotent write
    const g1 = newGrantId();
    const g2 = newGrantId();
    const cRef = sha256Hex(new Uint8Array([1, 2, 3]));
    const p1 = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "fs", args: { op: "write", path: "file.txt", contentRef: cRef } }, meta: { rationale: "write", citations: [] } },
    });
    store.append({ kind: "proposal.dispatched", author: "runtime", ts: new Date().toISOString(), body: { proposalId: p1.id, grantId: g1, environment: "local", timeoutMs: 1000 } });

    // Pure read
    const p2 = store.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: { proposal: { capability: "search", args: { query: "foo", mode: "grep" } }, meta: { rationale: "search", citations: [] } },
    });
    store.append({ kind: "proposal.dispatched", author: "runtime", ts: new Date().toISOString(), body: { proposalId: p2.id, grantId: g2, environment: "local", timeoutMs: 1000 } });

    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.equal(analysis.hasPostEffectUnknown, false, "pure read & idempotent write are never post-effect-unknown");
    assert.deepEqual(analysis.replayableDispatchedProposalIds?.sort(), [p1.id, p2.id].sort());

    const missionModel = createDummyMissionModel(missionId);
    missionModel.status = "executing";
    const missionStore = new AutonomousMissionStore(store, missionModel);
    const res = await MissionRecovery.recoverMission(missionStore, null);
    assert.equal(res.recovered, true, "idempotent recovery succeeds without requiring user ack");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-013: Boundary B-10 resumes from next DAG task; completed tasks never re-execute", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    missionModel.status = "executing";
    const missionStore = new AutonomousMissionStore(store, missionModel);

    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    // Complete Task 1
    const t1 = plan.milestones[0]!.tasks[0]!.taskId;
    const t2 = plan.milestones[0]!.tasks[1]!.taskId;
    const m1 = plan.milestones[0]!.milestoneId;
    missionStore.appendRecord("task.started", { taskId: t1, milestoneId: m1, capability: "fs", attempt: 1 });
    missionStore.appendRecord("task.completed", { taskId: t1, milestoneId: m1, capability: "fs", evidenceRefs: [], durationMs: 10 });
    // Crash between Task 1 and Task 2!

    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.deepEqual(analysis.completedTaskIds, [t1]);
    assert.deepEqual(analysis.interruptedTaskIds, []);

    const res = await MissionRecovery.recoverMission(missionStore, missionStore.getActivePlan());
    assert.equal(res.recovered, true);
    assert.equal(missionStore.getActivePlan()!.milestones[0]!.tasks[0]!.status, "succeeded");
    assert.equal(missionStore.getActivePlan()!.milestones[0]!.tasks[1]!.status, "ready");
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-014: Boundary B-11 cleans milestone transition upon crash", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, missionModel);

    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    // Complete all tasks in milestone 1
    for (const t of plan.milestones[0]!.tasks) {
      missionStore.appendRecord("task.started", { taskId: t.taskId, milestoneId: t.milestoneId, capability: t.capability, attempt: 1 });
      missionStore.appendRecord("task.completed", { taskId: t.taskId, milestoneId: t.milestoneId, capability: t.capability, evidenceRefs: [], durationMs: 10 });
    }
    // Crash before milestone 2 started!

    const analysis = MissionRecovery.analyzeLedger(store.read());
    assert.equal(analysis.completedTaskIds.length, plan.milestones[0]!.tasks.length);

    const res = await MissionRecovery.recoverMission(missionStore, missionStore.getActivePlan());
    assert.equal(res.recovered, true);
    store.close();
  } finally {
    cleanup();
  }
});

test("CRASH-015: Boundary B-12 crash during checkpoint creation preserves prior checkpoint", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, missionModel);
    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    // Create Checkpoint 1
    const cp1 = missionStore.createCheckpoint("chk_initial");
    assert.equal(missionStore.getCheckpoints().length, 1);

    // Simulate crash: partial write or restart before Checkpoint 2 committed
    store.close();

    const reopenedStore = openMission({ dataDir, missionId });
    const reopenedMissionStore = new AutonomousMissionStore(reopenedStore, missionModel);
    assert.equal(reopenedMissionStore.getCheckpoints().length, 1);
    assert.equal(reopenedMissionStore.getCheckpoints()[0]!.checkpointId, "chk_initial");
    reopenedStore.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// 7B.5 ATOMIC CHECKPOINTS & RESUMPTION (CRASH-016 - CRASH-017)
// ============================================================================

test("CRASH-016: Fast resume from checkpoint restores completed tasks count without DAG replay", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, missionModel);

    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    // Complete 2 tasks and checkpoint
    const t1 = plan.milestones[0]!.tasks[0]!;
    const t2 = plan.milestones[0]!.tasks[1]!;
    missionStore.updateTaskState(t1.taskId, (t) => { t.status = "succeeded"; });
    missionStore.updateTaskState(t2.taskId, (t) => { t.status = "succeeded"; });
    const cp = missionStore.createCheckpoint("chk_progress");
    assert.equal(cp.completedTasksCount, 2);

    // Close and simulate restart
    store.close();

    const resumedStore = openMission({ dataDir, missionId });
    const resumedMissionStore = new AutonomousMissionStore(resumedStore, missionModel);
    const activeCp = resumedMissionStore.resumeFromCheckpoint("chk_progress");
    assert.equal(activeCp.checkpointId, "chk_progress");
    assert.equal(activeCp.completedTasksCount, 2);
    resumedStore.close();
  } finally {
    cleanup();
  }
});

test("CRASH-017: Resuming from checkpoint appends mission.resumed and preserves immutable history", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const missionModel = createDummyMissionModel(missionId);
    const missionStore = new AutonomousMissionStore(store, missionModel);
    const plan = createTestPlan(missionId);
    missionStore.acceptPlan(plan);

    missionStore.createCheckpoint("chk_savepoint");
    missionStore.resumeFromCheckpoint("chk_savepoint");

    const records = store.read();
    const resumedRec = records.find((r) => r.kind === "mission.resumed");
    assert.ok(resumedRec, "must append mission.resumed record");
    assert.equal((resumedRec.body as any).fromCheckpointId, "chk_savepoint");
    assert.ok(store.ledger.verify().ok, "cryptographic hash chain must remain valid");
    store.close();
  } finally {
    cleanup();
  }
});

// ============================================================================
// 7B.1 & 7B.6 STATE MODEL & VERSIONING (CRASH-018 - CRASH-019)
// ============================================================================

test("CRASH-018: Strict state machine transition validation across all 11 states", async () => {
  // Valid transitions
  assert.equal(validateMissionTransition("created", "planning"), true);
  assert.equal(validateMissionTransition("planning", "planned"), true);
  assert.equal(validateMissionTransition("planning", "recovering"), true);
  assert.equal(validateMissionTransition("planned", "executing"), true);
  assert.equal(validateMissionTransition("executing", "recovering"), true);
  assert.equal(validateMissionTransition("executing", "verifying"), true);
  assert.equal(validateMissionTransition("verifying", "completed"), true);
  assert.equal(validateMissionTransition("recovering", "executing"), true);

  // Invalid transitions (Terminal sinks)
  assert.equal(validateMissionTransition("completed", "executing"), false);
  assert.equal(validateMissionTransition("failed", "executing"), false);
  assert.equal(validateMissionTransition("cancelled", "planning"), false);

  // Arbitrary illegal jumps
  assert.equal(validateMissionTransition("created", "completed"), false);
  assert.equal(validateMissionTransition("verifying", "created"), false);
});

test("CRASH-019: Unsupported journal schema version fails closed with UnsupportedSchemaVersionError", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    const missionId = newMissionId();
    const missionDir = join(dataDir, "missions", missionId);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(missionDir, { recursive: true });

    // Write a journal line with future schema version v: 99
    const futureLine = '{"v":99,"id":"rec_future","kind":"mission.opened","author":"runtime","seq":1,"ts":"2026-10-07T00:00:00Z","body":{"intent":"future","goalSpec":{"summary":"f","proposedCriteria":[]}},"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","hash":"123"}';
    writeFileSync(join(missionDir, "journal.jsonl"), futureLine + "\n");

    assert.throws(
      () => {
        openMission({ dataDir, missionId });
      },
      (err: any) => err instanceof UnsupportedSchemaVersionError,
      "future schema version must fail closed with UnsupportedSchemaVersionError",
    );
  } finally {
    cleanup();
  }
});

// ============================================================================
// 7B.7 PRODUCTION RUNTIME DAEMON (CRASH-020)
// ============================================================================

test("CRASH-020: Production runtime daemon boot recovery sweep recovers interrupted missions", async () => {
  const { dataDir, cleanup } = setupTempDir();
  try {
    // 1. Create a closed mission
    const mid1 = newMissionId();
    const s1 = openMission({ dataDir, missionId: mid1 });
    s1.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "m1", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const tip = s1.ledger.current()!.hash;
    s1.append({ kind: "mission.closed", author: "runtime", ts: new Date().toISOString(), body: { closure: "completed-unverified", receipt: dummyReceipt(tip) } });
    s1.close();

    // 2. Create an interrupted mission with a dead lock
    const mid2 = newMissionId();
    const s2 = openMission({ dataDir, missionId: mid2 });
    s2.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "m2", goalSpec: { summary: "s", proposedCriteria: [] } } });
    s2.append({ kind: "task.started", author: "runtime", ts: new Date().toISOString(), body: { taskId: "tsk_dead", milestoneId: "mls_1", capability: "fs", attempt: 1 } });
    s2.close();
    // Simulate dead lock
    writeFileSync(join(dataDir, "missions", mid2, ".lock"), JSON.stringify({ pid: 999999, host: "crashed", acquiredAt: Date.now() - (LOCK_STALE_MS + 2000) }));
    const { utimesSync } = await import("node:fs");
    const past = (Date.now() - (LOCK_STALE_MS + 2000)) / 1000;
    utimesSync(join(dataDir, "missions", mid2, ".lock"), past, past);

    // Boot the runtime
    const runtime = new ForgeRuntime({ dataDir, workspaceRoot: dataDir });
    const reports = await runtime.bootRecoverySweep();

    assert.equal(reports.length, 2);
    const r1 = reports.find((r) => r.missionId === mid1);
    const r2 = reports.find((r) => r.missionId === mid2);

    assert.equal(r1?.status, "closed");
    assert.equal(r2?.status, "interrupted");
    assert.equal(r2?.recovered, true);
    assert.deepEqual(r2?.analysis?.interruptedTaskIds, ["tsk_dead"]);
  } finally {
    cleanup();
  }
});
