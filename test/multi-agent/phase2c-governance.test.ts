// FORGE Step 8 Phase 2C-2 Acceptance Tests: Transactional Governance
// Tests: P2C-004, P2C-005, P2C-006, P2C-010, P2C-012, P2C-RACE-003.

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
  DepthLimitExceededError,
  FanoutLimitExceededError,
  CycleDetectedError,
} from "../../src/multi-agent/registry.js";
import {
  BudgetEscrowManager,
  BudgetBelowMinimumFloorError,
  InsufficientBudgetError,
  UncertainBudgetRefundError,
} from "../../src/multi-agent/budget-escrow.js";
import {
  GovernedReservationCoordinator,
  type DelegationReservationRequest,
} from "../../src/multi-agent/reservation-coordinator.js";

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
// P2C-004: Grandchild (Depth 2) cannot delegate further (Depth 3 banned)
// ============================================================================
test("P2C-004: Grandchild at depth 2 proposing delegation fails closed with DepthLimitExceededError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c004-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const grandchildDelId = `del_${ulidBody()}` as DelegationId;

    // Register child (depth 1)
    const childEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(childEntry);

    // Register grandchild (depth 2) under child
    const grandchildEntry = createMockEntry(grandchildDelId, parentDelId, 2, [parentDelId, grandchildDelId]);
    registry.registerDelegation(grandchildEntry);

    // Now grandchild (depth 2) attempts to delegate to great-grandchild (depth 3)
    const greatGrandchildDelId = `del_${ulidBody()}` as DelegationId;
    const request: DelegationReservationRequest = {
      delegationId: greatGrandchildDelId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      entry: createMockEntry(greatGrandchildDelId, grandchildDelId, 3, [parentDelId, grandchildDelId, greatGrandchildDelId]),
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: grandchildDelId,
          request,
          registry,
          budgetManager,
        });
      },
      (err: any) => {
        assert(err instanceof DepthLimitExceededError);
        assert.match(err.message, /Delegation depth 2 reached or exceeds maximum/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-005: Parent planner attempts 4th concurrent child (Fanout limit F <= 3)
// ============================================================================
test("P2C-005: Parent attempting 4th active child fails closed with FanoutLimitExceededError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c005-"));
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

    // Spawn 3 active children successfully
    for (let i = 1; i <= 3; i++) {
      const childDelId = `del_${ulidBody()}` as DelegationId;
      const childReq: DelegationReservationRequest = {
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
      await GovernedReservationCoordinator.executeReservationTransaction({
        parentDelegationId: parentDelId,
        request: childReq,
        registry,
        budgetManager,
      });
    }

    assert.equal(registry.getActiveChildCount(parentDelId), 3);

    // Attempt 4th child -> must throw FanoutLimitExceededError
    const fourthChildDelId = `del_${ulidBody()}` as DelegationId;
    const fourthReq: DelegationReservationRequest = {
      delegationId: fourthChildDelId,
      budget: {
        ...DEFAULT_BUDGET,
        maxTokens: 20_000,
        maxModelCalls: 5,
        maxCapabilityCalls: 5,
        maxExecutionTimeMs: 10_000,
        maxArtifactBytes: 1024 * 1024,
      },
      entry: createMockEntry(fourthChildDelId, parentDelId, 2, [parentDelId, fourthChildDelId]),
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: fourthReq,
          registry,
          budgetManager,
        });
      },
      (err: any) => {
        assert(err instanceof FanoutLimitExceededError);
        assert.match(err.message, /Active child count reached maximum fanout limit of 3/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-006: Ancestor cycle detection in proposal path fails closed
// ============================================================================
test("P2C-006: Ancestor path containing cycle fails closed with CycleDetectedError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c006-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childDelId = `del_${ulidBody()}` as DelegationId;

    // Craft cyclical ancestorPath: [parentDelId, childDelId, parentDelId]
    const cyclicEntry = createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId, parentDelId]);
    const cyclicReq: DelegationReservationRequest = {
      delegationId: childDelId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      entry: cyclicEntry,
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: cyclicReq,
          registry,
          budgetManager,
        });
      },
      (err: any) => {
        assert(err instanceof CycleDetectedError);
        assert.match(err.message, /Ancestor cycle detected in delegation path/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-010: Budget micro-allocation (< 10,000 tokens) rejected by floor check
// ============================================================================
test("P2C-010: Delegation proposed with fewer than 10,000 tokens fails closed with BudgetBelowMinimumFloorError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c010-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 500_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childDelId = `del_${ulidBody()}` as DelegationId;
    // Micro-allocation: 5,000 tokens (< 10,000 tokens)
    const microAllocReq: DelegationReservationRequest = {
      delegationId: childDelId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 5_000 },
      entry: createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]),
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: microAllocReq,
          registry,
          budgetManager,
          enforceTokenFloor: true,
        });
      },
      (err: any) => {
        assert(err instanceof BudgetBelowMinimumFloorError);
        assert.match(err.message, /below minimum floor of 10000 tokens/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-011: Child crashes mid-execution; escrow frozen as UNCERTAIN; direct refund blocked
// ============================================================================
test("P2C-011: Child crashes mid-execution; escrow frozen as UNCERTAIN; direct refund blocked", async () => {
  const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 100_000 });
  const childDelId = `del_${ulidBody()}` as DelegationId;

  // Reserve 50,000 tokens
  budgetManager.atomicReserveEscrow(childDelId, { ...DEFAULT_BUDGET, maxTokens: 50_000 });
  budgetManager.activateEscrow(childDelId);

  // Child consumes 40,000 tokens (80% spend)
  budgetManager.recordSpend(childDelId, {
    tokens: 40_000,
    modelCalls: 5,
    capabilityCalls: 5,
    executionTimeMs: 10_000,
    artifactBytes: 1024,
  });

  // Child crashes abruptly -> handleCrashOrAbruptTermination
  budgetManager.handleCrashOrAbruptTermination(childDelId);

  const entry = budgetManager.getEscrow(childDelId);
  assert.equal(entry?.state, "UNCERTAIN");
  assert.equal(entry?.uncertain, true);

  // Attempting to directly refund UNCERTAIN escrow must throw UncertainBudgetRefundError
  assert.throws(
    () => {
      budgetManager.refundUncertainDirectly(childDelId);
    },
    (err: any) => {
      assert(err instanceof UncertainBudgetRefundError);
      assert.match(err.message, /Automatic refund of UNCERTAIN budget escrow/);
      return true;
    },
  );
});

// ============================================================================
// P2C-012: Child cannot sub-allocate more budget than available (Conservation Law)
// ============================================================================
test("P2C-012: Sub-allocation exceeding available budget fails closed with InsufficientBudgetError", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c012-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    // Budget pool has 50,000 tokens available
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 50_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    const childDelId = `del_${ulidBody()}` as DelegationId;
    // Attempting to reserve 80,000 tokens (> 50,000 available)
    const overAllocReq: DelegationReservationRequest = {
      delegationId: childDelId,
      budget: { ...DEFAULT_BUDGET, maxTokens: 80_000 },
      entry: createMockEntry(childDelId, parentDelId, 2, [parentDelId, childDelId]),
    };

    await assert.rejects(
      async () => {
        await GovernedReservationCoordinator.executeReservationTransaction({
          parentDelegationId: parentDelId,
          request: overAllocReq,
          registry,
          budgetManager,
        });
      },
      (err: any) => {
        assert(err instanceof InsufficientBudgetError);
        assert.match(err.message, /Insufficient available budget/);
        return true;
      },
    );

    // Conservation law preserved: Available remains exactly 50,000
    assert.equal(budgetManager.getAvailableBudget().maxTokens, 50_000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-RACE-003: CAS budget reservation race where A + B > Available
// ============================================================================
test("P2C-RACE-003: Two concurrent delegations race for budget; exactly one succeeds, second fails closed", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c-race003-"));
  try {
    const registry = new DelegationRegistry(join(tmpDir, "registry.json"));
    // Initial available budget is 50,000 tokens
    const budgetManager = new BudgetEscrowManager({ ...DEFAULT_BUDGET, maxTokens: 50_000 });

    const parentDelId = `del_${ulidBody()}` as DelegationId;
    const parentEntry = createMockEntry(parentDelId, null, 1, [parentDelId]);
    registry.registerDelegation(parentEntry);

    // Two tasks A and B each request 35,000 tokens (35k + 35k = 70k > 50k Available)
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

    // Race both simultaneously
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

    // Exactly one reservation succeeded
    assert.equal(fulfilled.length, 1, "Exactly one concurrent reservation must succeed");
    // Exactly one reservation failed
    assert.equal(rejected.length, 1, "Exactly one concurrent reservation must fail");

    const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
    assert(rejectionReason instanceof InsufficientBudgetError);

    // Remaining available is exactly 50,000 - 35,000 = 15,000
    assert.equal(budgetManager.getAvailableBudget().maxTokens, 15_000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
