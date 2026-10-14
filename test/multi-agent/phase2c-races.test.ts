// FORGE Step 8 Phase 2C-6 Dedicated Cross-Vector Race Suite
// Tests: P2C-RACE-001 through P2C-RACE-010.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DelegationBudget,
  type DelegationRegistryEntry,
  type DelegationId,
  type MissionId,
  type AgentId,
  type Sha256Hex,
  ulidBody,
} from "../../src/contracts/index.js";
import {
  DelegationRegistry,
  FanoutLimitExceededError,
} from "../../src/multi-agent/registry.js";
import {
  BudgetEscrowManager,
  InsufficientBudgetError,
  UncertainBudgetRefundError,
} from "../../src/multi-agent/budget-escrow.js";
import {
  GovernedReservationCoordinator,
  InvalidParentStateError,
  InvalidCriterionStateError,
  StalePlanEpochError,
  type DelegationReservationRequest,
} from "../../src/multi-agent/reservation-coordinator.js";
import {
  CriterionStore,
  type MachineCriterion,
} from "../../src/multi-agent/intent-gate.js";
import {
  TaskDag,
  PlanInvalidationEngine,
  AtomicDispatchTransaction,
} from "../../src/multi-agent/plan-engine.js";
import {
  ParentArtifactBroker,
  DeclassificationError,
} from "../../src/multi-agent/information-flow.js";

const DEFAULT_BUDGET: DelegationBudget = {
  maxPlannerTurns: 10,
  maxModelCalls: 20,
  maxTokens: 100_000,
  maxCapabilityCalls: 20,
  maxRetries: 2,
  maxExecutionTimeMs: 120_000,
  maxArtifactBytes: 5 * 1024 * 1024,
  maxConcurrentTasks: 2,
  maxSubprocesses: 2,
};

function createMockEntry(
  delegationId: DelegationId,
  parentDelegationId: DelegationId | null,
  depth: 1 | 2 | 3,
  ancestorPath: DelegationId[],
  budget: DelegationBudget = DEFAULT_BUDGET,
): DelegationRegistryEntry {
  return {
    delegationId,
    parentDelegationId,
    rootMissionId: `mis_${ulidBody()}` as MissionId,
    parentMissionId: `mis_${ulidBody()}` as MissionId,
    childMissionId: `mis_${ulidBody()}` as MissionId,
    parentAgentId: "parent-agent" as AgentId,
    childAgentId: `child-${delegationId}` as AgentId,
    depth,
    ancestorPath,
    childIncarnationEpoch: 1,
    containerId: null,
    hostPid: null,
    grantId: `grt_${ulidBody()}` as any,
    grantRevision: 1,
    effectiveAuthorityHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Sha256Hex,
    effectiveEnvelope: {
      capabilities: ["fs"],
      constraints: { paths: ["workspace/**"] },
      riskCeiling: "read",
      isolationProfile: "sandboxed",
      allowHostExecution: false,
      budgetEscrow: budget,
      expiresAt: null,
      depth,
      maxChildren: 3,
    },
    status: "active",
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  };
}

// ============================================================================
// P2C-RACE-001: delegate + revoke race (zero orphan child)
// ============================================================================
test("P2C-RACE-001: Race between delegate spawn and parent revocation prevents orphaned active child", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race001-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childDelId = `del_${ulidBody()}` as DelegationId;
    const childReq: DelegationReservationRequest = {
      delegationId: childDelId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      entry: createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]),
    };

    // Race parent revocation against child delegation
    const [delResult, revokeResult] = await Promise.allSettled([
      GovernedReservationCoordinator.executeReservationTransaction({
        parentDelegationId: parentDelId,
        request: childReq,
        registry,
        budgetManager,
      }),
      (async () => {
        registry.revokeCascade(parentDelId, "operator emergency abort");
        return "revoked";
      })(),
    ]);

    // Parent must be revoked
    const updatedParent = registry.getDelegation(parentDelId);
    assert.equal(updatedParent?.status, "revoked");

    // If child was registered, it must also be revoked (never left active as an orphan)
    const updatedChild = registry.getDelegation(childDelId);
    if (updatedChild) {
      assert.equal(updatedChild.status, "revoked");
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-002: planEpoch++ + dispatch race (stale task aborted)
// ============================================================================
test("P2C-RACE-002: Race between plan epoch revision and task dispatch aborts stale dispatch cleanly", async () => {
  const dag = new TaskDag(1);

  dag.addTask({
    taskId: "task-T1",
    planEpoch: 1, // Planned under epoch 1
    dependsOn: [],
    status: "ready",
    receiptVerified: true,
  });

  // Race plan epoch bump against dispatch
  const results = await Promise.allSettled([
    (async () => {
      dag.bumpEpoch(); // Replan increments to epoch 2
      return "bumped";
    })(),
    AtomicDispatchTransaction.executeDispatch({
      taskId: "task-T1",
      dag,
      onDispatch: async () => "dispatched",
    }),
  ]);

  const dispatchResult = results[1]!;
  if (dispatchResult.status === "rejected") {
    assert(dispatchResult.reason instanceof StalePlanEpochError);
    assert.equal(dag.getStatus("task-T1"), "invalidated");
  }
});

// ============================================================================
// P2C-RACE-003: CAS reserve(A) + reserve(B) race (exact conservation)
// ============================================================================
test("P2C-RACE-003: CAS budget reservation collision grants exactly one reservation", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race003-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 50_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childAId = `del_${ulidBody()}` as DelegationId;
    const childBId = `del_${ulidBody()}` as DelegationId;

    const reqA: DelegationReservationRequest = {
      delegationId: childAId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 35_000 },
      entry: createMockEntry(childAId, parentDelId, 2, [parentDelId, childAId]),
    };

    const reqB: DelegationReservationRequest = {
      delegationId: childBId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 35_000 },
      entry: createMockEntry(childBId, parentDelId, 2, [parentDelId, childBId]),
    };

    const results = await Promise.allSettled([
      GovernedReservationCoordinator.executeReservationTransaction({
        parentDelegationId: parentDelId,
        request: reqA,
        registry,
        budgetManager,
      }),
      GovernedReservationCoordinator.executeReservationTransaction({
        parentDelegationId: parentDelId,
        request: reqB,
        registry,
        budgetManager,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(budgetManager.getAvailableBudget().maxTokens, 15_000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-004: complete(Crit) + delegate(Crit) race
// ============================================================================
test("P2C-RACE-004: Race between criterion completion and delegation rejects delegation to terminal criterion", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race004-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });
    const criterionStore = new CriterionStore();

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const critId = `cri_${ulidBody()}` as any;
    const criterion: MachineCriterion = {
      criterionId: critId,
      intentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Sha256Hex,
      parentCriterionId: null,
      status: "in_progress",
      allowedContributionTypes: ["code_mutation"],
      completionVerifier: { type: "test_suite" },
      immutableVersion: 1,
    };
    criterionStore.register(criterion);

    // Complete the criterion
    criterionStore.updateStatus(critId, "satisfied");

    const childDelId = `del_${ulidBody()}` as DelegationId;
    const childReq: DelegationReservationRequest = {
      delegationId: childDelId,
      targetCriterionId: critId,
      criterionVersion: 1,
      budget: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      entry: createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]),
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: childReq,
          registry,
          budgetManager,
          criterionStore,
        });
      },
      (err: any) => {
        assert(err instanceof InvalidCriterionStateError);
        assert.match(err.message, /in terminal state "satisfied"/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-005: crash + refund race (UNCERTAIN remains frozen)
// ============================================================================
test("P2C-RACE-005: Direct refund racing against child crash is blocked closed", async () => {
  const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 100_000 });
  const childDelId = `del_${ulidBody()}` as DelegationId;

  budgetManager.atomicReserveEscrow(childDelId, { ...DEFAULT_BUDGET, maxTokens: 50_000 });
  budgetManager.activateEscrow(childDelId);

  // Child crashes abruptly
  budgetManager.handleCrashOrAbruptTermination(childDelId);

  // Direct refund throws UncertainBudgetRefundError
  assert.throws(
    () => {
      budgetManager.refundUncertainDirectly(childDelId);
    },
    (err: any) => {
      assert(err instanceof UncertainBudgetRefundError);
      return true;
    },
  );

  const entry = budgetManager.getEscrow(childDelId);
  assert.equal(entry?.state, "UNCERTAIN");
});

// ============================================================================
// P2C-RACE-006: revoke(Parent) + activate(Child) race
// ============================================================================
test("P2C-RACE-006: Child activation racing against parent revocation fails closed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race006-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childDelId = `del_${ulidBody()}` as DelegationId;
    const childEntry = createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]);
    registry.registerDelegation(childEntry);

    // Operator revokes parent
    registry.revokeCascade(parentDelId, "operator abort");

    // Lineage check fails closed for child
    const lineage = registry.isLineageActive(childDelId);
    assert.equal(lineage.ok, false);
    assert.equal(registry.getDelegation(childDelId)?.status, "revoked");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-007: artifact_handoff + sibling_revoke race (quarantine taint)
// ============================================================================
test("P2C-RACE-007: Artifact handoff from revoked sibling is quarantined and mounting blocked", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race007-"));
  try {
    const broker = new ParentArtifactBroker();
    const childAId = `del_${ulidBody()}` as DelegationId;
    const childBId = `del_${ulidBody()}` as DelegationId;

    const childBWorkspace = join(tmpDir, "childB", "workspace");

    // Child A produces artifact
    const artifactData = Buffer.from(JSON.stringify({ dataset: "pre-revocation output" }));
    const artifactSha = broker.publishArtifact(childAId, artifactData, "CHILD_PRIVATE");

    // Child A is revoked for security breach -> author quarantined
    broker.quarantineAuthor(childAId);

    // Child B attempting to mount Child A's artifact throws DeclassificationError
    assert.throws(
      () => {
        broker.mountArtifactForChild(childBId, artifactSha, childBWorkspace, "data.json");
      },
      (err: any) => {
        assert(err instanceof DeclassificationError);
        assert.match(err.message, /quarantined: author delegation/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-008: 4 concurrent child delegations race for fanout F <= 3
// ============================================================================
test("P2C-RACE-008: 4 concurrent delegation attempts under parent with 0 children: exactly 3 succeed, 4th fails", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race008-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({
      ...DEFAULT_BUDGET,
      maxTokens: 500_000,
      maxModelCalls: 100,
      maxCapabilityCalls: 100,
      maxExecutionTimeMs: 1_000_000,
      maxArtifactBytes: 50 * 1024 * 1024,
    });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    // 4 child requests race simultaneously
    const requests: DelegationReservationRequest[] = [1, 2, 3, 4].map((i) => {
      const childDelId = `del_${ulidBody()}` as DelegationId;
      return {
        delegationId: childDelId,
        budget: {
          ...DEFAULT_BUDGET,
          maxTokens: 20_000,
          maxModelCalls: 5,
          maxCapabilityCalls: 5,
          maxExecutionTimeMs: 10_000,
          maxArtifactBytes: 1024 * 1024,
        },
        entry: createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]),
      };
    });

    const results = await Promise.allSettled(
      requests.map((req) =>
        GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: req,
          registry,
          budgetManager,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 3, "Exactly 3 concurrent child delegations must succeed");
    assert.equal(rejected.length, 1, "Exactly 1 concurrent child delegation must fail");

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    assert(rejectionReason instanceof FanoutLimitExceededError);
    assert.equal(registry.getActiveChildCount(parentDelId), 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-009: Recovery sweep + live execution race
// ============================================================================
test("P2C-RACE-009: Crash recovery sweep and live delegation serialize safely under registry lock", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-race009-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    // Crashed child registered
    const crashedChildId = `del_${ulidBody()}` as DelegationId;
    const crashedEntry = createMockEntry(crashedChildId, parentDelId, 2, [parentDelId, crashedChildId]);
    registry.registerDelegation(crashedEntry);

    // Live child to spawn
    const liveChildId = `del_${ulidBody()}` as DelegationId;
    const liveReq: DelegationReservationRequest = {
      delegationId: liveChildId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      entry: createMockEntry(liveChildId, parentDelId, 2, [parentDelId, liveChildId]),
    };

    // Simulate recovery sweep marking crashed child failed simultaneously with live reservation
    await Promise.all([
      (async () => {
        registry.updateStatus(crashedChildId, "failed");
      })(),
      GovernedReservationCoordinator.executeReservationTransaction({
        parentDelegationId: parentDelId,
        request: liveReq,
        registry,
        budgetManager,
      }),
    ]);

    assert.equal(registry.getDelegation(crashedChildId)?.status, "failed");
    assert.equal(registry.getDelegation(liveChildId)?.status, "active");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-010: Replan cascade invalidation racing against child receipt
// ============================================================================
test("P2C-RACE-010: Replan cascade invalidates task at exact moment child emits receipt; receipt rejected", async () => {
  const dag = new TaskDag(1);

  dag.addTask({
    taskId: "task-T1",
    planEpoch: 1,
    dependsOn: [],
    status: "running",
  });

  dag.addTask({
    taskId: "task-T2",
    planEpoch: 1,
    dependsOn: ["task-T1"],
    status: "blocked",
  });

  // Replan occurs: epoch bumped to 2 and Task T1 marked failed/invalidated
  dag.bumpEpoch();
  PlanInvalidationEngine.cascadeInvalidate("task-T1", dag);

  // Child T1 attempts to deliver receipt under epoch 1
  assert.throws(
    () => {
      PlanInvalidationEngine.verifyReceiptEpoch(1, dag.currentEpoch);
    },
    (err: any) => {
      assert(err instanceof StalePlanEpochError);
      return true;
    },
  );

  assert.equal(dag.getStatus("task-T2"), "invalidated");
});
