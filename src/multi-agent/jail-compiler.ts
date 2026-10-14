// FORGE Authority-to-Jail Compiler (Step 8 Phase 2B: Execution Isolation)
// Compiles EffectiveAuthorityEnvelope into physical execution jail parameters.
// Core Invariant: Physical Capabilities Available in Jail ⊆ EffectiveAuthorityEnvelope.
// Remediates: Tightener 1 (CAP_DROP_ALL + Docker Socket / Namespace / Mount Isolation),
//             Tightener 3 (Authority Gate as Primary Security Boundary).

import { normalize, resolve } from "node:path";
import type { EffectiveAuthorityEnvelope } from "../contracts/delegation.js";
import type { ContainerRunConfig, NetworkPolicy, ResourceLimits } from "../environments/execution/types.js";

export class BannedMountSecurityError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`Security policy rejected jail mount of "${path}": ${reason}`);
    this.name = "BannedMountSecurityError";
  }
}

export class AuthorityJailViolationError extends Error {
  constructor(public readonly dimension: string, message: string) {
    super(`Authority-to-Jail Equivalence Violation [${dimension}]: ${message}`);
    this.name = "AuthorityJailViolationError";
  }
}

export interface PhysicalJailConfig {
  childMissionId: string;
  childWorkspaceRoot: string;
  readOnlyRoot: boolean;
  networkPolicy: NetworkPolicy;
  mounts: Array<{ hostPath: string; containerPath: string; mode: "ro" | "rw" }>;
  tmpfs: Record<string, string>;
  allowShell: boolean;
  capDropAll: boolean;
  noNewPrivileges: boolean;
  user: string;
  env: Record<string, string>;
  resourceLimits: ResourceLimits;
  timeoutMs: number;
}

export class AuthorityJailCompiler {
  /** Banned daemon sockets and control endpoints */
  private static readonly BANNED_SOCKETS = [
    "docker.sock",
    "podman.sock",
    "containerd.sock",
    "nerdctl.sock",
    "crio.sock",
    "dockershim.sock",
    "api.sock",
  ];

  /**
   * Compiles an EffectiveAuthorityEnvelope into a strict PhysicalJailConfig.
   * Enforces:
   * 1. Physical capabilities ⊆ EffectiveAuthorityEnvelope.
   * 2. No access to parent mission directory or sibling child directories.
   * 3. No container socket exposure (/var/run/docker.sock).
   * 4. No host root filesystem exposure.
   * 5. No parent credential leakage.
   * 6. Network isolation: 'none' unless explicitly authorized.
   */
  static compile(
    envelope: EffectiveAuthorityEnvelope,
    childMissionId: string,
    childWorkspaceRoot: string,
    options: {
      parentMissionDir?: string;
      siblingMissionDirs?: string[];
      parentCredentials?: Record<string, string>;
      availableSecrets?: Record<string, string>;
    } = {},
  ): PhysicalJailConfig {
    const normChildWorkspace = normalize(resolve(childWorkspaceRoot));

    // 1. Verify Child Workspace Mount Safety
    AuthorityJailCompiler.validateMountPath(
      normChildWorkspace,
      options.parentMissionDir,
      options.siblingMissionDirs,
    );

    // 2. Compile Filesystem Mounts
    const mode = envelope.riskCeiling === "read" ? "ro" : "rw";
    const mounts: Array<{ hostPath: string; containerPath: string; mode: "ro" | "rw" }> = [
      {
        hostPath: normChildWorkspace,
        containerPath: "/workspace",
        mode,
      },
    ];

    // If explicit paths are specified in constraints, ensure they are strictly inside childWorkspace
    if (envelope.constraints.paths && envelope.constraints.paths.length > 0) {
      for (const p of envelope.constraints.paths) {
        const fullP = normalize(resolve(normChildWorkspace, p));
        if (!fullP.startsWith(normChildWorkspace)) {
          throw new AuthorityJailViolationError(
            "filesystem",
            `Constraint path "${p}" attempts to escape child workspace root`,
          );
        }
      }
    }

    // 3. Compile Network Policy (Authority-to-Jail Equivalence)
    const hasNetworkCap =
      envelope.capabilities.includes("http" as any) ||
      envelope.capabilities.includes("web_fetch" as any) ||
      envelope.capabilities.includes("web_search" as any);

    let networkPolicy: NetworkPolicy;
    if (!hasNetworkCap || envelope.isolationProfile === "sandboxed") {
      // Physical network disabled
      networkPolicy = { mode: "none" };
    } else {
      const allowedHosts = envelope.constraints.hosts ?? [];
      networkPolicy = {
        mode: allowedHosts.length > 0 ? "allowlist" : "none",
        allowedHosts: [...allowedHosts],
      };
    }

    // 4. Compile Shell Execution Privilege
    const allowShell = envelope.capabilities.includes("shell" as any);

    // 5. Scrub Environment & Sanitize Secrets
    // PARENT CREDENTIALS ARE NEVER INHERITED.
    // Only secrets explicitly listed in envelope.constraints.secretNames are injected.
    const scrubbedEnv: Record<string, string> = {};
    if (envelope.constraints.secretNames && options.availableSecrets) {
      for (const secretName of envelope.constraints.secretNames) {
        if (options.availableSecrets[secretName]) {
          scrubbedEnv[secretName] = options.availableSecrets[secretName];
        }
      }
    }

    // 6. Resource Limits derived from Budget Escrow
    const budget = envelope.budgetEscrow;
    const resourceLimits: ResourceLimits = {
      pidsLimit: Math.max(4, (budget.maxConcurrentTasks + budget.maxSubprocesses) * 2),
      memoryBytes: Math.min(budget.maxArtifactBytes * 4, 1024 * 1024 * 1024), // Max 1GB or 4x artifact
      cpus: 1.0,
    };

    return {
      childMissionId,
      childWorkspaceRoot: normChildWorkspace,
      readOnlyRoot: true,
      networkPolicy,
      mounts,
      tmpfs: {
        "/tmp": "size=64m,noexec,nosuid",
        "/run": "size=16m,noexec,nosuid",
      },
      allowShell,
      capDropAll: true,
      noNewPrivileges: true,
      user: "1000:1000",
      env: scrubbedEnv,
      resourceLimits,
      timeoutMs: budget.maxExecutionTimeMs,
    };
  }

  /**
   * Translates PhysicalJailConfig into Docker / OCI ContainerRunConfig.
   */
  static toContainerRunConfig(jail: PhysicalJailConfig, containerName: string, argv: string[]): ContainerRunConfig {
    const networkMode = jail.networkPolicy.mode === "none" ? "none" : "bridge";

    return {
      name: containerName,
      image: "node:22-bookworm-slim",
      argv,
      readOnlyRoot: jail.readOnlyRoot,
      tmpfs: jail.tmpfs,
      mounts: jail.mounts,
      network: networkMode,
      capDropAll: jail.capDropAll,
      noNewPrivileges: jail.noNewPrivileges,
      user: jail.user,
      pidsLimit: jail.resourceLimits.pidsLimit ?? 16,
      memoryBytes: jail.resourceLimits.memoryBytes ?? 512 * 1024 * 1024,
      cpus: jail.resourceLimits.cpus ?? 1.0,
      workdir: "/workspace",
      env: jail.env,
      timeoutMs: jail.timeoutMs,
      signal: new AbortController().signal,
    };
  }

  /**
   * Asserts that a mount path is safe against container escapes, socket exposure,
   * host root mount, parent mission mount, and sibling mission mounts.
   */
  static validateMountPath(
    hostPath: string,
    parentMissionDir?: string,
    siblingMissionDirs: string[] = [],
  ): void {
    const norm = normalize(resolve(hostPath)).toLowerCase();

    // 1. Container Daemon Sockets (Tightener 1)
    if (AuthorityJailCompiler.BANNED_SOCKETS.some((sock) => norm.includes(sock))) {
      throw new BannedMountSecurityError(hostPath, "mounting container daemon socket is strictly forbidden");
    }

    // 2. Host System Roots
    if (norm === "/" || norm === "\\" || /^[a-z]:[\\/]?$/i.test(norm)) {
      throw new BannedMountSecurityError(hostPath, "mounting host root directory is strictly forbidden");
    }

    // 3. Parent Mission Directory (Tightener 1: parent journal / mission isolation)
    if (parentMissionDir) {
      const normParent = normalize(resolve(parentMissionDir)).toLowerCase();
      if (norm === normParent || norm.startsWith(normParent + "/") || norm.startsWith(normParent + "\\")) {
        throw new BannedMountSecurityError(
          hostPath,
          "mounting parent mission or ledger directory is strictly forbidden",
        );
      }
    }

    // 4. Sibling Mission Directories (Tightener 1: sibling isolation)
    for (const sib of siblingMissionDirs) {
      const normSib = normalize(resolve(sib)).toLowerCase();
      if (norm === normSib || norm.startsWith(normSib + "/") || norm.startsWith(normSib + "\\")) {
        throw new BannedMountSecurityError(
          hostPath,
          "mounting sibling child mission workspace is strictly forbidden",
        );
      }
    }
  }
}
