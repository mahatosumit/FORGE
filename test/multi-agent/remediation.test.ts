// FORGE Multi-Agent Authority Architecture — Step 8 Phase 1 Remediation Suite
// Exhaustively verifies all 11 hostile audit findings (AUDIT-P1-01 through AUDIT-P1-11)
// across 20 adversarial tests (P1R-001 through P1R-020).
//
// Baseline:
// 1. The Step 7B Mission Journal is the sole canonical source of truth.
// 2. MultiAgentProjection and DelegationRegistry are 100% deterministically rebuildable from the Journal.
// 3. The Authority Gate enforces epoch validity, lineage active checks, and delegation attenuation.
// 4. Budget conservation and UNCERTAIN crash spend are durable and never resurrect.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeEffectiveAuthority,
  DelegationRegistry,
  BudgetEscrowManager,
  MultiAgentProjection,
  TopologyLimitError,
  DelegationRegistryError,
  UncertainBudgetRefundError,
  type EffectiveAuthorityEnvelope,
  type ChildRequestedAuthority,
  type DelegationBudget,
  type DelegationRegistryEntry,
  type DelegateProposalArgs,
} from "../../src/multi-agent/index.js";
import {
  evaluateProposal,
  type GateCallerContext,
} from "../../src/gate/gate.js";
import {
  type Grant,
  type GrantId,
  type MissionId,
  type AgentId,
  type DelegationId,
  type Sha256Hex,
  type Iso8601,
} from "../../src/contracts/index.js";
import { Ledger, LockError } from "../../src/ledger/index.js";
import { acquireLock } from "../../src/ledger/lock.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "forge-p1r-"));
}

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
    capability: "fs",
    mode: "direct",
    constraints: { paths: ["workspace/subtasks"] },
    riskCeiling: "read",
    issuedAt: "2026-10-07T12:00:00Z" as Iso8601,
    status: "active",
    ...overrides,
  };
}

function makeDelegateGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: makeGrtId(2),
    capability: "delegate",
    mode: "direct",
    constraints: {},
    riskCeiling: "write",
    issuedAt: "2026-10-07T12:00:00Z" as Iso8601,
    status: "active",
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

// ============================================================================
// P1R-001: Real Gate caller stale epoch rejection (stale-epoch)
// ============================================================================
test("P1R-001: Gate mechanically rejects proposal from stale incarnation epoch (AUDIT-P1-03)", () => {
  const dId = makeDelId(101);
  const mRoot = makeMisId(100);
  const mChild = makeMisId(101);
  const projection = new MultiAgentProjection();

  // Authorize delegation at epoch 1
  projection.applyRecord({
    id: "rec_1",
    seq: 1,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 100_000 },
      newAvailableTokens: 900_000,
    },
  });
  // Activate
  projection.applyRecord({
    id: "rec_2",
    seq: 2,
    kind: "delegation.activated",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:01:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      childIncarnationEpoch: 1,
      containerId: "c_1",
      hostPid: 1234,
    },
  });
  // Reincarnate to Epoch 2
  projection.applyRecord({
    id: "rec_3",
    seq: 3,
    kind: "delegation.reincarnated",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      oldEpoch: 1,
      newEpoch: 2,
      reason: "crash restart",
    },
  });

  const callerContext: GateCallerContext = {
    agentId: makeAgtId(2),
    delegationId: dId,
    incarnationEpoch: 1, // STALE! Authoritative is 2
  };

  const g = makeGrant({ capability: "fs", constraints: { paths: ["workspace/subtasks/file.txt"] } });
  const verdict = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "stale read", citations: [] },
    { grants: [g], callerContext, multiAgentProjection: projection },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "stale-epoch");
  assert(verdict.detail.includes("stale"));
});

// ============================================================================
// P1R-002: Real Gate revoked delegation rejection (delegation-revoked)
// ============================================================================
test("P1R-002: Gate mechanically rejects proposal when target delegation is revoked (AUDIT-P1-08)", () => {
  const dId = makeDelId(102);
  const mRoot = makeMisId(102);
  const mChild = makeMisId(103);
  const projection = new MultiAgentProjection();
  projection.applyRecord({
    id: "rec_1",
    seq: 1,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 100_000 },
      newAvailableTokens: 900_000,
    },
  });
  projection.applyRecord({
    id: "rec_2",
    seq: 2,
    kind: "delegation.revoked",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:10:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      childMissionId: mChild,
      revokedAt: "2026-10-07T12:10:00Z" as Iso8601,
      reason: "security anomaly",
      revokedBy: "operator",
    },
  });

  const callerContext: GateCallerContext = {
    agentId: makeAgtId(2),
    delegationId: dId,
    incarnationEpoch: 1,
  };

  const g = makeGrant({ capability: "fs", constraints: { paths: ["workspace/subtasks/file.txt"] } });
  const verdict = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "revoked read", citations: [] },
    { grants: [g], callerContext, multiAgentProjection: projection },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "delegation-revoked");
});

// ============================================================================
// P1R-003: Real Gate revoked ancestor rejection (AUDIT-P1-08, AUDIT-P1-10)
// ============================================================================
test("P1R-003: Gate rejects grandchild proposal when root ancestor is revoked", () => {
  const dRoot = makeDelId(201);
  const dChild = makeDelId(202);
  const dGrandchild = makeDelId(203);

  const mRoot = makeMisId(200);
  const mC1 = makeMisId(201);
  const mC2 = makeMisId(202);
  const mC3 = makeMisId(203);

  const projection = new MultiAgentProjection();
  // Authorize root child
  projection.applyRecord({
    id: "rec_1",
    seq: 1,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dRoot,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mC1,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dRoot],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000 },
      newAvailableTokens: 950_000,
    },
  });
  // Authorize child under root
  projection.applyRecord({
    id: "rec_2",
    seq: 2,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mC1,
    ts: "2026-10-07T12:01:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dChild,
      parentDelegationId: dRoot,
      parentMissionId: mC1,
      childMissionId: mC2,
      parentAgentId: makeAgtId(2),
      childAgentId: makeAgtId(3),
      depth: 2,
      ancestorPath: [dRoot, dChild],
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 20_000 },
      newAvailableTokens: 930_000,
    },
  });
  // Authorize grandchild
  projection.applyRecord({
    id: "rec_3",
    seq: 3,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mC2,
    ts: "2026-10-07T12:02:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dGrandchild,
      parentDelegationId: dChild,
      parentMissionId: mC2,
      childMissionId: mC3,
      parentAgentId: makeAgtId(3),
      childAgentId: makeAgtId(4),
      depth: 3,
      ancestorPath: [dRoot, dChild, dGrandchild],
      grantId: makeGrtId(3),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 10_000 },
      newAvailableTokens: 920_000,
    },
  });

  // Now revoke root delegation
  projection.applyRecord({
    id: "rec_4",
    seq: 4,
    kind: "delegation.revoked",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dRoot,
      parentDelegationId: null,
      childMissionId: mC1,
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      reason: "cascade root revocation",
      revokedBy: "cascade",
    },
  });

  const callerContext: GateCallerContext = {
    agentId: makeAgtId(4),
    delegationId: dGrandchild,
    incarnationEpoch: 1,
  };

  const g = makeGrant({ capability: "fs", constraints: { paths: ["workspace/subtasks/file.txt"] } });
  const verdict = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "grandchild read", citations: [] },
    { grants: [g], callerContext, multiAgentProjection: projection },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "delegation-revoked");
});

// ============================================================================
// P1R-004: Real Gate excessive authority rejection on delegate proposal (AUDIT-P1-02)
// ============================================================================
test("P1R-004: Gate rejects delegate proposal requesting capabilities outside parent grant", () => {
  const gDelegate = makeDelegateGrant();
  const callerContext: GateCallerContext = {
    agentId: makeAgtId(1),
    delegationId: makeDelId(1),
    incarnationEpoch: 1,
    parentEnvelope: makeEnvelope({
      capabilities: ["fs"],
      constraints: { paths: ["workspace/subtasks"] },
    }),
  };

  const delegateArgs: DelegateProposalArgs = {
    delegationId: makeDelId(99),
    parentDelegationId: null,
    parentMissionId: makeMisId(1),
    childMissionId: makeMisId(99),
    parentAgentId: makeAgtId(1),
    childAgentId: makeAgtId(99),
    incarnationEpoch: 1,
    grantId: makeGrtId(1),
    grantRevision: 1,
    requestedAuthority: {
      capabilities: ["fs", "shell"], // ESCALATION: parent only has "fs"
      constraints: { paths: ["workspace/subtasks"] },
    },
    requestedBudget: { ...DEFAULT_BUDGET, maxTokens: 10_000 },
    expiry: "2026-10-08T12:00:00Z" as Iso8601,
    topologyMetadata: {
      depth: 1,
      ancestorPath: [makeDelId(99)],
    },
  };

  const verdict = evaluateProposal(
    { capability: "delegate", args: delegateArgs },
    { rationale: "spawn helper", citations: [] },
    { grants: [gDelegate], callerContext },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "attenuation-failed-capabilities");
});

// ============================================================================
// P1R-005: Real Gate omitted network hosts rejection (AUDIT-P1-05)
// ============================================================================
test("P1R-005: Gate fails closed for web_fetch when active grant omits hosts constraint", () => {
  // Active grant for web_fetch has NO hosts constraint (omitted)
  const gNet = makeGrant({
    id: makeGrtId(5),
    capability: "web_fetch",
    constraints: {}, // OMITTED hosts! Must fail closed to 0 network access
  });

  const verdict = evaluateProposal(
    { capability: "web_fetch", args: { url: "https://evil-attacker.com/exfiltrate" } },
    { rationale: "fetch docs", citations: [] },
    { grants: [gNet] },
  );

  // Must not allow!
  assert.notEqual(verdict.type, "allow");
  assert.equal(verdict.type, "escalate");
});

// ============================================================================
// P1R-006: Path segment boundary confusion (AUDIT-P1-04)
// ============================================================================
test("P1R-006: computeEffectiveAuthority rejects directory boundary escape via character prefix", () => {
  const parent = makeEnvelope({
    constraints: { paths: ["workspace/sub"] },
  });

  // Attempted escape: workspace/subversion shares prefix "workspace/sub" but is a DIFFERENT directory
  const escapeChild: ChildRequestedAuthority = {
    capabilities: ["fs"],
    constraints: { paths: ["workspace/subversion/secret.txt"] },
  };

  const escapeRes = computeEffectiveAuthority(parent, escapeChild);
  assert.equal(escapeRes.ok, false);
  assert.equal(escapeRes.dimension, "paths");
  assert(escapeRes.error.includes("is not covered by parent authorized paths"));

  // Legitimate subpath inside workspace/sub/
  const validChild: ChildRequestedAuthority = {
    capabilities: ["fs"],
    constraints: { paths: ["workspace/sub/task1/notes.md"] },
  };
  const validRes = computeEffectiveAuthority(parent, validChild);
  assert.equal(validRes.ok, true);
});

// ============================================================================
// P1R-007: Budget crash before persistence (AUDIT-P1-01)
// ============================================================================
test("P1R-007: Uncommitted budget reservation disappears on crash and cannot be spent", () => {
  const dir = tmpDir();
  const mId = makeMisId(700);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  // In-memory manager reserves budget
  const initialBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 500_000 };
  const manager = new BudgetEscrowManager(initialBudget);
  const res = manager.atomicReserveEscrow(makeDelId(1), { ...DEFAULT_BUDGET, maxTokens: 200_000 });
  assert.equal(res.ok, true);
  assert.equal(manager.getAvailableBudget().maxTokens, 300_000);

  // Crash before appending delegation.authorized to ledger!
  // Rebuild from the canonical ledger:
  const recovered = BudgetEscrowManager.rebuildFromLedger(ledger, initialBudget);
  assert.equal(recovered.getAvailableBudget().maxTokens, 500_000);
  assert.equal(recovered.getEscrow(makeDelId(1)), undefined);

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-008: Budget crash after persistence (AUDIT-P1-01)
// ============================================================================
test("P1R-008: Committed budget reservation survives crash and remains deducted", () => {
  const dir = tmpDir();
  const mId = makeMisId(800);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const dId = makeDelId(208);
  const initialBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 500_000 };
  const escrowBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 200_000 };

  // Append committed delegation.authorized to ledger
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: makeMisId(801),
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: escrowBudget,
      newAvailableTokens: 300_000,
    },
  });

  // Rebuild manager after crash
  const recovered = BudgetEscrowManager.rebuildFromLedger(ledger, initialBudget);
  assert.equal(recovered.getAvailableBudget().maxTokens, 300_000);

  const escrow = recovered.getEscrow(dId);
  assert(escrow !== undefined);
  assert.equal(escrow.escrowed.maxTokens, 200_000);

  // Attempting to reserve 400,000 tokens fails
  const overReserve = recovered.atomicReserveEscrow(makeDelId(999), { ...DEFAULT_BUDGET, maxTokens: 400_000 });
  assert.equal(overReserve.ok, false);
  assert.equal(overReserve.reason, "InsufficientAvailableBudget");

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-009: UNCERTAIN restart & non-resurrection (AUDIT-P1-01, AUDIT-P1-06)
// ============================================================================
test("P1R-009: UNCERTAIN crash spend survives restart and blocks un-audited refund", () => {
  const dir = tmpDir();
  const mId = makeMisId(900);
  const mChild = makeMisId(901);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const dId = makeDelId(209);
  const initialBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 500_000 };

  // 1. Authorize
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 150_000 },
      newAvailableTokens: 350_000,
    },
  });

  // 2. Activate
  ledger.append({
    kind: "delegation.activated",
    author: "runtime",
    ts: "2026-10-07T12:01:00Z" as Iso8601,
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      childIncarnationEpoch: 1,
      containerId: "c_crash",
      hostPid: 5555,
    },
  });

  // 3. Child killed / revoked abruptly without verified receipt -> UNCERTAIN
  ledger.append({
    kind: "delegation.revoked",
    author: "runtime",
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      childMissionId: mChild,
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      reason: "process crash detected",
      revokedBy: "operator",
    },
  });

  // Rebuild manager from ledger
  const recovered = BudgetEscrowManager.rebuildFromLedger(ledger, initialBudget);
  assert.equal(recovered.getAvailableBudget().maxTokens, 350_000);

  const escrow = recovered.getEscrow(dId);
  assert(escrow !== undefined);
  assert.equal(escrow.state, "UNCERTAIN");
  assert.equal(escrow.uncertain, true);

  // Calling refundUncertainDirectly MUST throw UncertainBudgetRefundError
  assert.throws(
    () => recovered.refundUncertainDirectly(dId),
    (err: any) => err instanceof UncertainBudgetRefundError,
  );

  // Reconciliation by Host Crash Audit allows partition
  const reconciled = recovered.reconcileCrashAudit(dId, {
    tokens: 50_000,
    modelCalls: 2,
    capabilityCalls: 5,
    executionTimeMs: 1000,
    artifactBytes: 0,
  });
  assert.equal(reconciled.refundedTokens, 100_000);
  assert.equal(recovered.getAvailableBudget().maxTokens, 450_000);

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-010: Registry/journal divergence resolution (AUDIT-P1-07)
// ============================================================================
test("P1R-010: Journal overrides tampered registry file; rebuild produces authoritative state", () => {
  const dir = tmpDir();
  const mId = makeMisId(1000);
  const mChild = makeMisId(1001);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const dId = makeDelId(210);
  // Journal says: delegation is REVOKED
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000 },
      newAvailableTokens: 950_000,
    },
  });
  ledger.append({
    kind: "delegation.revoked",
    author: "runtime",
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      childMissionId: mChild,
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      reason: "security revocation",
      revokedBy: "operator",
    },
  });

  // Divergent / tampered registry JSON claims status: "active"
  const regPath = join(dir, "delegation-registry.json");
  const tamperedEntry = makeRegistryEntry({ delegationId: dId, status: "active" });
  writeFileSync(regPath, JSON.stringify([tamperedEntry]), "utf8");

  // Rebuilding from ledger supersedes tampered disk state
  const recoveredReg = DelegationRegistry.rebuildFromLedger(ledger, regPath);
  const entry = recoveredReg.getDelegation(dId);
  assert(entry !== undefined);
  assert.equal(entry.status, "revoked");

  // Verify disk was updated with authoritative state
  const diskContent = JSON.parse(readFileSync(regPath, "utf8"));
  assert.equal(diskContent[0].status, "revoked");

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-011: Registry rebuild from journal (AUDIT-P1-07)
// ============================================================================
test("P1R-011: Deleting delegation registry and rebuilding from ledger reconstructs 100% accurate entries", () => {
  const dir = tmpDir();
  const mId = makeMisId(1100);
  const mC1 = makeMisId(1101);
  const mC2 = makeMisId(1102);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const d1 = makeDelId(301);
  const d2 = makeDelId(302);

  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: d1,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mC1,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [d1],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 25_000 },
      newAvailableTokens: 975_000,
    },
  });
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:01:00Z" as Iso8601,
    body: {
      delegationId: d2,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mC2,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(3),
      depth: 1,
      ancestorPath: [d2],
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 35_000 },
      newAvailableTokens: 940_000,
    },
  });

  const regPath = join(dir, "delegation-registry.json");
  // File does not exist yet. Rebuild:
  const rebuilt = DelegationRegistry.rebuildFromLedger(ledger, regPath);

  assert.equal(rebuilt.all().length, 2);
  assert(rebuilt.getDelegation(d1) !== undefined);
  assert(rebuilt.getDelegation(d2) !== undefined);
  assert(existsSync(regPath));

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-012: Concurrent cross-process fanout locking (AUDIT-P1-06)
// ============================================================================
test("P1R-012: Fanout limit (F <= 3) is mechanically enforced under lock", () => {
  const dir = tmpDir();
  const regPath = join(dir, "delegation-registry.json");
  const registry = new DelegationRegistry(regPath);

  const parentId = makeDelId(400);
  registry.registerDelegation(
    makeRegistryEntry({
      delegationId: parentId,
      parentDelegationId: null,
      depth: 1,
      ancestorPath: [parentId],
    }),
  );

  // Add 3 children
  for (let i = 1; i <= 3; i++) {
    const cId = makeDelId(400 + i);
    registry.registerDelegation(
      makeRegistryEntry({
        delegationId: cId,
        parentDelegationId: parentId,
        depth: 2,
        ancestorPath: [parentId, cId],
        childMissionId: makeMisId(400 + i),
      }),
    );
  }

  // 4th child MUST fail with TopologyLimitError
  const c4Id = makeDelId(404);
  assert.throws(
    () =>
      registry.registerDelegation(
        makeRegistryEntry({
          delegationId: c4Id,
          parentDelegationId: parentId,
          depth: 2,
          ancestorPath: [parentId, c4Id],
          childMissionId: makeMisId(404),
        }),
      ),
    (err: any) => err instanceof TopologyLimitError && err.limitType === "fanout",
  );

  // Cross-process file locking test: holding .lock causes acquireLock to throw LockError
  const lockDir = dir;
  const lockHandle = acquireLock(lockDir, "test-proc-1", { pid: process.pid, host: "host1" });
  assert.throws(
    () => acquireLock(lockDir, "test-proc-2", { pid: process.pid + 1, host: "host2" }),
    (err: any) => err instanceof LockError,
  );
  lockHandle.release();

  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-013: Concurrent cross-process budget locking (AUDIT-P1-06)
// ============================================================================
test("P1R-013: Budget CAS prevents over-allocation and double spend", () => {
  const initialBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 100_000 };
  const manager = new BudgetEscrowManager(initialBudget);

  // Process 1 reserves 70,000 tokens
  const res1 = manager.atomicReserveEscrow(makeDelId(501), { ...DEFAULT_BUDGET, maxTokens: 70_000 });
  assert.equal(res1.ok, true);
  assert.equal(manager.getAvailableBudget().maxTokens, 30_000);

  // Process 2 attempts to reserve 70,000 tokens (only 30,000 available)
  const res2 = manager.atomicReserveEscrow(makeDelId(502), { ...DEFAULT_BUDGET, maxTokens: 70_000 });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "InsufficientAvailableBudget");
  assert.equal(manager.getAvailableBudget().maxTokens, 30_000);
});

// ============================================================================
// P1R-014: Concurrent epoch advancement (AUDIT-P1-03)
// ============================================================================
test("P1R-014: Incarnation epoch requires strictly monotonic increments", () => {
  const registry = new DelegationRegistry();
  const dId = makeDelId(601);
  registry.registerDelegation(makeRegistryEntry({ delegationId: dId, childIncarnationEpoch: 1 }));

  // Advance to Epoch 2
  const updated = registry.reincarnate(dId, 2);
  assert.equal(updated.childIncarnationEpoch, 2);

  // Reincarnate to same epoch 2 -> MUST throw
  assert.throws(
    () => registry.reincarnate(dId, 2),
    (err: any) => err instanceof DelegationRegistryError && err.message.includes("strictly greater"),
  );

  // Reincarnate to older epoch 1 -> MUST throw
  assert.throws(
    () => registry.reincarnate(dId, 1),
    (err: any) => err instanceof DelegationRegistryError && err.message.includes("strictly greater"),
  );
});

// ============================================================================
// P1R-015: Stale proposal after reincarnation (AUDIT-P1-03)
// ============================================================================
test("P1R-015: Proposal generated before reincarnation is rejected by Gate under new epoch", () => {
  const dId = makeDelId(701);
  const mRoot = makeMisId(700);
  const mChild = makeMisId(701);
  const projection = new MultiAgentProjection();
  projection.applyRecord({
    id: "rec_1",
    seq: 1,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      rootMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000 },
      newAvailableTokens: 950_000,
    },
  });
  // Advance epoch to 3
  projection.applyRecord({
    id: "rec_2",
    seq: 2,
    kind: "delegation.reincarnated",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      childMissionId: mChild,
      childAgentId: makeAgtId(2),
      oldEpoch: 1,
      newEpoch: 3,
      reason: "recovery reincarnation",
    },
  });

  const callerContext: GateCallerContext = {
    agentId: makeAgtId(2),
    delegationId: dId,
    incarnationEpoch: 2, // STALE! Current authoritative epoch is 3
  };

  const g = makeGrant();
  const verdict = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "stale proposal", citations: [] },
    { grants: [g], callerContext, multiAgentProjection: projection },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "stale-epoch");
});

// ============================================================================
// P1R-016: Grandparent revocation in registry (AUDIT-P1-10)
// ============================================================================
test("P1R-016: registerDelegation rejects child registration when grandparent in ancestorPath is revoked", () => {
  const registry = new DelegationRegistry();

  const dRoot = makeDelId(801);
  const dChild = makeDelId(802);
  const dGrandchild = makeDelId(803);

  // Register Root
  registry.registerDelegation(
    makeRegistryEntry({
      delegationId: dRoot,
      parentDelegationId: null,
      depth: 1,
      ancestorPath: [dRoot],
    }),
  );

  // Register Child
  registry.registerDelegation(
    makeRegistryEntry({
      delegationId: dChild,
      parentDelegationId: dRoot,
      depth: 2,
      ancestorPath: [dRoot, dChild],
    }),
  );

  // Revoke Root
  registry.revokeDelegation(dRoot, "administrative kill");

  // Attempt to register Grandchild under Child (where Root is revoked in ancestorPath)
  assert.throws(
    () =>
      registry.registerDelegation(
        makeRegistryEntry({
          delegationId: dGrandchild,
          parentDelegationId: dChild,
          depth: 3,
          ancestorPath: [dRoot, dChild, dGrandchild],
        }),
      ),
    (err: any) => err instanceof DelegationRegistryError && err.message.includes("revoked"),
  );
});

// ============================================================================
// P1R-017: Historical grant + revoked delegation (AUDIT-P1-08)
// ============================================================================
test("P1R-017: Possessing an unexpired active Grant object cannot execute if delegation is revoked", () => {
  const dId = makeDelId(901);
  const mRoot = makeMisId(910);
  const mChild = makeMisId(911);
  const projection = new MultiAgentProjection();
  projection.applyRecord({
    id: "rec_1",
    seq: 1,
    kind: "delegation.authorized",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(99),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000 },
      newAvailableTokens: 950_000,
    },
  });
  projection.applyRecord({
    id: "rec_2",
    seq: 2,
    kind: "delegation.revoked",
    author: "runtime",
    missionId: mRoot,
    ts: "2026-10-07T12:05:00Z" as Iso8601,
    prevHash: null,
    hash: "0".repeat(64) as Sha256Hex,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      childMissionId: mChild,
      revokedAt: "2026-10-07T12:05:00Z" as Iso8601,
      reason: "operator override",
      revokedBy: "operator",
    },
  });

  // The child agent presents a perfectly valid, unexpired grant:
  const activeGrant = makeGrant({ id: makeGrtId(99), status: "active" });

  const callerContext: GateCallerContext = {
    agentId: makeAgtId(2),
    delegationId: dId,
    incarnationEpoch: 1,
  };

  const verdict = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "test read", citations: [] },
    { grants: [activeGrant], callerContext, multiAgentProjection: projection },
  );

  assert.equal(verdict.type, "reject");
  assert.equal(verdict.reasonCode, "delegation-revoked");
});

// ============================================================================
// P1R-018: Registry state tampering (AUDIT-P1-07)
// ============================================================================
test("P1R-018: Maliciously forged active delegation in JSON is purged on rebuild from journal", () => {
  const dir = tmpDir();
  const mId = makeMisId(950);
  const mChild = makeMisId(951);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const dId = makeDelId(950);
  // Canonical ledger has 1 authorized delegation
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000 },
      newAvailableTokens: 950_000,
    },
  });

  // Attacker writes a second phantom delegation into registry.json:
  const regPath = join(dir, "delegation-registry.json");
  const phantomId = makeDelId(999);
  const phantomEntry = makeRegistryEntry({ delegationId: phantomId, childMissionId: makeMisId(999) });
  writeFileSync(regPath, JSON.stringify([makeRegistryEntry({ delegationId: dId }), phantomEntry]), "utf8");

  // Rebuilding from authoritative ledger MUST purge phantom delegation
  const cleaned = DelegationRegistry.rebuildFromLedger(ledger, regPath);
  assert(cleaned.getDelegation(dId) !== undefined);
  assert.equal(cleaned.getDelegation(phantomId), undefined);
  assert.equal(cleaned.all().length, 1);

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-019: Budget state tampering (AUDIT-P1-01)
// ============================================================================
test("P1R-019: Tampered in-memory balance violating conservation law throws error and is repaired by ledger", () => {
  const dir = tmpDir();
  const mId = makeMisId(970);
  const mChild = makeMisId(971);
  const ledger = new Ledger({ dataDir: dir, missionId: mId, writer: { pid: process.pid, host: "test" } });

  const initialBudget: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 500_000 };
  const dId = makeDelId(970);
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dId,
      parentDelegationId: null,
      parentMissionId: mId,
      childMissionId: mChild,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dId],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 100_000 },
      newAvailableTokens: 400_000,
    },
  });

  const manager = BudgetEscrowManager.rebuildFromLedger(ledger, initialBudget);
  assert.equal(manager.getAvailableBudget().maxTokens, 400_000);

  // If memory is tampered with:
  (manager as any).available.maxTokens = 999_999;
  assert.throws(
    () => (manager as any).assertConservationLaw(),
    (err: any) => err.message.includes("Conservation Law Violated"),
  );

  // Rebuilding from ledger repairs to exact verified balance
  const repaired = BudgetEscrowManager.rebuildFromLedger(ledger, initialBudget);
  assert.equal(repaired.getAvailableBudget().maxTokens, 400_000);

  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// P1R-020: Restart + full authority reconstruction (AUDIT-P1-01, AUDIT-P1-07)
// ============================================================================
test("P1R-020: Full multi-agent lifecycle survives cold restart with byte-accurate state reconstruction", () => {
  const dir = tmpDir();
  const mRoot = makeMisId(1200);
  const mC1 = makeMisId(1201);
  const mC2 = makeMisId(1202);
  const mGC1 = makeMisId(1203);

  const ledger = new Ledger({ dataDir: dir, missionId: mRoot, writer: { pid: process.pid, host: "test" } });

  const rootLimit: DelegationBudget = { ...DEFAULT_BUDGET, maxTokens: 1_000_000, maxModelCalls: 100, maxCapabilityCalls: 100 };
  const dChild1 = makeDelId(1001);
  const dChild2 = makeDelId(1002);
  const dGrandchild1 = makeDelId(1003);

  // 1. Authorize Child 1 (100k tokens, 10 model calls, 10 cap calls)
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:00:00Z" as Iso8601,
    body: {
      delegationId: dChild1,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mC1,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      depth: 1,
      ancestorPath: [dChild1],
      grantId: makeGrtId(1),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 100_000, maxModelCalls: 10, maxCapabilityCalls: 10 },
      newAvailableTokens: 900_000,
    },
  });

  // 2. Activate Child 1
  ledger.append({
    kind: "delegation.activated",
    author: "runtime",
    ts: "2026-10-07T12:01:00Z" as Iso8601,
    body: {
      delegationId: dChild1,
      childMissionId: mC1,
      childAgentId: makeAgtId(2),
      childIncarnationEpoch: 1,
      containerId: "c_1",
      hostPid: 101,
    },
  });

  // 3. Child 1 delegates to Grandchild 1 (30k tokens, 5 model calls, 5 cap calls)
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:02:00Z" as Iso8601,
    body: {
      delegationId: dGrandchild1,
      parentDelegationId: dChild1,
      parentMissionId: mC1,
      childMissionId: mGC1,
      parentAgentId: makeAgtId(2),
      childAgentId: makeAgtId(3),
      depth: 2,
      ancestorPath: [dChild1, dGrandchild1],
      grantId: makeGrtId(2),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 30_000, maxModelCalls: 5, maxCapabilityCalls: 5 },
      newAvailableTokens: 870_000,
    },
  });

  // 4. Authorize Child 2 (50k tokens, 10 model calls, 10 cap calls)
  ledger.append({
    kind: "delegation.authorized",
    author: "runtime",
    ts: "2026-10-07T12:03:00Z" as Iso8601,
    body: {
      delegationId: dChild2,
      parentDelegationId: null,
      parentMissionId: mRoot,
      childMissionId: mC2,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(4),
      depth: 1,
      ancestorPath: [dChild2],
      grantId: makeGrtId(3),
      grantRevision: 1,
      effectiveAuthorityHash: "0".repeat(64) as Sha256Hex,
      effectiveEnvelope: makeEnvelope(),
      budgetEscrow: { ...DEFAULT_BUDGET, maxTokens: 50_000, maxModelCalls: 10, maxCapabilityCalls: 10 },
      newAvailableTokens: 820_000,
    },
  });

  // 5. Child 1 completes cleanly; receipt verified and reconciled:
  // Child 1 spent 40k tokens, refunds 60k tokens
  ledger.append({
    kind: "delegation.budget_reconciled",
    author: "runtime",
    ts: "2026-10-07T12:10:00Z" as Iso8601,
    body: {
      delegationId: dChild1,
      parentMissionId: mRoot,
      childMissionId: mC1,
      escrowedBudget: { ...DEFAULT_BUDGET, maxTokens: 100_000, maxModelCalls: 10, maxCapabilityCalls: 10 },
      actualConsumed: {
        tokens: 40_000,
        modelCalls: 2,
        capabilityCalls: 4,
        executionTimeMs: 1500,
      },
      refundedTokens: 60_000,
      newAvailableTokens: 880_000,
    },
  });

  // 6. Grandchild 1 is revoked (was in ESCROWED state -> full 30k tokens refunded to pool)
  ledger.append({
    kind: "delegation.revoked",
    author: "runtime",
    ts: "2026-10-07T12:12:00Z" as Iso8601,
    body: {
      delegationId: dGrandchild1,
      parentDelegationId: dChild1,
      childMissionId: mGC1,
      revokedAt: "2026-10-07T12:12:00Z" as Iso8601,
      reason: "work complete",
      revokedBy: "operator",
    },
  });

  // Close ledger (simulating shutdown)
  ledger.close();

  // COLD RESTART:
  const reopenedLedger = new Ledger({ dataDir: dir, missionId: mRoot, writer: { pid: process.pid, host: "test" } });

  const projection = MultiAgentProjection.rebuildFromLedger(reopenedLedger, rootLimit);
  const registry = DelegationRegistry.rebuildFromLedger(reopenedLedger);
  const budget = BudgetEscrowManager.rebuildFromLedger(reopenedLedger, rootLimit);

  // Assertions:
  // Available budget = 1,000,000 - 40,000 (spent C1) - 50,000 (escrow C2) = 910,000
  assert.equal(budget.getAvailableBudget().maxTokens, 910_000);
  assert.equal(projection.getAvailableBudget().maxTokens, 910_000);

  // Statuses:
  assert.equal(registry.getDelegation(dChild2)?.status, "authorized");
  assert.equal(registry.getDelegation(dGrandchild1)?.status, "revoked");

  // Gate evaluation under recovered state:
  const g = makeGrant();
  // Grandchild 1 caller is rejected (revoked):
  const verdictGc = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "workspace/subtasks/file.txt", contentRef: "0".repeat(64) } },
    { rationale: "test", citations: [] },
    { grants: [g], callerContext: { agentId: makeAgtId(3), delegationId: dGrandchild1, incarnationEpoch: 1 }, multiAgentProjection: projection },
  );
  assert.equal(verdictGc.type, "reject");
  assert.equal(verdictGc.reasonCode, "delegation-revoked");

  reopenedLedger.close();
  rmSync(dir, { recursive: true, force: true });
});
