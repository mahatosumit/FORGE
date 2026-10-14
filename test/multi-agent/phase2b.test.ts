// FORGE Step 8 Phase 2B — Host Supervisor & Physical Execution Boundary Test Suite
// Verifies:
// - 2B.1 Child Mission Materialization (isolated mission tree, independent ledger, genesis mission.opened)
// - 2B.2 Host Supervisor (activation, proposal dispatch, registry tracking)
// - 2B.3 Authority-to-Jail Equivalence: Physical capabilities available to child ⊆ EffectiveAuthorityEnvelope
//   * Banned mounts: container daemon sockets, host root, parent mission dir, sibling mission dirs
//   * Network isolation: physical network disabled ('none') or restricted to allowlist
//   * Shell restriction: ungranted shell disabled physically
//   * Credential scrubbing: zero parent secrets leaked
// - 2B.4 Process Jail & Boundary Containment (relative traversal, prefix collisions)
// - 2B.5 Attribution Binding (callerContext verification, mission masquerade rejection)
// - 2B.6 Capability Execution (child-local gate + physical jail + typed observations in child ledger)
// - 2B.7 Revocation / Kill (bounded process termination, ledger audit trail)
// - 2B.8 Crash Boundaries (abrupt crash, UNCERTAIN budget escrow freeze, non-refundability)
// - 2B.9 Multi-Agent Concurrent Isolation (Child A & Child B sibling containment)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DelegationBudget,
  type DelegationRegistryEntry,
  type DelegationId,
  type EffectiveAuthorityEnvelope,
} from "../../src/contracts/delegation.js";
import {
  type GrantId,
  type MissionId,
  type AgentId,
  type Sha256Hex,
  type Iso8601,
} from "../../src/contracts/index.js";
import {
  DelegationRegistry,
  DelegationNotFoundError,
} from "../../src/multi-agent/registry.js";
import {
  BudgetEscrowManager,
  UncertainBudgetRefundError,
} from "../../src/multi-agent/budget-escrow.js";
import { MultiAgentProjection } from "../../src/multi-agent/projection.js";
import {
  AuthorityJailCompiler,
  BannedMountSecurityError,
  AuthorityJailViolationError,
} from "../../src/multi-agent/jail-compiler.js";
import { ChildMissionMaterializer } from "../../src/multi-agent/materializer.js";
import {
  AttributionBindingValidator,
  AttributionViolationError,
} from "../../src/multi-agent/attribution.js";
import {
  ProcessJail,
  JailSecurityViolationError,
} from "../../src/multi-agent/process-jail.js";
import { ChildRuntimeHost } from "../../src/multi-agent/child-host.js";
import { MultiAgentSupervisor } from "../../src/multi-agent/supervisor.js";
import { Ledger } from "../../src/ledger/ledger.js";
import type { Proposal } from "../../src/contracts/proposals.js";

const body = (n: number) => ("01HZZ" + "0".repeat(21) + String(n)).slice(-26);
const makeMisId = (n: number) => `mis_${body(n)}` as MissionId;
const makeGrtId = (n: number) => `grt_${body(n)}` as GrantId;
const makeDelId = (n: number) => `del_${body(n)}` as DelegationId;
const makeAgtId = (n: number) => `agt_${body(n)}` as AgentId;

const PARENT_BUDGET: DelegationBudget = {
  maxPlannerTurns: 50,
  maxModelCalls: 100,
  maxTokens: 2_000_000,
  maxCapabilityCalls: 100,
  maxRetries: 20,
  maxExecutionTimeMs: 3_600_000,
  maxArtifactBytes: 100 * 1024 * 1024,
  maxConcurrentTasks: 5,
  maxSubprocesses: 4,
};

const CHILD_BUDGET: DelegationBudget = {
  maxPlannerTurns: 20,
  maxModelCalls: 40,
  maxTokens: 500_000,
  maxCapabilityCalls: 40,
  maxRetries: 5,
  maxExecutionTimeMs: 1_800_000,
  maxArtifactBytes: 25 * 1024 * 1024,
  maxConcurrentTasks: 2,
  maxSubprocesses: 2,
};

const DEFAULT_BUDGET = CHILD_BUDGET;

function makeEnvelope(overrides: Partial<EffectiveAuthorityEnvelope> = {}): EffectiveAuthorityEnvelope {
  return {
    capabilities: ["fs"],
    constraints: {
      paths: ["subtasks"],
      hosts: ["api.example.com"],
    },
    riskCeiling: "write",
    allowHostExecution: false,
    isolationProfile: "sandboxed",
    budgetEscrow: { ...CHILD_BUDGET },
    depth: 1,
    maxChildren: 3,
    expiresAt: "2099-01-01T00:00:00Z" as Iso8601,
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
    status: "authorized",
    issuedAt: "2026-10-07T12:00:00Z" as Iso8601,
    expiresAt: "2026-10-08T12:00:00Z" as Iso8601,
    revokedAt: null,
    revocationReason: null,
    activeChildCount: 0,
    totalDescendantCount: 0,
    ...overrides,
  };
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `forge-p2b-${prefix}-`));
}

// ============================================================================
// 2B.1 Child Mission Materialization
// ============================================================================
test("P2B-001: Child mission materialization creates isolated directory tree with independent ledger and genesis record", () => {
  const tmp = createTempDir("001");
  try {
    const parentMisId = makeMisId(1);
    const childMisId = makeMisId(2);
    const delId = makeDelId(1);
    const authHash = "a".repeat(64) as Sha256Hex;
    const envelope = makeEnvelope();

    const result = ChildMissionMaterializer.materialize(
      tmp,
      parentMisId,
      childMisId,
      delId,
      authHash,
      envelope,
    );

    assert.equal(result.childMissionId, childMisId);
    assert.ok(existsSync(result.childMissionDir));
    assert.ok(existsSync(result.childWorkspaceDir));
    assert.ok(existsSync(result.childArtifactsDir));

    // Child ledger initialized with genesis record
    const current = result.childLedger.current();
    assert.ok(current !== null);
    assert.equal(current.kind, "mission.opened");
    assert.equal((current.body as any).intent.type, "child_delegation");
    assert.equal((current.body as any).intent.parentMissionId, parentMisId);
    assert.equal((current.body as any).intent.delegationId, delId);
    assert.equal((current.body as any).intent.effectiveAuthorityHash, authHash);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Banned Daemon Sockets
// ============================================================================
test("P2B-002: Authority-to-jail compiler strictly blocks container daemon sockets", () => {
  const banned = [
    "/var/run/docker.sock",
    "docker.sock",
    "/run/containerd/containerd.sock",
    "/var/run/podman.sock",
    "/var/run/crio.sock",
  ];

  for (const socketPath of banned) {
    assert.throws(
      () => {
        AuthorityJailCompiler.validateMountPath(socketPath);
      },
      (err: any) => {
        assert.ok(err instanceof BannedMountSecurityError);
        assert.match(err.message, /container daemon socket/i);
        return true;
      },
    );
  }
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Host Filesystem Root
// ============================================================================
test("P2B-003: Authority-to-jail compiler strictly blocks host filesystem root mounts", () => {
  const roots = ["/", "c:\\", "c:/", "\\"];

  for (const rootPath of roots) {
    assert.throws(
      () => {
        AuthorityJailCompiler.validateMountPath(rootPath);
      },
      (err: any) => {
        assert.ok(err instanceof BannedMountSecurityError);
        assert.match(err.message, /host root directory/i);
        return true;
      },
    );
  }
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Parent Mission Directory Isolation
// ============================================================================
test("P2B-004: Authority-to-jail compiler strictly blocks mounting parent mission or ledger directory", () => {
  const parentDir = "/var/forge/missions/mis_root_001";

  // Mounting parent dir directly
  assert.throws(
    () => {
      AuthorityJailCompiler.validateMountPath(parentDir, parentDir);
    },
    (err: any) => {
      assert.ok(err instanceof BannedMountSecurityError);
      assert.match(err.message, /parent mission or ledger directory/i);
      return true;
    },
  );

  // Mounting parent ledger journal subdirectory
  assert.throws(
    () => {
      AuthorityJailCompiler.validateMountPath(`${parentDir}/ledger/journal.ndjson`, parentDir);
    },
    (err: any) => {
      assert.ok(err instanceof BannedMountSecurityError);
      assert.match(err.message, /parent mission or ledger directory/i);
      return true;
    },
  );
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Sibling Workspace Isolation
// ============================================================================
test("P2B-005: Authority-to-jail compiler strictly blocks mounting sibling child workspaces", () => {
  const siblingDirA = "/var/forge/missions/mis_sibling_A";
  const siblingDirB = "/var/forge/missions/mis_sibling_B";

  assert.throws(
    () => {
      AuthorityJailCompiler.validateMountPath(siblingDirA, undefined, [siblingDirA, siblingDirB]);
    },
    (err: any) => {
      assert.ok(err instanceof BannedMountSecurityError);
      assert.match(err.message, /sibling child mission workspace/i);
      return true;
    },
  );
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Network Disabled Enforcement
// ============================================================================
test("P2B-006: Authority-to-jail equivalence: network disabled in envelope compiles to physical 'none' and blocks access", () => {
  // Envelope without network capabilities
  const envelope = makeEnvelope({ capabilities: ["fs"] });
  const config = AuthorityJailCompiler.compile(envelope, "mis_child_1", "/tmp/child1/workspace");

  assert.equal(config.networkPolicy.mode, "none");

  const jail = new ProcessJail(config);

  // Attempting outbound network access must be physically blocked by jail
  assert.throws(
    () => {
      jail.assertNetworkAllowed("api.example.com");
    },
    (err: any) => {
      assert.ok(err instanceof JailSecurityViolationError);
      assert.equal(err.violationType, "network_disabled");
      return true;
    },
  );
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Network Allowlist Enforcement
// ============================================================================
test("P2B-007: Authority-to-jail equivalence: network allowlist strictly enforced against unlisted hosts", () => {
  const envelope = makeEnvelope({
    capabilities: ["web_fetch"],
    isolationProfile: "containerized", // Allow containerized network
    constraints: { hosts: ["api.allowed.com", "sub.domain.org"] },
  });
  const config = AuthorityJailCompiler.compile(envelope, "mis_child_2", "/tmp/child2/workspace");

  assert.equal(config.networkPolicy.mode, "allowlist");
  assert.deepEqual(config.networkPolicy.allowedHosts, ["api.allowed.com", "sub.domain.org"]);

  const jail = new ProcessJail(config);

  // Allowed host succeeds
  assert.doesNotThrow(() => {
    jail.assertNetworkAllowed("api.allowed.com");
  });

  // Disallowed host is physically blocked
  assert.throws(
    () => {
      jail.assertNetworkAllowed("evil.attacker.com");
    },
    (err: any) => {
      assert.ok(err instanceof JailSecurityViolationError);
      assert.equal(err.violationType, "host_not_allowlisted");
      return true;
    },
  );
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Shell Privilege Restriction
// ============================================================================
test("P2B-008: Authority-to-jail equivalence: ungranted shell capability physically blocks shell commands", async () => {
  // Envelope without shell capability
  const envelope = makeEnvelope({ capabilities: ["fs"] });
  const config = AuthorityJailCompiler.compile(envelope, "mis_child_3", "/tmp/child3/workspace");

  assert.equal(config.allowShell, false);

  const jail = new ProcessJail(config);

  // assertShellAllowed throws
  assert.throws(
    () => {
      jail.assertShellAllowed();
    },
    (err: any) => {
      assert.ok(err instanceof JailSecurityViolationError);
      assert.equal(err.violationType, "shell_disabled");
      return true;
    },
  );

  // executeCommand with shell executable throws
  await assert.rejects(
    async () => {
      await jail.executeCommand(["sh", "-c", "echo leak"]);
    },
    (err: any) => {
      assert.ok(err instanceof JailSecurityViolationError);
      assert.equal(err.violationType, "shell_disabled");
      return true;
    },
  );
});

// ============================================================================
// 2B.3 Authority-to-Jail Equivalence: Credential Scrubbing & Zero Leakage
// ============================================================================
test("P2B-009: Authority-to-jail equivalence: parent credentials and ungranted secrets are scrubbed", () => {
  const parentCreds = {
    ANTHROPIC_API_KEY: "sk-ant-parent-secret-key-12345",
    OPENAI_API_KEY: "sk-parent-secret-openai",
    DATABASE_URL: "postgres://root:secret@db.internal:5432/forge",
  };

  const availableSecrets = {
    ...parentCreds,
    CHILD_PUBLIC_TOKEN: "token-abc-987",
  };

  // Envelope requests ONLY CHILD_PUBLIC_TOKEN
  const envelope = makeEnvelope({
    constraints: { secretNames: ["CHILD_PUBLIC_TOKEN"] },
  });

  const config = AuthorityJailCompiler.compile(
    envelope,
    "mis_child_4",
    "/tmp/child4/workspace",
    {
      parentCredentials: parentCreds,
      availableSecrets,
    },
  );

  // Parent credentials MUST NOT be present in child jail env
  assert.equal(config.env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(config.env["OPENAI_API_KEY"], undefined);
  assert.equal(config.env["DATABASE_URL"], undefined);

  // Only granted secret is injected
  assert.equal(config.env["CHILD_PUBLIC_TOKEN"], "token-abc-987");
});

// ============================================================================
// 2B.4 Process Jail: Path Traversal Escape Containment
// ============================================================================
test("P2B-010: Process jail physically blocks directory traversal escape attempts", () => {
  const tmp = createTempDir("010");
  try {
    const workspaceRoot = join(tmp, "child_ws");
    const envelope = makeEnvelope();
    const config = AuthorityJailCompiler.compile(envelope, "mis_child_5", workspaceRoot);
    const jail = new ProcessJail(config);

    const escapes = [
      "../parent.txt",
      "../../etc/passwd",
      "../../../secret.key",
      "subtasks/../../escape.txt",
    ];

    for (const escapePath of escapes) {
      assert.throws(
        () => {
          jail.assertPathAccessAllowed(escapePath);
        },
        (err: any) => {
          assert.ok(err instanceof JailSecurityViolationError);
          assert.equal(err.violationType, "filesystem_boundary_escape");
          return true;
        },
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.4 Process Jail: Sibling Prefix Collision Escape
// ============================================================================
test("P2B-011: Process jail physically blocks sibling prefix collision attacks (e.g. child_ws-evil)", () => {
  const tmp = createTempDir("011");
  try {
    const workspaceRoot = join(tmp, "child_ws");
    const envelope = makeEnvelope();
    const config = AuthorityJailCompiler.compile(envelope, "mis_child_6", workspaceRoot);
    const jail = new ProcessJail(config);

    // Sibling directory that starts with the same prefix
    const siblingPrefixAttack = "../child_ws-evil/secret.txt";

    assert.throws(
      () => {
        jail.assertPathAccessAllowed(siblingPrefixAttack);
      },
      (err: any) => {
        assert.ok(err instanceof JailSecurityViolationError);
        assert.equal(err.violationType, "filesystem_boundary_escape");
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.5 Attribution Binding: Caller Context Verification
// ============================================================================
test("P2B-012: Attribution binding rejects missing callerContext on execution dispatch", () => {
  const expected = {
    childMissionId: makeMisId(2),
    childAgentId: makeAgtId(2),
    delegationId: makeDelId(1),
    incarnationEpoch: 1,
  };

  assert.throws(
    () => {
      AttributionBindingValidator.validateCallerContext(undefined, expected);
    },
    (err: any) => {
      assert.ok(err instanceof AttributionViolationError);
      assert.equal(err.violationType, "missing_caller_context");
      return true;
    },
  );
});

// ============================================================================
// 2B.5 Attribution Binding: Delegation & Agent Mismatch Detection
// ============================================================================
test("P2B-013: Attribution binding rejects caller masquerading under different delegation or agent ID", () => {
  const expected = {
    childMissionId: makeMisId(2),
    childAgentId: makeAgtId(2),
    delegationId: makeDelId(1),
    incarnationEpoch: 1,
  };

  // Wrong delegation ID
  assert.throws(
    () => {
      AttributionBindingValidator.validateCallerContext(
        { agentId: makeAgtId(2), delegationId: makeDelId(99), incarnationEpoch: 1 },
        expected,
      );
    },
    (err: any) => {
      assert.ok(err instanceof AttributionViolationError);
      assert.equal(err.violationType, "delegation_mismatch");
      return true;
    },
  );

  // Wrong agent ID
  assert.throws(
    () => {
      AttributionBindingValidator.validateCallerContext(
        { agentId: makeAgtId(99), delegationId: makeDelId(1), incarnationEpoch: 1 },
        expected,
      );
    },
    (err: any) => {
      assert.ok(err instanceof AttributionViolationError);
      assert.equal(err.violationType, "agent_mismatch");
      return true;
    },
  );
});

// ============================================================================
// 2B.5 Attribution Binding: Stale Incarnation Epoch
// ============================================================================
test("P2B-014: Attribution binding rejects stale incarnation epoch", () => {
  const expected = {
    childMissionId: makeMisId(2),
    childAgentId: makeAgtId(2),
    delegationId: makeDelId(1),
    incarnationEpoch: 2, // Reincarnated epoch
  };

  assert.throws(
    () => {
      AttributionBindingValidator.validateCallerContext(
        { agentId: makeAgtId(2), delegationId: makeDelId(1), incarnationEpoch: 1 }, // Stale
        expected,
      );
    },
    (err: any) => {
      assert.ok(err instanceof AttributionViolationError);
      assert.equal(err.violationType, "epoch_mismatch");
      return true;
    },
  );
});

// ============================================================================
// 2B.5 Attribution Binding: Record Mission Masquerade Prevention
// ============================================================================
test("P2B-015: Attribution binding rejects child record masquerading under parent mission ID", () => {
  const parentMisId = makeMisId(1);
  const childMisId = makeMisId(2);

  assert.throws(
    () => {
      AttributionBindingValidator.validateRecordAttribution(parentMisId, childMisId);
    },
    (err: any) => {
      assert.ok(err instanceof AttributionViolationError);
      assert.equal(err.violationType, "mission_masquerade");
      return true;
    },
  );
});

// ============================================================================
// 2B.2 Host Supervisor: Child Activation Lifecycle
// ============================================================================
test("P2B-016: Host supervisor activates child mission, updates registry, and commits delegation.activated", async () => {
  const tmp = createTempDir("016");
  try {
    const parentMisId = makeMisId(10);
    const childMisId = makeMisId(20);
    const delId = makeDelId(16);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelope = makeEnvelope();
    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveAuthorityHash: "b".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelope,
      status: "authorized",
    });

    registry.registerDelegation(entry);
    projection.applyRecord({
      seq: 1,
      kind: "delegation.authorized",
      body: {
        delegationId: delId,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisId,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [delId],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "b".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
        newAvailableTokens: 900_000,
      },
    });

    budgetManager.atomicReserveEscrow(delId, envelope.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    const childHost = await supervisor.activateChild(delId);

    assert.ok(childHost !== undefined);
    assert.equal(childHost.childMissionId, childMisId);
    assert.equal(registry.getDelegation(delId)?.status, "active");

    // Parent ledger received delegation.activated
    const parentCurrent = parentLedger.current();
    assert.ok(parentCurrent !== null);
    assert.equal(parentCurrent.kind, "delegation.activated");
    assert.equal((parentCurrent.body as any).delegationId, delId);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.6 Capability Execution: Child Workspace Confinement & Observation Commit
// ============================================================================
test("P2B-017: Legitimate child proposal executes inside jail and appends typed observation to child ledger", async () => {
  const tmp = createTempDir("017");
  try {
    const parentMisId = makeMisId(11);
    const childMisId = makeMisId(21);
    const delId = makeDelId(17);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelope = makeEnvelope({
      capabilities: ["fs"],
      constraints: { paths: ["workspace/output.txt"] },
    });

    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveAuthorityHash: "c".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelope,
      status: "authorized",
    });

    registry.registerDelegation(entry);
    projection.applyRecord({
      seq: 1,
      kind: "delegation.authorized",
      body: {
        delegationId: delId,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisId,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [delId],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "c".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
        newAvailableTokens: 900_000,
      },
    });

    budgetManager.atomicReserveEscrow(delId, envelope.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    await supervisor.activateChild(delId);

    const fsProposal: Proposal = {
      capability: "fs",
      args: { op: "write", path: "workspace/output.txt", contentRef: "0".repeat(64) },
    };

    const res = await supervisor.executeChildProposal(delId, fsProposal, {
      agentId: makeAgtId(2),
      delegationId: delId,
      incarnationEpoch: 1,
    });

    assert.equal(res.ok, true);
    assert.equal(res.verdict.type, "allow");

    // Verify child ledger received observation.fs
    const childHost = supervisor.getChildHost(delId)!;
    const childRecord = childHost.childLedger.current();
    assert.ok(childRecord !== null);
    assert.equal(childRecord.kind, "observation.fs");
    assert.equal((childRecord.body as any).path, "workspace/output.txt");

    // Verify budget spend recorded
    const escrow = budgetManager.getEscrow(delId);
    assert.equal(escrow?.consumed.capabilityCalls, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.7 Revocation / Kill: Bounded Termination & Budget Freeze
// ============================================================================
test("P2B-018: Revocation triggers bounded process kill, marks status revoked, and freezes budget as UNCERTAIN", async () => {
  const tmp = createTempDir("018");
  try {
    const parentMisId = makeMisId(12);
    const childMisId = makeMisId(22);
    const delId = makeDelId(18);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelope = makeEnvelope();
    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveAuthorityHash: "d".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelope,
      status: "authorized",
      hostPid: 99999, // Mock pid
    });

    registry.registerDelegation(entry);
    projection.applyRecord({
      seq: 1,
      kind: "delegation.authorized",
      body: {
        delegationId: delId,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisId,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [delId],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "d".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
        newAvailableTokens: 900_000,
      },
    });

    budgetManager.atomicReserveEscrow(delId, envelope.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    await supervisor.activateChild(delId);

    // Revoke child
    await supervisor.revokeChild(delId, "Security Policy Breach", "operator");

    assert.equal(registry.getDelegation(delId)?.status, "revoked");
    assert.equal(supervisor.getChildHost(delId), undefined);

    // Parent ledger received delegation.revoked
    const current = parentLedger.current();
    assert.ok(current !== null);
    assert.equal(current.kind, "delegation.revoked");
    assert.equal((current.body as any).delegationId, delId);

    // Budget escrow is UNCERTAIN and cannot be refunded directly
    assert.throws(
      () => {
        budgetManager.refundUncertainDirectly(delId);
      },
      (err: any) => {
        assert.ok(err instanceof UncertainBudgetRefundError);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.8 Crash Boundaries: Abrupt Child Crash Handling
// ============================================================================
test("P2B-019: Child crash boundary marks delegation crashed, emits parent revocation, and freezes budget escrow", async () => {
  const tmp = createTempDir("019");
  try {
    const parentMisId = makeMisId(13);
    const childMisId = makeMisId(23);
    const delId = makeDelId(19);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelope = makeEnvelope();
    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveAuthorityHash: "e".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelope,
      status: "authorized",
      hostPid: 99998,
    });

    registry.registerDelegation(entry);
    projection.applyRecord({
      seq: 1,
      kind: "delegation.authorized",
      body: {
        delegationId: delId,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisId,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [delId],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "e".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
        newAvailableTokens: 900_000,
      },
    });

    budgetManager.atomicReserveEscrow(delId, envelope.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    await supervisor.activateChild(delId);

    // Simulate child process crash with exit code 137 (SIGKILL/OOM)
    await supervisor.handleChildCrash(delId, 137, "Child process killed by OOM killer");

    assert.equal(registry.getDelegation(delId)?.status, "crashed");
    assert.equal(supervisor.getChildHost(delId), undefined);

    const current = parentLedger.current();
    assert.ok(current !== null);
    assert.equal(current.kind, "delegation.revoked");
    assert.match((current.body as any).reason, /exit code 137/);

    // Direct refund forbidden
    assert.throws(
      () => {
        budgetManager.refundUncertainDirectly(delId);
      },
      (err: any) => {
        assert.ok(err instanceof UncertainBudgetRefundError);
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2B.9 Multi-Agent Concurrent Execution with Sibling Isolation
// ============================================================================
test("P2B-020: Multi-agent concurrent isolation: Child A and Child B operate concurrently without interference; cross-sibling access blocked", async () => {
  const tmp = createTempDir("020");
  try {
    const parentMisId = makeMisId(14);
    const childMisIdA = makeMisId(24);
    const childMisIdB = makeMisId(25);
    const delIdA = makeDelId(20);
    const delIdB = makeDelId(21);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelopeA = makeEnvelope({
      capabilities: ["fs"],
      constraints: { paths: ["workspace/fileA.txt"] },
    });

    const envelopeB = makeEnvelope({
      capabilities: ["fs"],
      constraints: { paths: ["workspace/fileB.txt"] },
    });

    const entryA = makeRegistryEntry({
      delegationId: delIdA,
      parentMissionId: parentMisId,
      childMissionId: childMisIdA,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      ancestorPath: [delIdA],
      effectiveAuthorityHash: "f".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelopeA,
      status: "authorized",
    });

    const entryB = makeRegistryEntry({
      delegationId: delIdB,
      parentMissionId: parentMisId,
      childMissionId: childMisIdB,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(3),
      ancestorPath: [delIdB],
      grantId: makeGrtId(2),
      effectiveAuthorityHash: "1".repeat(64) as Sha256Hex,
      effectiveEnvelope: envelopeB,
      status: "authorized",
    });

    registry.registerDelegation(entryA);
    registry.registerDelegation(entryB);

    projection.applyRecord({
      seq: 1,
      kind: "delegation.authorized",
      body: {
        delegationId: delIdA,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisIdA,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(2),
        depth: 1,
        ancestorPath: [delIdA],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(1),
        grantRevision: 1,
        effectiveAuthorityHash: "f".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelopeA,
        budgetEscrow: envelopeA.budgetEscrow,
        newAvailableTokens: 900_000,
      },
    });

    projection.applyRecord({
      seq: 2,
      kind: "delegation.authorized",
      body: {
        delegationId: delIdB,
        parentDelegationId: null,
        parentMissionId: parentMisId,
        childMissionId: childMisIdB,
        parentAgentId: makeAgtId(1),
        childAgentId: makeAgtId(3),
        depth: 1,
        ancestorPath: [delIdB],
        childIncarnationEpoch: 1,
        grantId: makeGrtId(2),
        grantRevision: 1,
        effectiveAuthorityHash: "1".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelopeB,
        budgetEscrow: envelopeB.budgetEscrow,
        newAvailableTokens: 800_000,
      },
    });

    budgetManager.atomicReserveEscrow(delIdA, envelopeA.budgetEscrow);
    budgetManager.atomicReserveEscrow(delIdB, envelopeB.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    // Concurrently activate Child A and Child B
    const [hostA, hostB] = await Promise.all([
      supervisor.activateChild(delIdA),
      supervisor.activateChild(delIdB),
    ]);

    // Child A executes valid proposal in its workspace
    const resA = await supervisor.executeChildProposal(delIdA, {
      capability: "fs",
      args: { op: "write", path: "workspace/fileA.txt", contentRef: "0".repeat(64) },
    }, { agentId: makeAgtId(2), delegationId: delIdA, incarnationEpoch: 1 });
    assert.equal(resA.ok, true);

    // Child B executes valid proposal in its workspace
    const resB = await supervisor.executeChildProposal(delIdB, {
      capability: "fs",
      args: { op: "write", path: "workspace/fileB.txt", contentRef: "0".repeat(64) },
    }, { agentId: makeAgtId(3), delegationId: delIdB, incarnationEpoch: 1 });
    assert.equal(resB.ok, true);

    // Malicious Child A attempts to write into Child B's workspace via relative path traversal
    const siblingAttackProposal: Proposal = {
      capability: "fs",
      args: {
        op: "write",
        path: `../../${childMisIdB}/workspace/pwned.txt`,
        contentRef: "0".repeat(64),
      },
    };

    const resAttack = await supervisor.executeChildProposal(delIdA, siblingAttackProposal, {
      agentId: makeAgtId(2),
      delegationId: delIdA,
      incarnationEpoch: 1,
    });

    // The attack MUST fail closed
    assert.equal(resAttack.ok, false);

    // Verify Child B's workspace was NOT mutated by Child A
    const bFile = join(hostB.childWorkspaceRoot, "pwned.txt");
    assert.equal(existsSync(bFile), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
