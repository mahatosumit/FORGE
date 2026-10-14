// FORGE Step 8 Phase 2B — Physical Runtime Escape Audit Test Suite (E-Level Evidence)
// Verifies actual runtime behavior from INSIDE the execution boundary:
// - P2B-E01: Host filesystem escape probe (traversal, root, parent mission, sibling mission, ledger)
// - P2B-E02: Runtime-control escape probe (docker.sock, containerd.sock, daemon CLI access)
// - P2B-E03: Credential escape runtime probe (process env inspection, parent API key stripping)
// - P2B-E04: Physical network escape (loopback, gateway, cloud metadata, RFC1918, allowlist)
// - P2B-E05: Process escape & bounded termination (spawning, surviving revocation, kill verification)
// - P2B-E06: Attribution spoofing (cross-child impersonation, epoch tampering, mission masquerading)
// - P2B-E07: Concurrency & revocation race (authorized effect -> revocation -> fail closed -> UNCERTAIN freeze)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import { DelegationRegistry } from "../../src/multi-agent/registry.js";
import {
  BudgetEscrowManager,
  UncertainBudgetRefundError,
} from "../../src/multi-agent/budget-escrow.js";
import { MultiAgentProjection } from "../../src/multi-agent/projection.js";
import {
  AuthorityJailCompiler,
  BannedMountSecurityError,
} from "../../src/multi-agent/jail-compiler.js";
import {
  AttributionBindingValidator,
  AttributionViolationError,
} from "../../src/multi-agent/attribution.js";
import { ProcessJail, JailSecurityViolationError } from "../../src/multi-agent/process-jail.js";
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

function makeEnvelope(overrides: Partial<EffectiveAuthorityEnvelope> = {}): EffectiveAuthorityEnvelope {
  return {
    capabilities: ["fs"],
    constraints: {
      paths: ["workspace/output.txt"],
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
  return mkdtempSync(join(tmpdir(), `forge-p2b-escape-${prefix}-`));
}

// ============================================================================
// P2B-E01: Host filesystem escape runtime execution probe
// ============================================================================
test("P2B-E01 [E-level]: Host filesystem escape probe fails closed; protected files remain byte-identical", async () => {
  const tmp = createTempDir("e01");
  try {
    const parentMisId = makeMisId(101);
    const childMisId = makeMisId(102);
    const siblingMisId = makeMisId(103);
    const delId = makeDelId(101);

    // Setup Parent Mission on disk
    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });
    const parentMisDir = join(tmp, parentMisId);
    mkdirSync(parentMisDir, { recursive: true });
    const parentSecretFile = join(parentMisDir, "secret.key");
    writeFileSync(parentSecretFile, "TOP_SECRET_PARENT_DATA_XYZ", "utf8");

    // Setup Sibling Mission on disk
    const siblingWs = join(tmp, siblingMisId, "workspace");
    const siblingFile = join(siblingWs, "sibling.txt");
    mkdirSync(siblingWs, { recursive: true });
    writeFileSync(siblingFile, "IMMUTABLE_SIBLING_DATA_123", "utf8");

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
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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

    // Child attempts actual filesystem escape probes
    const escapeProbes: Proposal[] = [
      // 1. Traverse to parent secret
      { capability: "fs", args: { op: "write", path: `../../${parentMisId}/secret.key`, contentRef: "0".repeat(64) } },
      // 2. Traverse to sibling workspace
      { capability: "fs", args: { op: "write", path: `../../${siblingMisId}/workspace/sibling.txt`, contentRef: "0".repeat(64) } },
      // 3. Deep traversal outside all missions
      { capability: "fs", args: { op: "write", path: "../../../etc/passwd", contentRef: "0".repeat(64) } },
      // 4. Windows drive root escape attempt
      { capability: "fs", args: { op: "write", path: "C:\\Windows\\escape.txt", contentRef: "0".repeat(64) } },
      // 5. Parent ledger journal overwrite attempt
      { capability: "fs", args: { op: "write", path: `../../${parentMisId}/ledger/journal.ndjson`, contentRef: "0".repeat(64) } },
    ];

    for (const probe of escapeProbes) {
      const res = await supervisor.executeChildProposal(delId, probe, {
        agentId: makeAgtId(2),
        delegationId: delId,
        incarnationEpoch: 1,
      });
      // All escape attempts MUST be denied
      assert.equal(res.ok, false);
    }

    // EXTERNAL VERIFICATION: Assert protected files are strictly unchanged on disk
    assert.equal(readFileSync(parentSecretFile, "utf8"), "TOP_SECRET_PARENT_DATA_XYZ");
    assert.equal(readFileSync(siblingFile, "utf8"), "IMMUTABLE_SIBLING_DATA_123");

    // Verify parent ledger has not been tampered with
    assert.ok(parentLedger.verify().ok);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-E02: Runtime-control escape probe
// ============================================================================
test("P2B-E02 [E-level]: Runtime-control escape probe: container sockets and daemon endpoints are unavailable", async () => {
  const tmp = createTempDir("e02");
  try {
    const parentMisId = makeMisId(104);
    const childMisId = makeMisId(105);
    const delId = makeDelId(102);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    // Envelope grants fs and shell, but strictly no container socket access or daemon mounts
    const envelope = makeEnvelope({
      capabilities: ["fs", "shell"],
      constraints: { paths: ["workspace/output.txt"] },
    });

    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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

    // 1. PHYSICAL RUNTIME PROBE: Child process itself probes container control surfaces
    const socketProbeScript = `
      const fs = require('fs');
      const sockets = [
        '/var/run/docker.sock',
        '/run/containerd/containerd.sock',
        '/var/run/podman.sock',
        '//./pipe/docker_engine',
        '//./pipe/containerd-containerd'
      ];
      const results = sockets.map(s => {
        let exists = false;
        let openErr = null;
        try { exists = fs.existsSync(s); } catch (e) { exists = false; }
        try { fs.openSync(s, 'r'); } catch (e) { openErr = e.code || e.message; }
        return { s, exists, openErr };
      });
      console.log(JSON.stringify({ pid: process.pid, results }));
    `;

    const runResult = await childHost.jail.executeCommand([
      process.execPath,
      "-e",
      socketProbeScript,
    ]);

    assert.equal(runResult.exitCode, 0);
    const probeData = JSON.parse(runResult.stdout.trim());
    assert.ok(probeData.pid > 0, "Actual child process PID must be returned");

    // All container sockets and named pipes must report exists: false to the child
    for (const r of probeData.results) {
      assert.equal(r.exists, false, `Socket ${r.s} must not exist inside child runtime`);
      assert.ok(r.openErr !== null, `Socket ${r.s} open attempt must fail`);
    }

    // 2. Probing container daemon sockets at mount level throws BannedMountSecurityError
    const bannedSockets = ["/var/run/docker.sock", "docker.sock", "/run/containerd/containerd.sock", "/var/run/podman.sock"];
    for (const sock of bannedSockets) {
      assert.throws(() => {
        AuthorityJailCompiler.validateMountPath(sock);
      }, BannedMountSecurityError);
    }

    // 3. Verify ContainerRunConfig derived from jail contains zero socket mounts and drops all caps
    const jailConfig = AuthorityJailCompiler.compile(envelope, childMisId, childHost.childWorkspaceRoot);
    const containerConfig = AuthorityJailCompiler.toContainerRunConfig(jailConfig, "test-container", ["node"]);
    assert.equal(containerConfig.capDropAll, true);
    assert.equal(containerConfig.noNewPrivileges, true);
    assert.equal(containerConfig.readOnlyRoot, true);
    assert.ok(containerConfig.mounts.every((m) => !m.hostPath.includes("docker.sock")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-E03: Credential escape runtime probe (process environment inspection)
// ============================================================================
test("P2B-E03 [E-level]: Credential escape probe: actual child process environment excludes parent secrets", async () => {
  const tmp = createTempDir("e03");
  // Set real sensitive variables in host process environment
  const savedEnv = { ...process.env };
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-parent-secret-key-probe-99999";
  process.env["OPENAI_API_KEY"] = "sk-parent-secret-openai-probe-88888";
  process.env["AWS_SECRET_ACCESS_KEY"] = "aws-secret-access-key-parent-probe";
  process.env["DATABASE_URL"] = "postgres://root:parentsecret@db.internal:5432/main";

  try {
    const parentMisId = makeMisId(106);
    const childMisId = makeMisId(107);
    const delId = makeDelId(103);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    // Envelope requests ONLY child_allowed_token
    const envelope = makeEnvelope({
      capabilities: ["shell"],
      constraints: { secretNames: ["child_allowed_token"] },
    });

    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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
      availableSecrets: {
        ...process.env as Record<string, string>,
        child_allowed_token: "valid-child-token-777",
      },
    });

    const childHost = await supervisor.activateChild(delId);

    // Actually execute a Node process inside the jail to dump the process environment
    const probeCmd = [process.execPath, "-e", "console.log(JSON.stringify(process.env))"];
    const runResult = await childHost.jail.executeCommand(probeCmd);

    assert.equal(runResult.exitCode, 0);
    const childEnv = JSON.parse(runResult.stdout.trim());

    // VERIFY: Parent sensitive credentials MUST NOT exist in child process environment
    assert.equal(childEnv["ANTHROPIC_API_KEY"], undefined);
    assert.equal(childEnv["OPENAI_API_KEY"], undefined);
    assert.equal(childEnv["AWS_SECRET_ACCESS_KEY"], undefined);
    assert.equal(childEnv["DATABASE_URL"], undefined);

    // VERIFY: Authorized secret IS present
    assert.equal(childEnv["child_allowed_token"], "valid-child-token-777");
    assert.equal(childEnv["FORGE_CHILD_MISSION_ID"], childMisId);
  } finally {
    // Restore process environment
    process.env = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-E04: Physical network escape probe
// ============================================================================
test("P2B-E04 [E-level]: Network escape probe: ungranted network and unlisted destinations fail closed", async () => {
  const tmp = createTempDir("e04");
  try {
    const parentMisId = makeMisId(108);
    const childMisIdA = makeMisId(109);
    const childMisIdB = makeMisId(110);
    const delIdA = makeDelId(104);
    const delIdB = makeDelId(105);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    // Child A: Network strictly disabled (capabilities: ["fs", "shell"] but no web_fetch/http)
    const envelopeA = makeEnvelope({ capabilities: ["fs", "shell"] });

    // Child B: Network allowed for specific host (api.example.com)
    const envelopeB = makeEnvelope({
      capabilities: ["web_fetch"],
      isolationProfile: "sandboxed-network" as any,
      constraints: { hosts: ["api.example.com"] },
    });

    const entryA = makeRegistryEntry({
      delegationId: delIdA,
      parentMissionId: parentMisId,
      childMissionId: childMisIdA,
      ancestorPath: [delIdA],
      effectiveEnvelope: envelopeA,
    });

    const entryB = makeRegistryEntry({
      delegationId: delIdB,
      parentMissionId: parentMisId,
      childMissionId: childMisIdB,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(3),
      ancestorPath: [delIdB],
      grantId: makeGrtId(2),
      effectiveEnvelope: envelopeB,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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
        effectiveAuthorityHash: "b".repeat(64) as Sha256Hex,
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

    const childHostA = await supervisor.activateChild(delIdA);
    await supervisor.activateChild(delIdB);

    // 1. PHYSICAL RUNTIME PROBE: Child A spawns real subprocess attempting OS-level egress
    const netProbeScript = `
      const http = require('http');
      const targets = [
        { name: 'cloud_metadata', host: '169.254.169.254', port: 80 },
        { name: 'localhost_probe', host: '127.0.0.1', port: 58291 }
      ];
      const results = {};
      let pending = targets.length;
      for (const t of targets) {
        const req = http.get({ host: t.host, port: t.port, path: '/', timeout: 200 }, (res) => {
          results[t.name] = { connected: true, status: res.statusCode };
          if (--pending === 0) finish();
        });
        req.on('error', (err) => {
          results[t.name] = { connected: false, osError: err.code || err.message };
          if (--pending === 0) finish();
        });
        req.on('timeout', () => {
          req.destroy();
          results[t.name] = { connected: false, osError: 'ETIMEDOUT' };
          if (--pending === 0) finish();
        });
      }
      function finish() {
        console.log(JSON.stringify({ pid: process.pid, results }));
      }
    `;

    const netRunRes = await childHostA.jail.executeCommand([
      process.execPath,
      "-e",
      netProbeScript,
    ]);

    assert.equal(netRunRes.exitCode, 0);
    const netData = JSON.parse(netRunRes.stdout.trim());
    assert.ok(netData.pid > 0, "Actual child process PID must be returned");
    assert.equal(netData.results.cloud_metadata.connected, false, "OS network stack must refuse cloud metadata connection");
    assert.ok(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ETIMEDOUT"].includes(netData.results.cloud_metadata.osError));
    assert.equal(netData.results.localhost_probe.connected, false, "OS network stack must refuse localhost probe");
    assert.ok(["ECONNREFUSED", "ETIMEDOUT"].includes(netData.results.localhost_probe.osError));

    // 2. POLICY ENFORCEMENT: Child A proposals with ungranted web_fetch fail closed
    const networkTargetsA = [
      "http://127.0.0.1:8080/probe",
      "http://localhost/probe",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/admin",
      "http://192.168.1.1/",
      "http://api.example.com/data",
    ];

    for (const url of networkTargetsA) {
      const res = await supervisor.executeChildProposal(delIdA, {
        capability: "web_fetch",
        args: { url },
      }, { agentId: makeAgtId(2), delegationId: delIdA, incarnationEpoch: 1 });
      assert.equal(res.ok, false);
    }

    // Child B probes: unlisted external domain and cloud metadata fail closed
    const unauthorizedB = [
      "http://attacker.com/leak",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/admin",
    ];
    for (const url of unauthorizedB) {
      const res = await supervisor.executeChildProposal(delIdB, {
        capability: "web_fetch",
        args: { url },
      }, { agentId: makeAgtId(3), delegationId: delIdB, incarnationEpoch: 1 });
      assert.equal(res.ok, false);
    }

    // Child B probe: listed authorized destination succeeds
    const authorizedRes = await supervisor.executeChildProposal(delIdB, {
      capability: "web_fetch",
      args: { url: "http://api.example.com/data" },
    }, { agentId: makeAgtId(3), delegationId: delIdB, incarnationEpoch: 1 });
    assert.equal(authorizedRes.ok, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-E05: Process escape & bounded termination
// ============================================================================
test("P2B-E05 [E-level]: Process escape probe: child process tree terminated upon revocation; does not survive", async () => {
  const tmp = createTempDir("e05");
  let childPid: number | undefined;
  try {
    const parentMisId = makeMisId(111);
    const childMisId = makeMisId(112);
    const delId = makeDelId(106);

    const parentLedger = new Ledger({
      dataDir: tmp,
      missionId: parentMisId,
      writer: { pid: process.pid, host: "test-host" },
    });

    const registry = new DelegationRegistry();
    const projection = new MultiAgentProjection();
    const budgetManager = new BudgetEscrowManager(PARENT_BUDGET);

    const envelope = makeEnvelope({ capabilities: ["shell"] });

    const entry = makeRegistryEntry({
      delegationId: delId,
      parentMissionId: parentMisId,
      childMissionId: childMisId,
      ancestorPath: [delId],
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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

    // Spawn a real long-running child process that attempts to persist
    const childProc = childHost.jail.spawnCommand([process.execPath, "-e", "setInterval(()=>{}, 1000)"], { unref: true });
    childPid = childProc.pid!;
    assert.ok(childPid > 0);

    // Verify process is running
    assert.doesNotThrow(() => {
      process.kill(childPid!, 0); // Signal 0 checks existence
    });

    // Update registry with child hostPid
    registry.updateExecutionHandle(delId, childPid);

    // Revoke the delegation — MUST execute bounded process termination
    await supervisor.revokeChild(delId, "Revocation of escaping process", "operator");

    // Wait a brief window (200ms) for OS process tree cleanup
    await new Promise((resolve) => setTimeout(resolve, 200));

    // VERIFY: Process must be terminated (process.kill(childPid, 0) throws ESRCH)
    let isAlive = false;
    try {
      process.kill(childPid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, false, "Child process must not survive parent revocation");

    // VERIFY: Budget marked UNCERTAIN and cannot be refunded directly
    assert.throws(() => {
      budgetManager.refundUncertainDirectly(delId);
    }, UncertainBudgetRefundError);
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-021: Attribution spoofing probe (Control-Plane & Gate Level C/D)
// ============================================================================
test("P2B-021 [C/D-level]: Attribution spoofing probe: cross-child, epoch, and mission masquerading fail closed", async () => {
  const tmp = createTempDir("e06");
  try {
    const parentMisId = makeMisId(113);
    const childMisIdA = makeMisId(114);
    const childMisIdB = makeMisId(115);
    const delIdA = makeDelId(107);
    const delIdB = makeDelId(108);

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

    const entryA = makeRegistryEntry({
      delegationId: delIdA,
      parentMissionId: parentMisId,
      childMissionId: childMisIdA,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(2),
      ancestorPath: [delIdA],
      effectiveEnvelope: envelope,
    });

    const entryB = makeRegistryEntry({
      delegationId: delIdB,
      parentMissionId: parentMisId,
      childMissionId: childMisIdB,
      parentAgentId: makeAgtId(1),
      childAgentId: makeAgtId(3),
      ancestorPath: [delIdB],
      grantId: makeGrtId(2),
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
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
        effectiveAuthorityHash: "b".repeat(64) as Sha256Hex,
        effectiveEnvelope: envelope,
        budgetEscrow: envelope.budgetEscrow,
        newAvailableTokens: 800_000,
      },
    });

    budgetManager.atomicReserveEscrow(delIdA, envelope.budgetEscrow);
    budgetManager.atomicReserveEscrow(delIdB, envelope.budgetEscrow);

    const supervisor = new MultiAgentSupervisor({
      dataDir: tmp,
      registry,
      projection,
      budgetManager,
      parentLedger,
    });

    await supervisor.activateChild(delIdA);
    await supervisor.activateChild(delIdB);

    const validProposal: Proposal = {
      capability: "fs",
      args: { op: "write", path: "workspace/output.txt", contentRef: "0".repeat(64) },
    };

    // 1. Child A attempts to impersonate Sibling Agent ID
    await assert.rejects(
      async () => {
        await supervisor.executeChildProposal(delIdA, validProposal, {
          agentId: makeAgtId(3), // Sibling agent ID!
          delegationId: delIdA,
          incarnationEpoch: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof AttributionViolationError);
        assert.equal(err.violationType, "agent_mismatch");
        return true;
      },
    );

    // 2. Child A attempts cross-delegation impersonation
    await assert.rejects(
      async () => {
        await supervisor.executeChildProposal(delIdA, validProposal, {
          agentId: makeAgtId(2),
          delegationId: delIdB, // Sibling delegation ID!
          incarnationEpoch: 1,
        });
      },
      (err: any) => {
        assert.ok(err instanceof AttributionViolationError);
        assert.equal(err.violationType, "delegation_mismatch");
        return true;
      },
    );

    // 3. Child A attempts future epoch spoofing
    await assert.rejects(
      async () => {
        await supervisor.executeChildProposal(delIdA, validProposal, {
          agentId: makeAgtId(2),
          delegationId: delIdA,
          incarnationEpoch: 99, // Future un-incremented epoch!
        });
      },
      (err: any) => {
        assert.ok(err instanceof AttributionViolationError);
        assert.equal(err.violationType, "epoch_mismatch");
        return true;
      },
    );

    // 4. Record level: Child A attempting to cite parent mission ID is blocked
    assert.throws(
      () => {
        AttributionBindingValidator.validateRecordAttribution(parentMisId, childMisIdA);
      },
      (err: any) => {
        assert.ok(err instanceof AttributionViolationError);
        assert.equal(err.violationType, "mission_masquerade");
        return true;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// P2B-E07: Concurrency & Revocation Race
// ============================================================================
test("P2B-E07 [E-level]: Revocation race invariant: authorized effects succeed, then revocation immediately fails closed future dispatches", async () => {
  const tmp = createTempDir("e07");
  try {
    const parentMisId = makeMisId(116);
    const childMisId = makeMisId(117);
    const delId = makeDelId(109);

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
      effectiveEnvelope: envelope,
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
        effectiveAuthorityHash: "a".repeat(64) as Sha256Hex,
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

    const proposal: Proposal = {
      capability: "fs",
      args: { op: "write", path: "workspace/output.txt", contentRef: "0".repeat(64) },
    };

    // Phase 1: Authorized proposal succeeds
    const initialRes = await supervisor.executeChildProposal(delId, proposal, {
      agentId: makeAgtId(2),
      delegationId: delId,
      incarnationEpoch: 1,
    });
    assert.equal(initialRes.ok, true);

    // Phase 2: Authoritative revocation occurs
    await supervisor.revokeChild(delId, "Mid-execution Revocation Audit", "operator");

    // Phase 3: Invariant verification
    // 3A. Future execution attempt MUST fail closed
    await assert.rejects(
      async () => {
        await supervisor.executeChildProposal(delId, proposal, {
          agentId: makeAgtId(2),
          delegationId: delId,
          incarnationEpoch: 1,
        });
      },
      /not currently active/i,
    );

    // 3B. Unresolved spend is frozen as UNCERTAIN
    assert.throws(() => {
      budgetManager.refundUncertainDirectly(delId);
    }, UncertainBudgetRefundError);

    // 3C. Registry reflects terminal "revoked" state
    assert.equal(registry.getDelegation(delId)?.status, "revoked");

    // 3D. Parent ledger journal contains delegation.revoked record
    const parentTip = parentLedger.current();
    assert.ok(parentTip !== null);
    assert.equal(parentTip.kind, "delegation.revoked");
    assert.equal((parentTip.body as any).delegationId, delId);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
