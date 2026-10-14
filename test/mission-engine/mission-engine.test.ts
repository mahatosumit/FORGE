// test/mission-engine/mission-engine.test.ts
// Comprehensive test suite for the FORGE Autonomous Mission Engine (Step 4)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  AutonomousMissionRunner,
  AutonomousMissionStore,
  DeterministicPlanner,
  FailureAnalyzer,
  MissionRecovery,
  VerificationEngine,
  DelegationManager,
  DelegationError,
  validateTaskGraph,
  getReadyTasks,
  isMilestoneComplete,
  newPlanId,
  newMilestoneId,
  newTaskId,
  MissionStateTransitionError,
  MissionBudgetExceededError,
} from "../../src/mission-engine/index.js";
import {
  openMission,
} from "../../src/ledger/index.js";
import { GrantStore, newMissionId } from "../../src/grants/grants.js";
import { LocalEnvironment, sha256Hex } from "../../src/environments/local.js";
import type { Plan, Milestone, Task } from "../../src/contracts/plan.js";
import type { CriterionExpr, Sha256Hex, MissionId } from "../../src/contracts/index.js";

function setupEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-test-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-test-ws-"));
  return {
    dataDir,
    workspaceRoot,
    cleanup() {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

test("Mission Engine: State transition enforcement and illegal transition rejection", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store } = await runner.createMission("Test mission state transitions");

    assert.equal(store.getMission().status, "created");

    // Valid transition: created -> planning
    store.transitionState("planning", "Starting plan generation");
    assert.equal(store.getMission().status, "planning");

    // Valid transition: planning -> planned
    store.transitionState("planned", "Plan generated");
    assert.equal(store.getMission().status, "planned");

    // Valid transition: planned -> executing
    store.transitionState("executing", "Starting execution");
    assert.equal(store.getMission().status, "executing");

    // Illegal transition: executing directly to completed without verifying
    assert.throws(
      () => store.transitionState("completed"),
      (err) => err instanceof MissionStateTransitionError,
    );

    // Valid transition: executing -> verifying
    store.transitionState("verifying", "Running checks");
    assert.equal(store.getMission().status, "verifying");

    // Valid transition: verifying -> completed
    store.transitionState("completed", "Checks passed");
    assert.equal(store.getMission().status, "completed");

    // Terminal state: completed cannot transition to anything
    assert.throws(
      () => store.transitionState("executing"),
      (err) => err instanceof MissionStateTransitionError,
    );

    // Verify ledger has recorded state changes
    const records = store.ledgerStore.read();
    const stateChanges = records.filter((r) => r.kind === "mission.state_changed");
    assert.equal(stateChanges.length, 5);
  } finally {
    cleanup();
  }
});

test("Mission Engine: Plan immutability and versioning", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { store } = await runner.createMission("Test plan immutability");

    const mId = newMilestoneId();
    const tId = newTaskId();
    const planV1: Plan = {
      planId: newPlanId(),
      missionId: store.getMission().missionId,
      version: 1,
      objective: "Initial plan",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "Step 1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: tId,
              milestoneId: mId,
              title: "T1",
              description: "Task 1",
              capability: "search",
              args: { query: "test", mode: "grep" },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 3,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };

    store.acceptPlan(planV1);
    assert.equal(store.getActivePlan()?.planId, planV1.planId);
    assert.equal(store.getActivePlan()?.version, 1);

    // Create revised plan v2 superseding v1
    const planV2: Plan = {
      ...planV1,
      planId: newPlanId(),
      version: 2,
      supersedesPlanId: planV1.planId,
    };

    store.acceptPlan(planV2);
    assert.equal(store.getActivePlan()?.planId, planV2.planId);
    assert.equal(store.getActivePlan()?.version, 2);
    assert.equal(store.getAllPlans().length, 2);

    const acceptedRecords = store.ledgerStore.read().filter((r) => r.kind === "plan.accepted");
    assert.equal(acceptedRecords.length, 2);
  } finally {
    cleanup();
  }
});

test("Mission Engine: Task DAG dependency scheduling and cycle rejection", () => {
  const mId = "mls_1";
  const t1: Task = {
    taskId: "tsk_1",
    milestoneId: mId,
    title: "Task 1",
    description: "",
    capability: "search",
    args: {},
    dependsOn: [],
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    evidenceRefs: [],
    error: null,
  };
  const t2: Task = {
    taskId: "tsk_2",
    milestoneId: mId,
    title: "Task 2",
    description: "",
    capability: "fs",
    args: {},
    dependsOn: ["tsk_1"],
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    evidenceRefs: [],
    error: null,
  };

  const milestone: Milestone = {
    milestoneId: mId,
    objective: "Test DAG",
    dependencies: [],
    tasks: [t1, t2],
    successCriteria: [],
    verificationCriteria: [],
    status: "in_progress",
  };

  // Valid acyclic graph
  const validCheck = validateTaskGraph(milestone);
  assert.equal(validCheck.valid, true);

  // Ready tasks should only be tsk_1 initially
  let ready = getReadyTasks(milestone);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]?.taskId, "tsk_1");

  // Complete tsk_1 -> tsk_2 becomes ready
  t1.status = "succeeded";
  ready = getReadyTasks(milestone);
  assert.equal(ready.length, 1);
  assert.equal(ready[0]?.taskId, "tsk_2");

  t2.status = "succeeded";
  assert.equal(isMilestoneComplete(milestone), true);

  // Introduce cycle: t1 depends on t2, t2 depends on t1
  t1.dependsOn = ["tsk_2"];
  const cycleCheck = validateTaskGraph(milestone);
  assert.equal(cycleCheck.valid, false);
  assert.ok(cycleCheck.cycle && cycleCheck.cycle.length > 0);
});

test("Mission Engine: Mechanical verification engine (zero trust in model claims)", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const env = new LocalEnvironment(workspaceRoot);
    const store = openMission({ dataDir, missionId: newMissionId() });
    const verifier = new VerificationEngine(
      env,
      (sha) => {
        const p = store.ledger.artifactPath(sha);
        return p ? new Uint8Array(require("node:fs").readFileSync(p)) : null;
      },
      (bytes) => {
        const sha = sha256Hex(bytes) as Sha256Hex;
        store.ledger.writeArtifact(bytes, sha);
        return sha;
      },
    );

    // 1. file-state: exists check
    const nonExistentCriterion: CriterionExpr = {
      kind: "file-state",
      path: "missing.txt" as never,
      expect: "exists",
    };
    const failRes = await verifier.evaluateCriterion(nonExistentCriterion);
    assert.equal(failRes.passed, false);
    assert.ok(failRes.reason?.includes("does not exist"));

    // Write file and verify passes
    writeFileSync(join(workspaceRoot, "sample.txt"), "hello world\n", "utf8");
    const existsCriterion: CriterionExpr = {
      kind: "file-state",
      path: "sample.txt" as never,
      expect: "exists",
    };
    const passRes = await verifier.evaluateCriterion(existsCriterion);
    assert.equal(passRes.passed, true);

    // 2. file-state: diff-contains check
    const diffCriterion: CriterionExpr = {
      kind: "file-state",
      path: "sample.txt" as never,
      expect: "diff-contains",
      pattern: "world",
    };
    const diffRes = await verifier.evaluateCriterion(diffCriterion);
    assert.equal(diffRes.passed, true);

    const badDiffCriterion: CriterionExpr = {
      kind: "file-state",
      path: "sample.txt" as never,
      expect: "diff-contains",
      pattern: "not_present",
    };
    const badDiffRes = await verifier.evaluateCriterion(badDiffCriterion);
    assert.equal(badDiffRes.passed, false);

    // 3. file-state: hash check
    const fileBytes = new TextEncoder().encode("hello world\n");
    const expectedHash = createHash("sha256").update(fileBytes).digest("hex") as Sha256Hex;
    const hashCriterion: CriterionExpr = {
      kind: "file-state",
      path: "sample.txt" as never,
      expect: "hash",
      hash: expectedHash,
    };
    const hashRes = await verifier.evaluateCriterion(hashCriterion);
    assert.equal(hashRes.passed, true);
  } finally {
    cleanup();
  }
});

test("Mission Engine: Governed Retry Policy & failure classification", () => {
  const task: Task = {
    taskId: "tsk_test",
    milestoneId: "mls_test",
    title: "Test Task",
    description: "",
    capability: "search",
    args: {},
    dependsOn: [],
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    evidenceRefs: [],
    error: null,
  };

  const budget = {
    maxPlannerTurns: 50,
    maxCapabilityCalls: 100,
    maxRetries: 5,
    maxExecutionTimeMs: 3600_000,
    maxArtifactBytes: 100_000_000,
    maxConcurrentTasks: 1,
  };

  // 1. Security violation (Gate rejection) is NON-RETRYABLE
  const secCategory = FailureAnalyzer.classifyError(new Error("rejected-gate out-of-grant"), "fs", true);
  assert.equal(secCategory, "security_violation");
  const secEval = FailureAnalyzer.evaluateRetry(task, secCategory, budget, "rejected-gate");
  assert.equal(secEval.retryable, false);
  assert.equal(secEval.recommendation, "escalate");

  // 2. Transient error is RETRYABLE with exponential backoff
  const transientCategory = FailureAnalyzer.classifyError(new Error("HTTP 429 rate limit exceeded"), "http");
  assert.equal(transientCategory, "transient");
  const transientEval = FailureAnalyzer.evaluateRetry(task, transientCategory, budget, "rate limit");
  assert.equal(transientEval.retryable, true);
  assert.ok(transientEval.delayMs >= 200);
  assert.equal(transientEval.recommendation, "retry");

  // 3. Max attempts reached triggers replan
  task.attempt = 3;
  const maxAttemptEval = FailureAnalyzer.evaluateRetry(task, "capability_error", budget, "exit 1");
  assert.equal(maxAttemptEval.retryable, false);
  assert.equal(maxAttemptEval.recommendation, "replan");
});

test("Mission Engine: Scoped delegation with grant attenuation and budget bounding", () => {
  const delegationManager = new DelegationManager(2);

  const parentMission = {
    missionId: "mis_parent" as MissionId,
    intent: "Parent",
    budget: {
      maxPlannerTurns: 20,
      maxCapabilityCalls: 50,
      maxRetries: 10,
      maxExecutionTimeMs: 100_000,
      maxArtifactBytes: 10_000_000,
      maxConcurrentTasks: 1,
    },
    budgetConsumed: {
      plannerTurns: 5,
      capabilityCalls: 10,
      retries: 2,
      executionTimeMs: 10_000,
      artifactBytes: 1_000_000,
    },
  } as never;

  const parentGrants = [
    {
      id: "grt_1" as never,
      capability: "search",
      constraints: {},
      expiresAt: null,
      issuer: "base-policy" as never,
      parentGrantId: null,
    },
    {
      id: "grt_2" as never,
      capability: "fs",
      constraints: { paths: ["src/*" as never] },
      expiresAt: null,
      issuer: "base-policy" as never,
      parentGrantId: null,
    },
  ];

  // Valid delegation: child grant is subset of parent grants
  const validSpec = {
    delegationId: "dlg_1",
    parentMissionId: "mis_parent" as MissionId,
    objective: "Sub-task",
    scopedCapabilities: ["search"],
    scopedGrants: [
      {
        id: "grt_child" as never,
        capability: "search",
        constraints: {},
        expiresAt: null,
        issuer: "escalation" as never,
        parentGrantId: "grt_1" as never,
      },
    ],
    budget: {
      maxPlannerTurns: 5,
      maxCapabilityCalls: 10,
      maxRetries: 2,
      maxExecutionTimeMs: 10_000,
      maxArtifactBytes: 1_000_000,
      maxConcurrentTasks: 1,
    },
    deadline: null,
    successCriteria: [],
  };

  const delegated = delegationManager.createDelegation(parentMission, validSpec, parentGrants, 0);
  assert.ok(delegated.childMissionId.startsWith("mis_"));

  // Invalid delegation 1: child grant exceeds parent grants (e.g. ungranted capability "shell")
  const invalidSpec = {
    ...validSpec,
    scopedGrants: [
      {
        id: "grt_bad" as never,
        capability: "shell",
        constraints: {},
        expiresAt: null,
        issuer: "escalation" as never,
        parentGrantId: null,
      },
    ],
  };
  assert.throws(
    () => delegationManager.createDelegation(parentMission, invalidSpec, parentGrants, 0),
    (err) => err instanceof DelegationError && err.message.includes("INV-9 violation"),
  );

  // Invalid delegation 2: child budget exceeds remaining parent budget (remaining turns = 15, asking 25)
  const overBudgetSpec = {
    ...validSpec,
    budget: {
      ...validSpec.budget,
      maxPlannerTurns: 25,
    },
  };
  assert.throws(
    () => delegationManager.createDelegation(parentMission, overBudgetSpec, parentGrants, 0),
    (err) => err instanceof DelegationError && err.message.includes("exceeds parent remaining"),
  );

  // Invalid delegation 3: depth limit exceeded (currentDepth = 2, max = 2)
  assert.throws(
    () => delegationManager.createDelegation(parentMission, validSpec, parentGrants, 2),
    (err) => err instanceof DelegationError && err.message.includes("Max delegation depth"),
  );
});

test("Mission Engine: Budget enforcement halts execution mechanically", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({
      dataDir,
      workspaceRoot,
      defaultBudget: {
        maxPlannerTurns: 2, // very small limit
        maxCapabilityCalls: 5,
        maxRetries: 1,
      },
    });

    const { missionId } = await runner.createMission("Test budget exhaustion", {
      budget: { maxPlannerTurns: 1 },
    });

    // Run mission with budget limit 1 turn
    await assert.rejects(
      async () => {
        await runner.runMission(missionId);
      },
      (err) => err instanceof MissionBudgetExceededError && err.budgetKind === "maxPlannerTurns",
    );
  } finally {
    cleanup();
  }
});

test("Mission Engine: Authority Gate enforcement rejects ungranted capabilities in autonomous loop", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    // Provide a custom planner proposing an ungranted fs write
    const customPlanner = new DeterministicPlanner((ctx) => {
      const mId = newMilestoneId();
      const tId = newTaskId();
      return {
        planId: newPlanId(),
        missionId: ctx.mission.missionId,
        version: 1,
        objective: "Unauthorized write attempt",
        assumptions: [],
        milestones: [
          {
            milestoneId: mId,
            objective: "Write restricted file",
            dependencies: [],
            status: "pending",
            successCriteria: [],
            verificationCriteria: [],
            tasks: [
              {
                taskId: tId,
                milestoneId: mId,
                title: "Write secret file",
                description: "Write without grant",
                capability: "fs",
                args: { op: "write", path: "secret.txt", contentRef: "0000000000000000000000000000000000000000000000000000000000000000" },
                dependsOn: [],
                status: "pending",
                attempt: 0,
                maxAttempts: 1,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
        ],
        dependencies: {},
        verificationStrategy: "mechanical",
        createdAt: new Date().toISOString() as never,
        supersedesPlanId: null,
        immutable: true,
      };
    });

    const governedRunner = new AutonomousMissionRunner({
      dataDir,
      workspaceRoot,
      planner: customPlanner,
    });

    const { missionId, store } = await governedRunner.createMission("Attempt unauthorized file write");

    // Run mission with zero grants -> Gate will reject with out-of-grant / rejected-gate
    const snapshot = await governedRunner.runMission(missionId, []);

    // Mission must be failed or blocked due to authority gate
    assert.ok(snapshot.status === "failed" || snapshot.status === "blocked");
    const records = store.ledgerStore.read();
    assert.ok(records.some((r) => r.kind === "proposal.validated" && (r.body as any).result === "rejected-gate"));
    assert.ok(records.some((r) => r.kind === "task.failed" || r.kind === "grant.requested"));
  } finally {
    cleanup();
  }
});

test("Mission Engine: End-to-end governed autonomous mission execution", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    // Setup sample files in workspace
    writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ name: "forge-autonomous-demo" }), "utf8");

    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });

    // Define success criteria: package.json must exist
    const criteria: CriterionExpr[] = [
      {
        kind: "file-state",
        path: "package.json" as never,
        expect: "exists",
      },
    ];

    const { missionId } = await runner.createMission("Inspect and verify workspace", {
      criteria,
    });

    // Initial grant: read-only search grant
    const initialGrants = [
      {
        id: "grt_search" as never,
        capability: "search",
        constraints: {},
        expiresAt: null,
        issuer: "base-policy" as never,
        parentGrantId: null,
      },
    ];

    const snapshot = await runner.runMission(missionId, initialGrants);

    // Assert successful completion
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.progressPercent, 100);
    assert.ok(snapshot.completedTasksCount >= 1);
    assert.ok(snapshot.ledgerHeadHash !== null);

    // Verify all 13 new Step 4 records are validly supported
    const records = runner.getMissionHandle(missionId).store.ledgerStore.read();
    const kinds = new Set(records.map((r) => r.kind));

    assert.ok(kinds.has("mission.created"));
    assert.ok(kinds.has("mission.state_changed"));
    assert.ok(kinds.has("plan.accepted"));
    assert.ok(kinds.has("task.started"));
    assert.ok(kinds.has("task.completed"));
    assert.ok(kinds.has("verification.started"));
    assert.ok(kinds.has("verification.completed"));
    assert.ok(kinds.has("checkpoint.created"));
    assert.ok(kinds.has("mission.completed"));

    // Check ledger cryptographic integrity
    const ledgerVerify = runner.getMissionHandle(missionId).store.ledgerStore.ledger.verify();
    assert.equal(ledgerVerify.ok, true);
  } finally {
    cleanup();
  }
});

test("Mission Engine: Crash consistency and idempotency on recovery", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { missionId, store } = await runner.createMission("Interrupted mission test");

    // Formulate a 2-task plan
    const mId = newMilestoneId();
    const t1Id = newTaskId();
    const t2Id = newTaskId();
    const plan: Plan = {
      planId: newPlanId(),
      missionId,
      version: 1,
      objective: "Interrupted workflow",
      assumptions: [],
      milestones: [
        {
          milestoneId: mId,
          objective: "M1",
          dependencies: [],
          status: "pending",
          successCriteria: [],
          verificationCriteria: [],
          tasks: [
            {
              taskId: t1Id,
              milestoneId: mId,
              title: "T1",
              description: "First task",
              capability: "search",
              args: {},
              dependsOn: [],
              status: "succeeded",
              attempt: 1,
              maxAttempts: 3,
              evidenceRefs: [],
              error: null,
            },
            {
              taskId: t2Id,
              milestoneId: mId,
              title: "T2",
              description: "Second task",
              capability: "search",
              args: {},
              dependsOn: [t1Id],
              status: "pending",
              attempt: 0,
              maxAttempts: 3,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical",
      createdAt: new Date().toISOString() as never,
      supersedesPlanId: null,
      immutable: true,
    };

    store.acceptPlan(plan);
    store.transitionState("planning");
    store.transitionState("planned");
    store.transitionState("executing");

    // Simulate task 1 completed in ledger
    store.appendRecord("task.started", { taskId: t1Id, milestoneId: mId, capability: "search", attempt: 1 });
    store.appendRecord("task.completed", { taskId: t1Id, milestoneId: mId, capability: "search", evidenceRefs: [], durationMs: 10 });

    // Simulate task 2 started but crashed before completion
    store.appendRecord("task.started", { taskId: t2Id, milestoneId: mId, capability: "search", attempt: 1 });

    // Ledger analysis
    const analysis = MissionRecovery.analyzeLedger(store.ledgerStore.read());
    assert.equal(analysis.isInterrupted, true);
    assert.equal(analysis.completedTaskIds.includes(t1Id), true);
    assert.equal(analysis.interruptedTaskIds.includes(t2Id), true);

    // Run recovery
    const res = await MissionRecovery.recoverMission(store, plan);
    assert.equal(res.recovered, true);
    assert.equal(res.readyTasks.includes(t2Id), true);
    assert.equal(store.getMission().status, "executing");

    // Task 1 remains succeeded (never re-executed)
    const activePlan = store.getActivePlan();
    assert.equal(activePlan?.milestones[0]?.tasks.find((t) => t.taskId === t1Id)?.status, "succeeded");
    assert.equal(activePlan?.milestones[0]?.tasks.find((t) => t.taskId === t2Id)?.status, "ready");
  } finally {
    cleanup();
  }
});

test("Mission Engine: Mission cancellation via user / abort signal", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    const runner = new AutonomousMissionRunner({ dataDir, workspaceRoot });
    const { missionId } = await runner.createMission("Mission to cancel");

    // Cancel mission explicitly
    const snapshot = await runner.cancelMission(missionId, "User requested cancellation");
    assert.equal(snapshot.status, "cancelled");

    const records = runner.getMissionHandle(missionId).store.ledgerStore.read();
    assert.ok(records.some((r) => r.kind === "mission.cancelled"));
    assert.ok(records.some((r) => r.kind === "mission.state_changed" && (r.body as any).to === "cancelled"));
  } finally {
    cleanup();
  }
});

test("Mission Engine: Multi-milestone execution creates durable checkpoints", async () => {
  const { dataDir, workspaceRoot, cleanup } = setupEnv();
  try {
    writeFileSync(join(workspaceRoot, "doc.txt"), "hello multi-milestone\n", "utf8");

    const m1Id = newMilestoneId();
    const m2Id = newMilestoneId();
    const t1Id = newTaskId();
    const t2Id = newTaskId();

    const multiMilestonePlanner = new DeterministicPlanner((ctx) => {
      return {
        planId: newPlanId(),
        missionId: ctx.mission.missionId,
        version: 1,
        objective: "Multi-milestone workflow",
        assumptions: [],
        milestones: [
          {
            milestoneId: m1Id,
            objective: "Milestone 1: Search",
            dependencies: [],
            status: "pending",
            successCriteria: [],
            verificationCriteria: [],
            tasks: [
              {
                taskId: t1Id,
                milestoneId: m1Id,
                title: "Search workspace",
                description: "Search for doc.txt",
                capability: "search",
                args: { query: "doc.txt", mode: "grep" },
                dependsOn: [],
                status: "pending",
                attempt: 0,
                maxAttempts: 2,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
          {
            milestoneId: m2Id,
            objective: "Milestone 2: Second search",
            dependencies: [m1Id],
            status: "pending",
            successCriteria: [],
            verificationCriteria: [],
            tasks: [
              {
                taskId: t2Id,
                milestoneId: m2Id,
                title: "Search second time",
                description: "Search for hello",
                capability: "search",
                args: { query: "hello", mode: "grep" },
                dependsOn: [],
                status: "pending",
                attempt: 0,
                maxAttempts: 2,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
        ],
        dependencies: { [m2Id]: [m1Id] },
        verificationStrategy: "mechanical",
        createdAt: new Date().toISOString() as never,
        supersedesPlanId: null,
        immutable: true,
      };
    });

    const runner = new AutonomousMissionRunner({
      dataDir,
      workspaceRoot,
      planner: multiMilestonePlanner,
    });

    const { missionId } = await runner.createMission("Execute multi-milestone mission", {
      criteria: [
        {
          kind: "file-state",
          path: "doc.txt" as never,
          expect: "exists",
        },
      ],
    });

    const initialGrants = [
      {
        id: "grt_search" as never,
        capability: "search",
        constraints: {},
        expiresAt: null,
        issuer: "base-policy" as never,
        parentGrantId: null,
      },
    ];

    const snapshot = await runner.runMission(missionId, initialGrants);

    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.completedTasksCount, 2);
    assert.equal(snapshot.totalTasksCount, 2);
    assert.equal(snapshot.progressPercent, 100);

    // Verify multiple checkpoints were created
    assert.ok(snapshot.checkpoints.length >= 2);
    const records = runner.getMissionHandle(missionId).store.ledgerStore.read();
    const checkpoints = records.filter((r) => r.kind === "checkpoint.created");
    assert.ok(checkpoints.length >= 2);
  } finally {
    cleanup();
  }
});

