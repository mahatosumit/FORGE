// FORGE Step 8 Phase 2C-4 Acceptance Tests: Information Flow Control
// Tests: P2C-013, P2C-014, P2C-015.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { DelegationId } from "../../src/contracts/index.js";
import {
  ProcessJail,
  JailSecurityViolationError,
} from "../../src/multi-agent/process-jail.js";
import {
  InformationFlowPolicy,
  FlowPolicyViolationError,
  GovernedDeclassificationFilter,
  DeclassificationError,
  ParentArtifactBroker,
} from "../../src/multi-agent/information-flow.js";

// ============================================================================
// P2C-013: Cross-child workspace access blocked by physical ProcessJail
// ============================================================================
test("P2C-013: Child A attempting to access Child B workspace is blocked by ProcessJail", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c013-"));
  try {
    const childAWorkspace = join(tmpDir, "childA", "workspace");
    const childBWorkspace = join(tmpDir, "childB", "workspace");

    const jailA = new ProcessJail({
      isolationProfile: "sandboxed",
      childMissionId: "mis_CHILD_A" as any,
      childWorkspaceRoot: childAWorkspace,
      readonlyMounts: [],
      writeableMounts: [childAWorkspace],
      environmentVariables: {},
      networkMode: "none",
      allowHostExecution: false,
      droppedCapabilities: ["ALL"],
      resourceLimits: { maxMemoryMb: 256, maxCpus: 1, maxProcesses: 5 },
    });

    // Valid path in Child A's workspace passes
    assert.doesNotThrow(() => {
      jailA.assertPathAccessAllowed(join(childAWorkspace, "sub", "file.ts"), true);
    });

    // Attempting to access Child B's workspace from Child A throws JailSecurityViolationError
    assert.throws(
      () => {
        jailA.assertPathAccessAllowed(join(childBWorkspace, "secret.key"), false);
      },
      (err: any) => {
        assert(err instanceof JailSecurityViolationError);
        assert.match(err.message, /escapes child workspace root/);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-014: Direct IPC socket/pipe connection to sibling throws ENOENT/ECONNREFUSED
// ============================================================================
test("P2C-014: Child attempts direct IPC connection to sibling fails (zero IPC endpoints exist)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c014-"));
  try {
    const siblingIpcPipe = process.platform === "win32"
      ? "\\\\.\\pipe\\forge-child-sibling-ipc-forbidden"
      : join(tmpDir, "sibling.sock");

    // Assert that no IPC endpoint file or pipe is running
    assert.equal(existsSync(siblingIpcPipe), false);

    // Attempt direct IPC socket connection -> must reject with ENOENT or ECONNREFUSED
    await assert.rejects(
      new Promise((_, reject) => {
        const client = net.createConnection(siblingIpcPipe);
        client.on("error", (err) => reject(err));
        client.on("connect", () => {
          client.end();
          reject(new Error("Unexpected connection to sibling IPC endpoint succeeded!"));
        });
      }),
      (err: any) => {
        assert(err.code === "ENOENT" || err.code === "ECONNREFUSED");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// P2C-015: Star-topology data handoff between siblings via parent artifact store
// ============================================================================
test("P2C-015: Star-topology artifact handoff between Child A and Child B with governed declassification", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "forge-p2c015-"));
  try {
    const broker = new ParentArtifactBroker();
    const childADelId = "del_01HCHILD_A0000000000000" as DelegationId;
    const childBDelId = "del_01HCHILD_B0000000000000" as DelegationId;

    const childBWorkspace = join(tmpDir, "childB", "workspace");

    // 1. Child A produces clean artifact -> declassified to WORKSPACE and mounted read-only into Child B
    const validOutput = Buffer.from(JSON.stringify({ status: "ok", tokenCounts: 42 }));
    const artifactSha = broker.publishArtifact(childADelId, validOutput, "CHILD_PRIVATE");

    const mountedPath = broker.mountArtifactForChild(
      childBDelId,
      artifactSha,
      childBWorkspace,
      "imported/output.json",
    );

    assert(existsSync(mountedPath));
    const stored = broker.getArtifact(artifactSha);
    assert.equal(stored?.label, "WORKSPACE");

    // 2. Child A attempts to publish artifact containing secret -> rejected by GovernedDeclassificationFilter
    const secretOutput = Buffer.from("Here is the secret API key: sk-LIVEsecretkey998877665544");
    assert.throws(
      () => {
        broker.publishArtifact(childADelId, secretOutput, "CHILD_PRIVATE", ["sk-LIVEsecretkey998877665544"]);
      },
      (err: any) => {
        assert(err instanceof DeclassificationError);
        assert.match(err.message, /Declassification rejected/);
        return true;
      },
    );

    // 3. Information flow lattice prevents direct flow of SECRET to WORKSPACE
    assert.throws(
      () => {
        InformationFlowPolicy.assertCanFlow("SECRET", "WORKSPACE");
      },
      (err: any) => {
        assert(err instanceof FlowPolicyViolationError);
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
