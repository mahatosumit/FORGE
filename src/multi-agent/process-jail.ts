// FORGE Process Jail & Isolation Driver (Step 8 Phase 2B.4: Process Isolation & 2B.7: Revocation/Kill)
// Provides process-group containment, physical isolation enforcement, and bounded process-tree termination.
// Remediates: Tightener 1 (Isolation Boundaries), Tightener 3 (Bounded Process Tree Termination).

import { normalize, resolve } from "node:path";
import type { PhysicalJailConfig } from "./jail-compiler.js";
import type { ContainerDriver } from "../environments/execution/types.js";
import { ProcessTreeDriver, type IsolatedCommandResult } from "../environments/execution/process-tree.js";

export class JailSecurityViolationError extends Error {
  constructor(public readonly violationType: string, message: string) {
    super(`JailSecurityViolationError [${violationType}]: ${message}`);
    this.name = "JailSecurityViolationError";
  }
}

export type JailExecutionResult = IsolatedCommandResult;

export class ProcessJail {
  constructor(
    private readonly config: PhysicalJailConfig,
    private readonly containerDriver?: ContainerDriver,
  ) {}

  /**
   * Asserts physical containment before executing any command or filesystem operation.
   * Proves: Physical capabilities available to child ⊆ EffectiveAuthorityEnvelope.
   */
  assertPathAccessAllowed(targetPath: string): void {
    const normTarget = normalize(resolve(this.config.childWorkspaceRoot, targetPath));
    const normRoot = normalize(resolve(this.config.childWorkspaceRoot));

    // Must be strictly inside child workspace root
    if (normTarget !== normRoot && !normTarget.startsWith(normRoot + "/") && !normTarget.startsWith(normRoot + "\\")) {
      throw new JailSecurityViolationError(
        "filesystem_boundary_escape",
        `Physical jail blocked path access: "${targetPath}" escapes child workspace root`,
      );
    }
  }

  /**
   * Asserts physical network policy compliance.
   */
  assertNetworkAllowed(host: string): void {
    if (this.config.networkPolicy.mode === "none") {
      throw new JailSecurityViolationError(
        "network_disabled",
        `Physical jail blocked network access to "${host}": network is disabled in authority envelope`,
      );
    }

    if (this.config.networkPolicy.mode === "allowlist") {
      const allowed = this.config.networkPolicy.allowedHosts ?? [];
      const isAllowed = allowed.some((h) => h === host || host.endsWith("." + h));
      if (!isAllowed) {
        throw new JailSecurityViolationError(
          "host_not_allowlisted",
          `Physical jail blocked network access to "${host}": host is not in authorized allowlist [${allowed.join(", ")}]`,
        );
      }
    }
  }

  /**
   * Asserts physical shell execution compliance.
   */
  assertShellAllowed(): void {
    if (!this.config.allowShell) {
      throw new JailSecurityViolationError(
        "shell_disabled",
        "Physical jail blocked shell execution: shell capability is ungranted in authority envelope",
      );
    }
  }

  /**
   * Executes a command within the isolated process jail.
   */
  async executeCommand(
    argv: string[],
    options: { cwd?: string; envOverrides?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<JailExecutionResult> {
    const executable = argv[0] ?? "";
    const isShellCommand =
      executable.includes("sh") ||
      executable.includes("bash") ||
      executable.includes("cmd") ||
      executable.includes("powershell");

    if (isShellCommand) {
      this.assertShellAllowed();
    }

    const effectiveCwd = options.cwd
      ? normalize(resolve(this.config.childWorkspaceRoot, options.cwd))
      : this.config.childWorkspaceRoot;

    this.assertPathAccessAllowed(effectiveCwd);

    const mergedEnv = {
      ...this.config.env,
      ...(options.envOverrides ?? {}),
      // Prevent parent sensitive env leakage
      FORGE_CHILD_MISSION_ID: this.config.childMissionId,
    };

    const timeout = options.timeoutMs ?? this.config.timeoutMs;

    return ProcessTreeDriver.executeIsolated(argv, {
      cwd: effectiveCwd,
      env: mergedEnv,
      timeoutMs: timeout,
    });
  }

  /**
   * Spawns an isolated command process within the jail.
   */
  spawnCommand(
    argv: string[],
    options: {
      cwd?: string;
      envOverrides?: Record<string, string>;
      stdio?: "pipe" | "ignore";
      unref?: boolean;
    } = {},
  ) {
    const executable = argv[0] ?? "";
    const isShellCommand =
      executable.includes("sh") ||
      executable.includes("bash") ||
      executable.includes("cmd") ||
      executable.includes("powershell");

    if (isShellCommand) {
      this.assertShellAllowed();
    }

    const effectiveCwd = options.cwd
      ? normalize(resolve(this.config.childWorkspaceRoot, options.cwd))
      : this.config.childWorkspaceRoot;

    this.assertPathAccessAllowed(effectiveCwd);

    const mergedEnv = {
      ...this.config.env,
      ...(options.envOverrides ?? {}),
      FORGE_CHILD_MISSION_ID: this.config.childMissionId,
    };

    return ProcessTreeDriver.spawnIsolated(argv, {
      cwd: effectiveCwd,
      env: mergedEnv,
      stdio: options.stdio,
      unref: options.unref,
    });
  }

  /**
   * Bounded Process-Tree Annihilation (Tightener 3).
   * Executes best-effort bounded process-tree termination across OS platforms.
   */
  static async killProcessTree(hostPid: number | null, containerName?: string | null): Promise<void> {
    return ProcessTreeDriver.killProcessTree(hostPid, containerName);
  }
}
