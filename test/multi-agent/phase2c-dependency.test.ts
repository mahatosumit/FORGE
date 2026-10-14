// FORGE Step 8 Phase 2C-5 Acceptance Tests: Plan Dependencies, Invalidation & Attenuation
// Tests: P2C-016, P2C-017, P2C-018, P2C-020.

import test from "node:test";
import assert from "node:assert/strict";
import {
  TaskDag,
  PlanInvalidationEngine,
  AtomicDispatchTransaction,
} from "../../src/multi-agent/plan-engine.js";
import {
  DependencyUnsatisfiedError,
  StalePlanEpochError,
} from "../../src/multi-agent/reservation-coordinator.js";
import {
  evaluateProposal,
  type GateCallerContext,
} from "../../src/gate/gate.js";
import type { Proposal, Grant, DelegationId, MissionId, AgentId } from "../../src/contracts/index.js";
import { ulidBody } from "../../src/contracts/base.js";
import type { EffectiveAuthorityEnvelope } from "../../src/contracts/delegation.js";

// ============================================================================
// P2C-016: Task dispatch blocked when prerequisite dependencies are incomplete
// ============================================================================
test("P2C-016: Task dispatch blocked when dependencies are incomplete or unverified", async () => {
  const dag = new TaskDag(1);

  // Task A: prerequisite (not yet completed)
  dag.addTask({
    taskId: "task-A",
    planEpoch: 1,
    dependsOn: [],
    status: "running",
    receiptVerified: false,
  });

  // Task B: depends on Task A
  dag.addTask({
    taskId: "task-B",
    planEpoch: 1,
    dependsOn: ["task-A"],
    status: "pending",
    receiptVerified: false,
  });

  // Dispatch Task B while Task A is not completed -> must fail with DependencyUnsatisfiedError
  await assert.rejects(
    async () => {
      await AtomicDispatchTransaction.executeDispatch({
        taskId: "task-B",
        dag,
        onDispatch: async () => "dispatched",
      });
    },
    (err: any) => {
      assert(err instanceof DependencyUnsatisfiedError);
      assert.match(err.message, /Prerequisite tasks not completed/);
      return true;
    },
  );

  assert.equal(dag.getStatus("task-B"), "blocked");

  // Complete Task A with verified receipt
  dag.updateTaskStatus("task-A", "completed", true);

  // Now dispatch Task B -> must succeed
  const result = await AtomicDispatchTransaction.executeDispatch({
    taskId: "task-B",
    dag,
    onDispatch: async () => "dispatched-successfully",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "dispatched-successfully");
  assert.equal(dag.getStatus("task-B"), "running");
});

// ============================================================================
// P2C-017: Failure of predecessor triggers cascade invalidation of downstream tasks
// ============================================================================
test("P2C-017: Failure of Task A cascades invalidation to dependent Task B and Task C", async () => {
  const dag = new TaskDag(1);

  // Task A -> Task B -> Task C
  dag.addTask({
    taskId: "task-A",
    planEpoch: 1,
    dependsOn: [],
    status: "running",
  });

  dag.addTask({
    taskId: "task-B",
    planEpoch: 1,
    dependsOn: ["task-A"],
    status: "blocked",
  });

  dag.addTask({
    taskId: "task-C",
    planEpoch: 1,
    dependsOn: ["task-B"],
    status: "blocked",
  });

  // Task A fails
  dag.updateTaskStatus("task-A", "failed");

  // Trigger cascade invalidation
  const invalidated = PlanInvalidationEngine.cascadeInvalidate("task-A", dag);

  // Both downstream tasks B and C must be invalidated
  assert.deepEqual(invalidated, ["task-B", "task-C"]);
  assert.equal(dag.getStatus("task-B"), "invalidated");
  assert.equal(dag.getStatus("task-C"), "invalidated");
});

// ============================================================================
// P2C-018: Receipt emitted by child under prior epoch is rejected closed
// ============================================================================
test("P2C-018: Stale child receipt emitted under prior epoch is rejected closed", async () => {
  const currentPlanEpoch = 3;
  const staleReceiptEpoch = 2; // emitted by child before plan was revised

  assert.throws(
    () => {
      PlanInvalidationEngine.verifyReceiptEpoch(staleReceiptEpoch, currentPlanEpoch);
    },
    (err: any) => {
      assert(err instanceof StalePlanEpochError);
      assert.match(err.message, /Receipt plan epoch 2 is stale; current authoritative plan epoch is 3/);
      return true;
    },
  );

  // Non-stale receipt under current epoch passes
  assert.doesNotThrow(() => {
    PlanInvalidationEngine.verifyReceiptEpoch(3, currentPlanEpoch);
  });
});

// ============================================================================
// P2C-020: Parent planner requesting ungranted capability for child fails closed
// ============================================================================
test("P2C-020: Closed-world attenuation rejects child capability not possessed by parent", async () => {
  const parentEnvelope: EffectiveAuthorityEnvelope = {
    capabilities: ["fs"], // Parent only possesses "fs"
    constraints: { paths: ["workspace/**"] },
    riskCeiling: "read",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
    budgetEscrow: {
      maxPlannerTurns: 5,
      maxModelCalls: 10,
      maxTokens: 50_000,
      maxCapabilityCalls: 10,
      maxRetries: 1,
      maxExecutionTimeMs: 60_000,
      maxArtifactBytes: 1024 * 1024,
      maxConcurrentTasks: 1,
      maxSubprocesses: 1,
    },
    expiresAt: null,
    depth: 1,
    maxChildren: 2,
  };

  const parentGrant: Grant = {
    id: `grt_${ulidBody()}` as any,
    missionId: `mis_${ulidBody()}` as MissionId,
    capability: "delegate",
    constraints: { paths: ["workspace/**"] },
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  };

  const targetDelId = `del_${ulidBody()}` as DelegationId;

  // Proposal requests "shell" capability which parent does NOT possess
  const escalatingProposal: Proposal = {
    capability: "delegate",
    args: {
      delegationId: targetDelId,
      parentDelegationId: null,
      parentMissionId: `mis_${ulidBody()}` as MissionId,
      childMissionId: `mis_${ulidBody()}` as MissionId,
      parentAgentId: "parent" as AgentId,
      childAgentId: "child" as AgentId,
      incarnationEpoch: 1,
      grantId: parentGrant.id,
      grantRevision: 1,
      requestedAuthority: {
        capabilities: ["fs", "shell"], // "shell" is not in parentEnvelope.capabilities!
        constraints: { paths: ["workspace/**"] },
      },
      requestedBudget: {
        maxPlannerTurns: 3,
        maxModelCalls: 5,
        maxTokens: 20_000,
        maxCapabilityCalls: 5,
        maxRetries: 1,
        maxExecutionTimeMs: 30_000,
        maxArtifactBytes: 512 * 1024,
        maxConcurrentTasks: 1,
        maxSubprocesses: 1,
      },
      expiry: null,
      topologyMetadata: { depth: 1, ancestorPath: [targetDelId] },
    },
  };

  const gateResult = evaluateProposal(
    escalatingProposal,
    { rationale: "escalation attempt", citations: [] },
    {
      grants: [parentGrant],
      parentEnvelope,
    },
  );

  assert.equal(gateResult.type, "reject");
  assert.equal(gateResult.reasonCode, "attenuation-failed-capabilities");
  assert.match(gateResult.detail, /not covered by parent capabilities/);
});
