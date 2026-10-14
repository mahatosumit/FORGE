// FORGE Multi-Agent Authority Architecture — Step 8 Phase 1 Test Suite
// Verifies all 20 adversarial attack vectors remediated in S8-01 through S8-12:
// Closed-world attenuation, budget conservation, crash accounting, identity canonicalization,
// incarnation epochs, delegation registry, cascade revocation, and topology bounds.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeEffectiveAuthority,
  createAgentIdentity,
  canonicalizeIdentity,
  hashIdentity,
  isEpochAuthoritative,
  nextIncarnationEpoch,
  newDelegationId,
  DelegationRegistry,
  TopologyLimitError,
  CycleDetectedError,
  DelegationRegistryError,
  DelegationNotFoundError,
  BudgetEscrowManager,
  UncertainBudgetRefundError,
  type EffectiveAuthorityEnvelope,
  type ChildRequestedAuthority,
  type DelegationBudget,
  type DelegationRegistryEntry,
  type AgentIdentityTuple,
} from "../../src/multi-agent/index.js";
import {
  type GrantId,
  type MissionId,
  type Sha256Hex,
  type Iso8601,
  ProposalSchema,
} from "../../src/contracts/index.js";

const body = (n: number) => ("01HZZ" + "0".repeat(21) + String(n)).slice(-26);
const makeMisId = (n: number) => `mis_${body(n)}` as MissionId;
const makeGrtId = (n: number) => `grt_${body(n)}` as GrantId;

function makeBaseEnvelope(overrides: Partial<EffectiveAuthorityEnvelope> = {}): EffectiveAuthorityEnvelope {
  return {
    capabilities: ["fs.read", "fs.write", "web.fetch", "mcp.execute"],
    constraints: {
      paths: ["workspace/subtasks"],
      hosts: ["api.openai.com", "api.anthropic.com"],
      methods: ["GET"],
      mcpServers: ["memory-server", "tools-server"],
      mcpTools: ["memory-server.read", "tools-server.*"],
      argvClass: { kind: "argv-prefix", segments: ["node", "dist/run.js"] },
    },
    riskCeiling: "execute",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
    budgetEscrow: {
      maxPlannerTurns: 20,
      maxModelCalls: 50,
      maxTokens: 100_000,
      maxCapabilityCalls: 50,
      maxRetries: 5,
      maxExecutionTimeMs: 600_000,
      maxArtifactBytes: 10 * 1024 * 1024,
      maxConcurrentTasks: 2,
      maxSubprocesses: 2,
    },
    expiresAt: "2026-10-08T00:00:00.000Z" as Iso8601,
    depth: 1,
    maxChildren: 3,
    ...overrides,
  };
}

// ============================================================================
// ATTACK VECTOR 1: OMITTED FILESYSTEM CONSTRAINT
// ============================================================================
test("ATTACK 1: Omitted filesystem paths inherit parent paths strictly and never widen to unconstrained", () => {
  const parent = makeBaseEnvelope({
    constraints: {
      paths: ["workspace/project/subtask"],
    },
  });

  // Child omits constraints.paths
  const childReq: ChildRequestedAuthority = {
    capabilities: ["fs.read"],
    constraints: {},
  };

  const res = computeEffectiveAuthority(parent, childReq);
  assert.equal(res.ok, true);
  if (res.ok) {
    // Must inherit parent's exact path boundary
    assert.deepEqual(res.effective.constraints.paths, ["workspace/project/subtask"]);
    // Must not be undefined or unconstrained
    assert.notEqual(res.effective.constraints.paths, undefined);
  }

  // Child attempts path escape outside parent prefix
  const escapeReq: ChildRequestedAuthority = {
    capabilities: ["fs.read"],
    constraints: {
      paths: ["other/secret"],
    },
  };
  const escapeRes = computeEffectiveAuthority(parent, escapeReq);
  assert.equal(escapeRes.ok, false);
  if (!escapeRes.ok) {
    assert.equal(escapeRes.dimension, "paths");
  }
});

// ============================================================================
// ATTACK VECTOR 2: OMITTED NETWORK CONSTRAINT
// ============================================================================
test("ATTACK 2: Omitted network constraints inherit parent hosts or fail closed, never granting open network", () => {
  const parent = makeBaseEnvelope({
    constraints: {
      hosts: ["api.safe.com"],
      methods: ["GET"],
    },
  });

  // Child requests network capability but omits hosts
  const childReq: ChildRequestedAuthority = {
    capabilities: ["web.fetch"],
  };

  const res = computeEffectiveAuthority(parent, childReq);
  assert.equal(res.ok, true);
  if (res.ok) {
    // Child inherits parent's strict host constraint
    assert.deepEqual(res.effective.constraints.hosts, ["api.safe.com"]);
  }

  // Parent with zero authorized hosts blocks any child network request
  const zeroNetParent = makeBaseEnvelope({
    constraints: {
      hosts: [],
    },
  });
  const zeroNetReq: ChildRequestedAuthority = {
    capabilities: ["web.fetch"],
    constraints: {
      hosts: ["evil.com"],
    },
  };
  const zeroRes = computeEffectiveAuthority(zeroNetParent, zeroNetReq);
  assert.equal(zeroRes.ok, false);
  if (!zeroRes.ok) {
    assert.equal(zeroRes.dimension, "hosts");
  }
});

// ============================================================================
// ATTACK VECTOR 3: WILDCARD NETWORK PATTERN WIDENING
// ============================================================================
test("ATTACK 3: Child cannot widen specific domain hosts to wildcard patterns (*.domain)", () => {
  const parent = makeBaseEnvelope({
    constraints: {
      hosts: ["api.example.com"],
    },
  });

  // Child attempts wildcard widening
  const wildcardReq: ChildRequestedAuthority = {
    capabilities: ["web.fetch"],
    constraints: {
      hosts: ["*.example.com"],
    },
  };

  const res = computeEffectiveAuthority(parent, wildcardReq);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.dimension, "hosts");
    assert.match(res.error, /Wildcard host "\*\.example\.com" widens/);
  }
});

// ============================================================================
// ATTACK VECTOR 4: MCP SERVER AND TOOL ATTENUATION
// ============================================================================
test("ATTACK 4: Child cannot access MCP servers or wildcard tools outside parent grant", () => {
  const parent = makeBaseEnvelope({
    constraints: {
      mcpServers: ["db-service"],
      mcpTools: ["db-service.query"],
    },
  });

  // Requesting unauthorized server
  const unauthServerReq: ChildRequestedAuthority = {
    constraints: {
      mcpServers: ["admin-service"],
    },
  };
  const resServer = computeEffectiveAuthority(parent, unauthServerReq);
  assert.equal(resServer.ok, false);
  if (!resServer.ok) {
    assert.equal(resServer.dimension, "mcpServers");
  }

  // Requesting wildcard tool expansion when parent has exact tool
  const wildcardToolReq: ChildRequestedAuthority = {
    constraints: {
      mcpTools: ["db-service.*"],
    },
  };
  const resTool = computeEffectiveAuthority(parent, wildcardToolReq);
  assert.equal(resTool.ok, false);
  if (!resTool.ok) {
    assert.equal(resTool.dimension, "mcpTools");
    assert.match(resTool.error, /widens parent tool permissions/);
  }
});

// ============================================================================
// ATTACK VECTOR 5: HOST EXECUTION ESCALATION
// ============================================================================
test("ATTACK 5: Child cannot claim allowHostExecution when parent does not possess host execution right", () => {
  const parent = makeBaseEnvelope({
    allowHostExecution: false,
  });

  const childReq: ChildRequestedAuthority = {
    allowHostExecution: true,
  };

  const res = computeEffectiveAuthority(parent, childReq);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.dimension, "hostExecution");
  }
});

// ============================================================================
// ATTACK VECTOR 6: ISOLATION PROFILE MONOTONICITY
// ============================================================================
test("ATTACK 6: Child cannot weaken isolationProfile from sandboxed to host", () => {
  const parent = makeBaseEnvelope({
    isolationProfile: "sandboxed",
  });

  const childReq: ChildRequestedAuthority = {
    isolationProfile: "host",
  };

  const res = computeEffectiveAuthority(parent, childReq);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.dimension, "isolationProfile");
    assert.match(res.error, /weaker than parent isolation/);
  }
});

// ============================================================================
// ATTACK VECTOR 7: RISK CEILING MONOTONICITY
// ============================================================================
test("ATTACK 7: Child cannot escalate riskCeiling above parent ceiling", () => {
  const parent = makeBaseEnvelope({
    riskCeiling: "read",
  });

  const childReq: ChildRequestedAuthority = {
    riskCeiling: "execute",
  };

  const res = computeEffectiveAuthority(parent, childReq);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.dimension, "risk");
    assert.match(res.error, /exceeds parent ceiling/);
  }
});

// ============================================================================
// ATTACK VECTOR 8: MAXIMUM DELEGATION DEPTH ENFORCEMENT
// ============================================================================
test("ATTACK 8: Delegation depth D <= 3 is mechanically enforced; depth 4 rejected", () => {
  const parentAtMaxDepth = makeBaseEnvelope({
    depth: 3,
  });

  const childReq: ChildRequestedAuthority = {};
  const res = computeEffectiveAuthority(parentAtMaxDepth, childReq);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.dimension, "delegationDepth");
    assert.match(res.error, /exceeds hard maximum depth of 3/);
  }
});

// ============================================================================
// ATTACK VECTOR 9: MAXIMUM FANOUT ENFORCEMENT
// ============================================================================
test("ATTACK 9: Maximum fanout F <= 3 is enforced per parent; 4th active child rejected", () => {
  const registry = new DelegationRegistry();

  const pId = newDelegationId();
  const parentEntry: DelegationRegistryEntry = {
    delegationId: pId,
    parentDelegationId: null,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(0),
    childMissionId: makeMisId(1),
    parentAgentId: "root_supervisor",
    childAgentId: "parent_agent",
    depth: 1,
    ancestorPath: [pId],
    childIncarnationEpoch: 1,
    containerId: null,
    hostPid: null,
    grantId: makeGrtId(1),
    grantRevision: 1,
    effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 1 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  };
  registry.registerDelegation(parentEntry);

  // Register 3 children (allowed max)
  for (let i = 1; i <= 3; i++) {
    const cId = newDelegationId();
    const childEntry: DelegationRegistryEntry = {
      ...parentEntry,
      delegationId: cId,
      parentDelegationId: pId,
      childMissionId: makeMisId(i + 1),
      childAgentId: `child_agent_${i}`,
      depth: 2,
      ancestorPath: [pId, cId],
    };
    registry.registerDelegation(childEntry);
  }

  // 4th child must throw TopologyLimitError
  const fourthId = newDelegationId();
  const fourthEntry: DelegationRegistryEntry = {
    ...parentEntry,
    delegationId: fourthId,
    parentDelegationId: pId,
    childMissionId: makeMisId(99),
    childAgentId: "child_agent_4",
    depth: 2,
    ancestorPath: [pId, fourthId],
  };

  assert.throws(
    () => registry.registerDelegation(fourthEntry),
    TopologyLimitError,
  );
});

// ============================================================================
// ATTACK VECTOR 10: AGENT IDENTITY TUPLE CANONICALIZATION & STABLE HASH
// ============================================================================
test("ATTACK 10: Identity tuple produces byte-identical canonical JSON and stable SHA-256 regardless of key order", () => {
  const dId = newDelegationId();
  const mId = makeMisId(1);
  const gId = makeGrtId(1);

  const idA: AgentIdentityTuple = {
    agentId: "agent_alpha",
    delegationId: dId,
    missionId: mId,
    incarnationEpoch: 1,
    grantId: gId,
    grantRevision: 1,
  };

  const idB: AgentIdentityTuple = {
    grantRevision: 1,
    grantId: gId,
    incarnationEpoch: 1,
    missionId: mId,
    delegationId: dId,
    agentId: "agent_alpha",
  };

  const canonicalA = canonicalizeIdentity(idA);
  const canonicalB = canonicalizeIdentity(idB);
  assert.equal(canonicalA, canonicalB);

  const hashA = hashIdentity(idA);
  const hashB = hashIdentity(idB);
  assert.equal(hashA, hashB);
  assert.equal(hashA.length, 64);
});

// ============================================================================
// ATTACK VECTOR 11: INCARNATION EPOCH MONOTONICITY
// ============================================================================
test("ATTACK 11: nextIncarnationEpoch strictly advances and rejects non-positive or non-safe integer values", () => {
  assert.equal(nextIncarnationEpoch(1), 2);
  assert.equal(nextIncarnationEpoch(41), 42);

  assert.throws(() => nextIncarnationEpoch(0));
  assert.throws(() => nextIncarnationEpoch(-5));
  assert.throws(() => nextIncarnationEpoch(1.5));
});

// ============================================================================
// ATTACK VECTOR 12: STALE EPOCH REJECTION
// ============================================================================
test("ATTACK 12: isEpochAuthoritative strictly verifies equality and rejects rolled-back or stale epochs", () => {
  const authoritativeEpoch = 3;

  assert.equal(isEpochAuthoritative(authoritativeEpoch, 3), true);
  assert.equal(isEpochAuthoritative(authoritativeEpoch, 2), false); // Stale/rolled-back
  assert.equal(isEpochAuthoritative(authoritativeEpoch, 4), false); // Future/unactivated
  assert.equal(isEpochAuthoritative(authoritativeEpoch, -1), false);
  assert.equal(isEpochAuthoritative(authoritativeEpoch, 0), false);
});

// ============================================================================
// ATTACK VECTOR 13: ATOMIC CAS BUDGET RESERVATION
// ============================================================================
test("ATTACK 13: Atomic CAS budget reservation succeeds within limit and fails when requested > available", () => {
  const initialBudget: DelegationBudget = {
    maxPlannerTurns: 20,
    maxModelCalls: 50,
    maxTokens: 50_000,
    maxCapabilityCalls: 50,
    maxRetries: 5,
    maxExecutionTimeMs: 300_000,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxConcurrentTasks: 2,
    maxSubprocesses: 2,
  };

  const manager = new BudgetEscrowManager(initialBudget);

  const req1: DelegationBudget = {
    ...initialBudget,
    maxTokens: 30_000,
  };
  const d1 = newDelegationId();
  const res1 = manager.atomicReserveEscrow(d1, req1);
  assert.equal(res1.ok, true);
  assert.equal(manager.getAvailableBudget().maxTokens, 20_000);

  // Requesting more than remaining 20,000 tokens fails cleanly
  const req2: DelegationBudget = {
    ...initialBudget,
    maxTokens: 25_000,
  };
  const d2 = newDelegationId();
  const res2 = manager.atomicReserveEscrow(d2, req2);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "InsufficientAvailableBudget");
  assert.equal(res2.errorDimension, "maxTokens");
  // Available budget remains unchanged
  assert.equal(manager.getAvailableBudget().maxTokens, 20_000);
});

// ============================================================================
// ATTACK VECTOR 14: CONCURRENT BUDGET RACE SERIALIZATION
// ============================================================================
test("ATTACK 14: Serialized budget CAS prevents double-spending under concurrent attempts", () => {
  const initialBudget: DelegationBudget = {
    maxPlannerTurns: 20,
    maxModelCalls: 50,
    maxTokens: 10_000,
    maxCapabilityCalls: 50,
    maxRetries: 5,
    maxExecutionTimeMs: 300_000,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxConcurrentTasks: 2,
    maxSubprocesses: 2,
  };

  const manager = new BudgetEscrowManager(initialBudget);

  const req: DelegationBudget = {
    ...initialBudget,
    maxTokens: 8_000,
  };

  const dA = newDelegationId();
  const dB = newDelegationId();

  // First succeeds
  const resA = manager.atomicReserveEscrow(dA, req);
  assert.equal(resA.ok, true);

  // Second immediately fails because only 2,000 tokens remain
  const resB = manager.atomicReserveEscrow(dB, req);
  assert.equal(resB.ok, false);
  assert.equal(resB.reason, "InsufficientAvailableBudget");
});

// ============================================================================
// ATTACK VECTOR 15: NON-NEGATIVE BUDGET CONSERVATION
// ============================================================================
test("ATTACK 15: Budget conservation law holds and available balance never drops below zero", () => {
  const initialBudget: DelegationBudget = {
    maxPlannerTurns: 20,
    maxModelCalls: 10,
    maxTokens: 10_000,
    maxCapabilityCalls: 10,
    maxRetries: 5,
    maxExecutionTimeMs: 100_000,
    maxArtifactBytes: 1024 * 1024,
    maxConcurrentTasks: 1,
    maxSubprocesses: 1,
  };

  const manager = new BudgetEscrowManager(initialBudget);
  const dId = newDelegationId();

  manager.atomicReserveEscrow(dId, initialBudget);
  assert.equal(manager.getAvailableBudget().maxTokens, 0);

  // Activating and recording spend within bounds
  manager.activateEscrow(dId);
  manager.recordSpend(dId, { tokens: 4_000, modelCalls: 2 });

  // Reconcile receipt with 4,000 spent, 6,000 refunded
  const rec = manager.reconcileReceipt(dId, {
    tokens: 4_000,
    modelCalls: 2,
    capabilityCalls: 0,
    executionTimeMs: 10_000,
    artifactBytes: 0,
  });
  assert.equal(rec.refundedTokens, 6_000);
  assert.equal(manager.getAvailableBudget().maxTokens, 6_000);
});

// ============================================================================
// ATTACK VECTOR 16: PROHIBITION OF AUTOMATIC REFUND ON UNCERTAIN SPEND (INV-33/S8-06)
// ============================================================================
test("ATTACK 16: Automatic refund of UNCERTAIN budget escrow is strictly prohibited", () => {
  const initialBudget: DelegationBudget = {
    maxPlannerTurns: 20,
    maxModelCalls: 50,
    maxTokens: 40_000,
    maxCapabilityCalls: 50,
    maxRetries: 5,
    maxExecutionTimeMs: 300_000,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxConcurrentTasks: 2,
    maxSubprocesses: 2,
  };

  const manager = new BudgetEscrowManager(initialBudget);
  const dId = newDelegationId();

  manager.atomicReserveEscrow(dId, initialBudget);
  manager.activateEscrow(dId);

  // Child crashes without receipt
  manager.handleCrashOrAbruptTermination(dId);

  // Attempting to refund UNCERTAIN directly must throw UncertainBudgetRefundError
  assert.throws(
    () => manager.refundUncertainDirectly(dId),
    UncertainBudgetRefundError,
  );
});

// ============================================================================
// ATTACK VECTOR 17: CRASH AUDIT RECONCILIATION
// ============================================================================
test("ATTACK 17: Host Crash Audit Daemon partitions UNCERTAIN into audited CONSUMED and REFUNDED remainder", () => {
  const initialBudget: DelegationBudget = {
    maxPlannerTurns: 20,
    maxModelCalls: 50,
    maxTokens: 50_000,
    maxCapabilityCalls: 50,
    maxRetries: 5,
    maxExecutionTimeMs: 300_000,
    maxArtifactBytes: 5 * 1024 * 1024,
    maxConcurrentTasks: 2,
    maxSubprocesses: 2,
  };

  const manager = new BudgetEscrowManager(initialBudget);
  const dId = newDelegationId();

  manager.atomicReserveEscrow(dId, initialBudget);
  manager.activateEscrow(dId);
  manager.handleCrashOrAbruptTermination(dId);

  // Crash audit discovers actual spent = 15,000 tokens
  const auditResult = manager.reconcileCrashAudit(dId, {
    tokens: 15_000,
    modelCalls: 10,
    capabilityCalls: 5,
    executionTimeMs: 50_000,
    artifactBytes: 1024,
  });

  assert.equal(auditResult.refundedTokens, 35_000);
  assert.equal(manager.getAvailableBudget().maxTokens, 35_000);

  const entry = manager.getEscrow(dId);
  assert.equal(entry?.state, "REFUNDED");
  assert.equal(entry?.consumed.tokens, 15_000);
  assert.equal(entry?.refundable.tokens, 35_000);
});

// ============================================================================
// ATTACK VECTOR 18: DELEGATION REGISTRY ATOMIC PERSISTENCE AND RECOVERY
// ============================================================================
test("ATTACK 18: Delegation registry persists atomically with fsync and recovers accurately across restarts", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "forge-test-registry-"));
  const registryFile = join(tempDir, "delegation-registry.json");

  try {
    const regA = new DelegationRegistry(registryFile);
    const dId = newDelegationId();

    const entry: DelegationRegistryEntry = {
      delegationId: dId,
      parentDelegationId: null,
      rootMissionId: makeMisId(0),
      parentMissionId: makeMisId(0),
      childMissionId: makeMisId(1),
      parentAgentId: "supervisor",
      childAgentId: "worker_agent",
      depth: 1,
      ancestorPath: [dId],
      childIncarnationEpoch: 1,
      containerId: "dock_12345",
      hostPid: 4200,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeBaseEnvelope(),
      status: "active",
      issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      activeChildCount: 0,
      totalDescendantCount: 0,
    };

    regA.registerDelegation(entry);
    assert.equal(existsSync(registryFile), true);

    // Recover in fresh registry instance
    const regB = DelegationRegistry.loadAndRecover(registryFile);
    const recovered = regB.getDelegation(dId);
    assert.ok(recovered);
    assert.equal(recovered?.delegationId, dId);
    assert.equal(recovered?.containerId, "dock_12345");
    assert.equal(recovered?.hostPid, 4200);
    assert.equal(recovered?.status, "active");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ============================================================================
// ATTACK VECTOR 19: CASCADE REVOCATION DISCOVERS ALL DESCENDANTS (S8-04)
// ============================================================================
test("ATTACK 19: Cascade revocation discovers and atomically revokes parent, child, and grandchild (S8-04)", () => {
  const registry = new DelegationRegistry();

  const pId = newDelegationId();
  const cId = newDelegationId();
  const gId = newDelegationId();

  // Root delegation (depth 1)
  registry.registerDelegation({
    delegationId: pId,
    parentDelegationId: null,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(0),
    childMissionId: makeMisId(1),
    parentAgentId: "supervisor",
    childAgentId: "parent_agent",
    depth: 1,
    ancestorPath: [pId],
    childIncarnationEpoch: 1,
    containerId: "cnt_parent",
    hostPid: 100,
    grantId: makeGrtId(1),
    grantRevision: 1,
    effectiveAuthorityHash: "b".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 1 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  });

  // Child delegation (depth 2)
  registry.registerDelegation({
    delegationId: cId,
    parentDelegationId: pId,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(1),
    childMissionId: makeMisId(2),
    parentAgentId: "parent_agent",
    childAgentId: "child_agent",
    depth: 2,
    ancestorPath: [pId, cId],
    childIncarnationEpoch: 1,
    containerId: "cnt_child",
    hostPid: 101,
    grantId: makeGrtId(2),
    grantRevision: 1,
    effectiveAuthorityHash: "c".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 2 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  });

  // Grandchild delegation (depth 3)
  registry.registerDelegation({
    delegationId: gId,
    parentDelegationId: cId,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(2),
    childMissionId: makeMisId(3),
    parentAgentId: "child_agent",
    childAgentId: "grandchild_agent",
    depth: 3,
    ancestorPath: [pId, cId, gId],
    childIncarnationEpoch: 1,
    containerId: "cnt_grandchild",
    hostPid: 102,
    grantId: makeGrtId(3),
    grantRevision: 1,
    effectiveAuthorityHash: "d".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 3 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  });

  // Revoking parent must cascade to Child and Grandchild
  const revoked = registry.revokeDelegation(pId, "Operator security revocation");
  assert.equal(revoked.length, 3);

  assert.equal(registry.getDelegation(pId)?.status, "revoked");
  assert.equal(registry.getDelegation(cId)?.status, "revoked");
  assert.equal(registry.getDelegation(gId)?.status, "revoked");

  // Subsequent delegation from revoked parent must be rejected
  const illegalChildId = newDelegationId();
  assert.throws(() =>
    registry.registerDelegation({
      delegationId: illegalChildId,
      parentDelegationId: pId,
      rootMissionId: makeMisId(0),
      parentMissionId: makeMisId(1),
      childMissionId: makeMisId(4),
      parentAgentId: "parent_agent",
      childAgentId: "new_child",
      depth: 2,
      ancestorPath: [pId, illegalChildId],
      childIncarnationEpoch: 1,
      containerId: null,
      hostPid: null,
      grantId: makeGrtId(4),
      grantRevision: 1,
      effectiveAuthorityHash: "e".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeBaseEnvelope({ depth: 2 }),
      status: "active",
      issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      activeChildCount: 0,
      totalDescendantCount: 0,
    }),
  );
});

// ============================================================================
// ATTACK VECTOR 20: TOPOLOGY CYCLE DETECTION
// ============================================================================
test("ATTACK 20: Cycle detection prevents circular ancestor delegation", () => {
  const registry = new DelegationRegistry();

  const d1 = newDelegationId();
  const d2 = newDelegationId();

  registry.registerDelegation({
    delegationId: d1,
    parentDelegationId: null,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(0),
    childMissionId: makeMisId(1),
    parentAgentId: "supervisor",
    childAgentId: "agent1",
    depth: 1,
    ancestorPath: [d1],
    childIncarnationEpoch: 1,
    containerId: null,
    hostPid: null,
    grantId: makeGrtId(1),
    grantRevision: 1,
    effectiveAuthorityHash: "f".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 1 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  });

  // Self-cycle in ancestor path
  assert.throws(
    () =>
      registry.registerDelegation({
        delegationId: d2,
        parentDelegationId: d1,
        rootMissionId: makeMisId(0),
        parentMissionId: makeMisId(1),
        childMissionId: makeMisId(2),
        parentAgentId: "agent1",
        childAgentId: "agent2",
        depth: 2,
        ancestorPath: [d2, d2], // Invalid cycle
        childIncarnationEpoch: 1,
        containerId: null,
        hostPid: null,
        grantId: makeGrtId(2),
        grantRevision: 1,
        effectiveAuthorityHash: "f".repeat(64) as Sha256Hex,
        effectiveEnvelope: makeBaseEnvelope({ depth: 2 }),
        status: "active",
        issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        activeChildCount: 0,
        totalDescendantCount: 0,
      }),
    CycleDetectedError,
  );
});

// ============================================================================
// BONUS / EDGE CASES: DELEGATE PROPOSAL SCHEMA & REINCARNATION
// ============================================================================
test("EDGE CASE: Reincarnation strictly increments epoch and rejects non-monotonic update", () => {
  const registry = new DelegationRegistry();
  const dId = newDelegationId();

  registry.registerDelegation({
    delegationId: dId,
    parentDelegationId: null,
    rootMissionId: makeMisId(0),
    parentMissionId: makeMisId(0),
    childMissionId: makeMisId(1),
    parentAgentId: "supervisor",
    childAgentId: "agent1",
    depth: 1,
    ancestorPath: [dId],
    childIncarnationEpoch: 1,
    containerId: "dock_01",
    hostPid: 200,
    grantId: makeGrtId(1),
    grantRevision: 1,
    effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeBaseEnvelope({ depth: 1 }),
    status: "active",
    issuedAt: "2026-10-07T00:00:00.000Z" as Iso8601,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
  });

  // Reincarnate to epoch 2
  const reincarnated = registry.reincarnate(dId, 2, "dock_02", 201);
  assert.equal(reincarnated.childIncarnationEpoch, 2);
  assert.equal(reincarnated.containerId, "dock_02");

  // Attempting to rollback epoch to 1 or 2 throws
  assert.throws(() => registry.reincarnate(dId, 1, "dock_03", 202));
  assert.throws(() => registry.reincarnate(dId, 2, "dock_03", 202));
});

test("EDGE CASE: Delegate proposal variant validates strictly under ProposalSchema", () => {
  const dId = newDelegationId();
  const delegateProposal = {
    capability: "delegate",
    args: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: makeMisId(0),
      childMissionId: makeMisId(1),
      parentAgentId: "supervisor",
      childAgentId: "sub_agent",
      incarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      requestedAuthority: {
        capabilities: ["fs.read"],
        constraints: { paths: ["workspace/subtask"] },
      },
      requestedBudget: {
        maxPlannerTurns: 10,
        maxModelCalls: 20,
        maxTokens: 25_000,
        maxCapabilityCalls: 20,
        maxRetries: 2,
        maxExecutionTimeMs: 120_000,
        maxArtifactBytes: 2 * 1024 * 1024,
        maxConcurrentTasks: 1,
        maxSubprocesses: 1,
      },
      expiry: null,
      topologyMetadata: {
        depth: 1,
        ancestorPath: [dId],
      },
    },
  };

  const parsed = ProposalSchema.parse(delegateProposal);
  assert.equal(parsed.capability, "delegate");
});
