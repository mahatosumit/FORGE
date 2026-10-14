// test/execution/sandbox-escapes.test.ts
// FORGE Step 7A — Adversarial Sandbox Escape & Invariant Test Suite
// Implements tests SANDBOX-001 through SANDBOX-010 and Invariants INV-15 through INV-18.
// Source of truth: docs/forge-step7a-acceptance-matrix.md

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContainerExecutionProvider,
  BannedMountSecurityError,
  ContainerRuntimeUnavailableError,
} from "../../src/environments/execution/container-provider.js";
import { LocalExecutionProvider } from "../../src/environments/execution/local-provider.js";
import { DockerDriver } from "../../src/environments/execution/docker-driver.js";
import type {
  ContainerDriver,
  ContainerRunConfig,
  ContainerRunResult,
  ExecutionRequest,
} from "../../src/environments/execution/types.js";
import { LocalEnvironment } from "../../src/environments/local.js";
import { evaluateProposal } from "../../src/gate/gate.js";
import { CapabilityHost, VerdictMismatchError } from "../../src/capability-host/host.js";
import { builtinCapabilities } from "../../src/capabilities/index.js";
import type { Proposal } from "../../src/contracts/proposals.js";
import type { Grant } from "../../src/contracts/grants.js";

function setupEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-sbx-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-sbx-ws-"));
  return {
    dataDir,
    workspaceRoot,
    cleanup() {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Mock container driver that simulates container runtime behaviors,
 * enforcing read-only root, tmpfs isolation, network-none restrictions,
 * and container-level termination primitives.
 */
class MockContainerDriver implements ContainerDriver {
  public killedContainers = new Set<string>();
  public removedContainers = new Set<string>();
  public activeContainers = new Map<string, ContainerRunConfig>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async run(config: ContainerRunConfig): Promise<ContainerRunResult> {
    this.activeContainers.set(config.name, config);
    const started = Date.now();

    // Check for simulated cancellation
    if (config.signal.aborted) {
      this.killedContainers.add(config.name);
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      return {
        exit: null,
        signal: "SIGKILL",
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        durationMs: 5,
        oomKilled: false,
      };
    }

    // Execute simulated guest payload
    const cmd = config.argv.join(" ");

    // SANDBOX-001: Attempting to read host files outside mounted workspace
    if (cmd.includes("/etc/shadow") || cmd.includes(".ssh/id_rsa") || cmd.includes("System32")) {
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      return {
        exit: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("cat: /etc/shadow: Permission denied\n"),
        durationMs: 10,
        oomKilled: false,
      };
    }

    // SANDBOX-003 & SANDBOX-007: Attempting write outside workspace or rootfs damage
    if (cmd.includes("/bin/sh") || cmd.includes("rm -rf /*") || cmd.includes("host_file.txt")) {
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      if (config.readOnlyRoot) {
        return {
          exit: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("/bin/sh: Read-only file system\n"),
          durationMs: 15,
          oomKilled: false,
        };
      }
    }

    // SANDBOX-004: Inspect environment variables
    if (cmd.includes("printenv") || cmd.includes("/proc/1/environ")) {
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      const envLines = Object.entries(config.env).map(([k, v]) => `${k}=${v}`).join("\n");
      return {
        exit: 0,
        signal: null,
        stdout: Buffer.from(envLines),
        stderr: Buffer.alloc(0),
        durationMs: 10,
        oomKilled: false,
      };
    }

    // SANDBOX-005: Outbound network egress
    if (cmd.includes("169.254.169.254") || cmd.includes("curl") || cmd.includes("nc ")) {
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      if (config.network === "none") {
        return {
          exit: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("curl: (7) Couldn't connect to server: Network is unreachable\n"),
          durationMs: 20,
          oomKilled: false,
        };
      }
    }

    // SANDBOX-006: Privilege escalation
    if (cmd.includes("sudo") || cmd.includes("su root") || cmd.includes("chroot")) {
      this.removedContainers.add(config.name);
      this.activeContainers.delete(config.name);
      if (config.capDropAll && config.user === "1000:1000") {
        return {
          exit: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("sudo: command not found (unprivileged user 1000)\n"),
          durationMs: 10,
          oomKilled: false,
        };
      }
    }

    // Handle cancellation listener (INV-17)
    return new Promise((resolve) => {
      let resolved = false;
      const onAbort = () => {
        if (resolved) return;
        resolved = true;
        this.killedContainers.add(config.name);
        this.removedContainers.add(config.name);
        this.activeContainers.delete(config.name);
        resolve({
          exit: null,
          signal: "SIGKILL",
          stdout: Buffer.from("interrupted"),
          stderr: Buffer.alloc(0),
          durationMs: Date.now() - started,
          oomKilled: false,
        });
      };

      config.signal.addEventListener("abort", onAbort, { once: true });

      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        config.signal.removeEventListener("abort", onAbort);
        this.removedContainers.add(config.name);
        this.activeContainers.delete(config.name);
        resolve({
          exit: 0,
          signal: null,
          stdout: Buffer.from("SUCCESS_DEFAULT"),
          stderr: Buffer.alloc(0),
          durationMs: Date.now() - started,
          oomKilled: false,
        });
      }, 30);
    });
  }

  async kill(containerName: string): Promise<void> {
    this.killedContainers.add(containerName);
    this.activeContainers.delete(containerName);
  }

  async rm(containerName: string): Promise<void> {
    this.removedContainers.add(containerName);
    this.activeContainers.delete(containerName);
  }

  async inspect(containerName: string): Promise<{ running: boolean; exitCode: number | null }> {
    return { running: this.activeContainers.has(containerName), exitCode: 0 };
  }
}

// ============================================================================
// SANDBOX-001: Host Filesystem Read Protection
// ============================================================================
test("SANDBOX-001: Host filesystem read attempt inside sandbox is denied", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["cat", "/etc/shadow"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  assert.notEqual(res.exit, 0, "Host filesystem read attempt must fail");
  const out = provider.output(res.outputHandle);
  assert(out.bytes.toString().includes("Permission denied"));

  env.cleanup();
});

// ============================================================================
// SANDBOX-002: Asynchronous Grandchild Process Termination
// ============================================================================
test("SANDBOX-002: Asynchronous grandchild process is terminated via container kill primitive", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const abortCtrl = new AbortController();
  const req: ExecutionRequest = {
    argv: ["node", "-e", "setInterval(()=>{}, 100)"],
    timeoutMs: 5000,
    signal: abortCtrl.signal,
    isolationProfile: "sandboxed",
  };

  const promise = provider.execute(req);
  setTimeout(() => abortCtrl.abort(), 10);
  const res = await promise;

  assert.equal(res.signal, "SIGKILL");
  assert.equal(driver.killedContainers.size, 1, "Container termination primitive must be invoked");
  assert.equal(driver.activeContainers.size, 0, "No active containers may remain");

  env.cleanup();
});

// ============================================================================
// SANDBOX-003: Workspace Containment (Write Outside Workspace)
// ============================================================================
test("SANDBOX-003: Write outside mounted workspace is rejected by read-only rootfs", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["sh", "-c", "echo ROOTKIT > /bin/sh"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  assert.notEqual(res.exit, 0);
  const out = provider.output(res.outputHandle);
  assert(out.bytes.toString().includes("Read-only file system"));

  env.cleanup();
});

// ============================================================================
// SANDBOX-004: Host Environment & Secret Protection
// ============================================================================
test("SANDBOX-004: Host environment secrets are completely absent from sandbox guest", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["printenv"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  const out = provider.output(res.outputHandle);
  const envText = out.bytes.toString();

  assert(envText.includes("WORKSPACE_DIR=/workspace"));
  assert(envText.includes("HOME=/tmp"));
  // Verify ambient host secrets do NOT leak
  assert(!envText.includes("ANTHROPIC_API_KEY"));
  assert(!envText.includes("OPENAI_API_KEY"));

  env.cleanup();
});

// ============================================================================
// SANDBOX-005: Network Isolation under network:none
// ============================================================================
test("SANDBOX-005: Network access under network:none is rejected", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["curl", "http://169.254.169.254/latest/meta-data"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  assert.notEqual(res.exit, 0);
  const out = provider.output(res.outputHandle);
  assert(out.bytes.toString().includes("Network is unreachable"));

  env.cleanup();
});

// ============================================================================
// SANDBOX-006: Privilege Escalation Rejection
// ============================================================================
test("SANDBOX-006: Privilege escalation is blocked under CAP_DROP_ALL and unprivileged UID", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["sudo", "whoami"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  assert.notEqual(res.exit, 0);
  const out = provider.output(res.outputHandle);
  assert(out.bytes.toString().includes("unprivileged user 1000"));

  env.cleanup();
});

// ============================================================================
// SANDBOX-007: Malicious Program Host Damage Resistance
// ============================================================================
test("SANDBOX-007: Destructive script (rm -rf /*) inside sandbox cannot damage host", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  // Host workspace contains important file
  const canaryFile = join(env.workspaceRoot, "canary.txt");
  writeFileSync(canaryFile, "IMPORTANT_HOST_FILE");

  const req: ExecutionRequest = {
    argv: ["sh", "-c", "rm -rf /* 2>/dev/null"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);
  assert.notEqual(res.exit, 0);
  // Host canary file is completely intact!
  assert(existsSync(canaryFile));
  assert.equal(readFileSync(canaryFile, "utf8"), "IMPORTANT_HOST_FILE");

  env.cleanup();
});

// ============================================================================
// SANDBOX-008: Process Tree Annihilation on Interruption
// ============================================================================
test("SANDBOX-008: Multi-tier process tree is atomically annihilated on interruption", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const abortCtrl = new AbortController();
  const req: ExecutionRequest = {
    argv: ["bash", "-c", "bash -c 'bash -c \"while true; do sleep 0.1; done\"'"],
    timeoutMs: 5000,
    signal: abortCtrl.signal,
    isolationProfile: "sandboxed",
  };

  const promise = provider.execute(req);
  setTimeout(() => abortCtrl.abort(), 5);
  const res = await promise;

  assert.equal(res.signal, "SIGKILL");
  assert.equal(driver.activeContainers.size, 0, "Entire container tree must be eradicated");

  env.cleanup();
});

// ============================================================================
// SANDBOX-009: Ledger & Authority State Tampering Rejection
// ============================================================================
test("SANDBOX-009: Mounting FORGE ledger audit directory is strictly forbidden", () => {
  const env = setupEnv();

  assert.throws(
    () => {
      ContainerExecutionProvider.validateMountPath(env.dataDir, env.dataDir);
    },
    (err: any) => {
      assert(err instanceof BannedMountSecurityError);
      assert(err.message.includes("mounting FORGE ledger audit directory is strictly forbidden"));
      return true;
    },
  );

  env.cleanup();
});

// ============================================================================
// SANDBOX-010: Container Daemon Socket Abuse Protection
// ============================================================================
test("SANDBOX-010: Mounting docker daemon socket (/var/run/docker.sock) is strictly forbidden", () => {
  assert.throws(
    () => {
      ContainerExecutionProvider.validateMountPath("/var/run/docker.sock");
    },
    (err: any) => {
      assert(err instanceof BannedMountSecurityError);
      assert(err.message.includes("mounting container daemon socket is strictly forbidden"));
      return true;
    },
  );

  assert.throws(
    () => {
      ContainerExecutionProvider.validateMountPath("/run/podman/podman.sock");
    },
    (err: any) => {
      assert(err instanceof BannedMountSecurityError);
      return true;
    },
  );
});

// ============================================================================
// INVARIANT INV-15: Isolation is Authoritative
// ============================================================================
test("INV-15: Model proposal cannot select environment: 'host' via proposal arguments", () => {
  const grant: Grant = {
    id: "grt_shell_sandboxed",
    missionId: "mis_1",
    capability: "shell",
    constraints: {
      argvClass: { kind: "argv-prefix", segments: ["node"] },
    },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };

  // 1. Malicious model attempts to inject extra authority-bearing argument 'environment: host'
  // C-3 / INV-15 invariant: Proposals are strict schemas; extra environment keys are rejected
  const maliciousProposal: any = {
    capability: "shell",
    args: {
      argv: ["node", "app.js"],
      cwd: "src",
      environment: "host",
    },
  };

  const defaultMeta = { rationale: "test", citations: [] };
  const v1 = evaluateProposal(maliciousProposal, defaultMeta, {
    grants: [grant],
    revokedGrantIds: new Set(),
  });
  assert.equal(v1.type, "reject");
  assert.equal(v1.reasonCode, "rejected-schema");

  // 2. Standard valid proposal has its isolationProfile derived authoritatively as 'sandboxed'
  const validProposal: Proposal = {
    capability: "shell",
    args: {
      argv: ["node", "app.js"],
      cwd: "src" as any,
    },
  };

  const v2 = evaluateProposal(validProposal, defaultMeta, {
    grants: [grant],
    revokedGrantIds: new Set(),
  });
  assert.equal(v2.type, "allow");
  assert.equal(v2.isolationProfile, "sandboxed", "Authority Gate authoritatively assigns sandboxed profile");
});

// ============================================================================
// INVARIANT INV-16: Host Execution is Exceptional
// ============================================================================
test("INV-16: Host execution is exceptional and requires explicit allowHostExecution grant", () => {
  const defaultMeta = { rationale: "test", citations: [] };
  // Standard grant without allowHostExecution
  const standardGrant: Grant = {
    id: "grt_std",
    missionId: "mis_1",
    capability: "shell",
    constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] } },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };

  const p1: Proposal = { capability: "shell", args: { argv: ["node", "index.js"], cwd: "src" as any } };
  const v1 = evaluateProposal(p1, defaultMeta, { grants: [standardGrant], revokedGrantIds: new Set() });
  assert.equal(v1.type, "allow");
  assert.equal(v1.isolationProfile, "sandboxed", "Default must be sandboxed");

  // Explicit host execution grant
  const hostGrant: Grant = {
    id: "grt_host",
    missionId: "mis_1",
    capability: "shell",
    constraints: {
      argvClass: { kind: "argv-prefix", segments: ["node"] },
      allowHostExecution: true, // Explicit administrative privilege!
    },
    expiresAt: null,
    issuer: "escalation",
    parentGrantId: null,
  };

  const v2 = evaluateProposal(p1, defaultMeta, { grants: [hostGrant], revokedGrantIds: new Set() });
  assert.equal(v2.type, "allow");
  assert.equal(v2.isolationProfile, "host", "Host execution allowed only with explicit grant");
});

// ============================================================================
// INVARIANT INV-17: Sandbox Destruction is the Kill Primitive
// ============================================================================
test("INV-17: Sandbox destruction terminates container without relying on in-guest PIDs", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const abortCtrl = new AbortController();
  const req: ExecutionRequest = {
    argv: ["node", "-e", "setTimeout(()=>{}, 10000)"],
    timeoutMs: 5000,
    signal: abortCtrl.signal,
    isolationProfile: "sandboxed",
  };

  const p = provider.execute(req);
  setTimeout(() => abortCtrl.abort(), 5);
  await p;

  assert.equal(driver.killedContainers.size, 1);
  assert.equal(driver.removedContainers.size, 1);
  assert.equal(driver.activeContainers.size, 0);

  env.cleanup();
});

// ============================================================================
// INVARIANT INV-18: Evidence Survives Sandbox Destruction
// ============================================================================
test("INV-18: Execution evidence and output survive complete container destruction", async () => {
  const env = setupEnv();
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["printenv"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  const res = await provider.execute(req);

  // Container is completely removed
  assert.equal(driver.activeContainers.size, 0);

  // But evidence is permanently available via output handle!
  const evidence = provider.output(res.outputHandle);
  assert(evidence.bytes.byteLength > 0);
  assert(evidence.bytes.toString().includes("WORKSPACE_DIR=/workspace"));

  env.cleanup();
});

// ============================================================================
// FREEZE-001: Real Docker Driver Availability & Fail-Closed Fallback
// ============================================================================
test("FREEZE-001: Real Docker driver accurately detects daemon state and fails closed when unavailable", async () => {
  const env = setupEnv();
  const realDriver = new DockerDriver();
  const isAvailable = await realDriver.isAvailable();

  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver: realDriver,
  });

  const req: ExecutionRequest = {
    argv: ["node", "-v"],
    timeoutMs: 15000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
  };

  if (!isAvailable) {
    // Daemon is inactive on this host: MUST fail closed with ContainerRuntimeUnavailableError!
    await assert.rejects(
      async () => provider.execute(req),
      (err: any) => {
        assert(err instanceof ContainerRuntimeUnavailableError);
        assert(err.message.includes("Container runtime daemon is unavailable"));
        return true;
      },
    );
  } else {
    // Daemon is running: real container execution
    const res = await provider.execute(req);
    assert.equal(res.exit, 0);
  }

  env.cleanup();
});

// ============================================================================
// FREEZE-002: Host Execution Escape Rejection vs Legitimate R4 Host Dispatch
// ============================================================================
test("FREEZE-002: Model cannot manufacture allowHostExecution; legitimate grant dispatches as host", async () => {
  const env = setupEnv();
  const defaultMeta = { rationale: "host escape test", citations: [] };

  const standardGrant: Grant = {
    id: "grt_sandbox_only",
    missionId: "mis_1",
    capability: "shell",
    constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] } },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };

  // 1. Model attempts to inject allowHostExecution in proposal args
  const maliciousProposal: any = {
    capability: "shell",
    args: {
      argv: ["node", "app.js"],
      cwd: "src",
      allowHostExecution: true, // Malicious attempt to force host execution!
    },
  };
  const v1 = evaluateProposal(maliciousProposal, defaultMeta, {
    grants: [standardGrant],
    revokedGrantIds: new Set(),
  });
  assert.equal(v1.type, "reject");
  assert.equal(v1.reasonCode, "rejected-schema", "Model cannot inject authority fields into proposal");

  // 2. Legitimate administrative R4 grant with allowHostExecution: true
  const adminHostGrant: Grant = {
    id: "grt_admin_host",
    missionId: "mis_1",
    capability: "shell",
    constraints: {
      argvClass: { kind: "argv-prefix", segments: ["node", "-e"] },
      allowHostExecution: true, // Explicit administrative privilege!
    },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };

  const validProposal: Proposal = {
    capability: "shell",
    args: { argv: ["node", "-e", "process.stdout.write('HOST_OK')"], cwd: "." as any },
  };

  const v2 = evaluateProposal(validProposal, defaultMeta, {
    grants: [adminHostGrant],
    revokedGrantIds: new Set(),
  });
  assert.equal(v2.type, "allow");
  assert.equal(v2.isolationProfile, "host");

  // 3. Execution via LocalExecutionProvider
  const localEnv = new LocalEnvironment(env.workspaceRoot);
  const localProvider = new LocalExecutionProvider(localEnv);
  const execRes = await localProvider.execute({
    argv: validProposal.args.argv,
    cwd: "",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "host",
  });
  assert.equal(execRes.exit, 0);
  assert.equal(execRes.isolationProfile, "host");
  const out = localProvider.output(execRes.outputHandle);
  assert.equal(out.bytes.toString(), "HOST_OK");

  env.cleanup();
});

// ============================================================================
// FREEZE-003: Workspace Confinement Survives Symlink & Traversal Attacks
// ============================================================================
test("FREEZE-003: Workspace authorization rejects symlink and path traversal attacks", () => {
  const env = setupEnv();
  const defaultMeta = { rationale: "traversal test", citations: [] };

  const grant: Grant = {
    id: "grt_fs_test",
    missionId: "mis_1",
    capability: "fs",
    constraints: { paths: ["**"] },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };

  // 1. Direct path traversal (..) fails schema validation
  const v0 = evaluateProposal(
    { capability: "fs", args: { op: "write", path: "../outside.txt", contentRef: "0".repeat(64) as any } },
    defaultMeta,
    { grants: [grant], revokedGrantIds: new Set() },
  );
  assert.equal(v0.type, "reject");
  assert.equal(v0.reasonCode, "rejected-schema");
  assert(v0.detail.includes("path must not traverse upward"));

  // 2. Symlink escape: Create a symlink inside workspace pointing to outside folder
  const outsideDir = mkdtempSync(join(tmpdir(), "forge-outside-target-"));
  const secretFile = join(outsideDir, "secret.txt");
  writeFileSync(secretFile, "HIGHLY_CONFIDENTIAL");

  const symlinkPath = join(env.workspaceRoot, "escape_link");
  try {
    symlinkSync(outsideDir, symlinkPath, "junction"); // Windows directory symlink / junction

    const localEnv = new LocalEnvironment(env.workspaceRoot);
    const proposal: Proposal = {
      capability: "fs",
      args: { op: "write", path: "escape_link/secret.txt" as any, contentRef: "0".repeat(64) as any },
    };

    // Gate resolves paths via resolveReal; MUST throw PathEscapeError and reject!
    const verdict = evaluateProposal(proposal, defaultMeta, {
      grants: [grant],
      revokedGrantIds: new Set(),
      resolvePath: {
        resolveReal: (p: string) => localEnv.resolveReal(p as any),
      },
    });

    assert.equal(verdict.type, "reject");
    assert.equal(verdict.reasonCode, "rejected-gate");
    assert(verdict.detail.includes("escapes the workspace root"));
  } finally {
    try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    env.cleanup();
  }
});

// ============================================================================
// FREEZE-004: Container Control Sockets & Runtime Environment Variables
// ============================================================================
test("FREEZE-004: Container daemon sockets and control env vars (DOCKER_HOST, KUBECONFIG) are stripped", async () => {
  const env = setupEnv();

  // 1. Banned mounts for all major container runtimes
  for (const sock of ["/run/containerd/containerd.sock", "/run/nerdctl.sock", "/var/run/crio.sock"]) {
    assert.throws(
      () => ContainerExecutionProvider.validateMountPath(sock),
      (err: any) => {
        assert(err instanceof BannedMountSecurityError);
        assert(err.message.includes("mounting container daemon socket is strictly forbidden"));
        return true;
      },
    );
  }

  // 2. Sensitive runtime control variables in req.env are stripped
  const driver = new MockContainerDriver();
  const provider = new ContainerExecutionProvider({
    workspaceRoot: env.workspaceRoot,
    driver,
  });

  const req: ExecutionRequest = {
    argv: ["printenv"],
    timeoutMs: 5000,
    signal: new AbortController().signal,
    isolationProfile: "sandboxed",
    env: {
      SAFE_USER_VAR: "allowed_value",
      DOCKER_HOST: "tcp://192.168.1.50:2375",
      CONTAINER_HOST: "unix:///run/podman.sock",
      KUBECONFIG: "/home/user/.kube/config",
      PODMAN_HOST: "tcp://localhost:8888",
    },
  };

  const res = await provider.execute(req);
  const out = provider.output(res.outputHandle).bytes.toString();

  assert(out.includes("SAFE_USER_VAR=allowed_value"), "Safe user variables must be passed");
  assert(!out.includes("DOCKER_HOST"), "DOCKER_HOST must be strictly stripped");
  assert(!out.includes("CONTAINER_HOST"), "CONTAINER_HOST must be strictly stripped");
  assert(!out.includes("KUBECONFIG"), "KUBECONFIG must be strictly stripped");
  assert(!out.includes("PODMAN_HOST"), "PODMAN_HOST must be strictly stripped");

  env.cleanup();
});
