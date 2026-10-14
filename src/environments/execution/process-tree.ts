// FORGE Process Tree & Execution Driver (Step 8 Phase 2B & Step 7A)
// Effect seam confinement: all node:child_process usage is restricted to src/environments/**.

import { execFile, spawn } from "node:child_process";
import { killTreePosix } from "../local.js";

export interface IsolatedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export class ProcessTreeDriver {
  /**
   * Executes a command with timeout, controlled cwd, and environment.
   */
  static executeIsolated(
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      maxBuffer?: number;
    },
  ): Promise<IsolatedCommandResult> {
    const started = Date.now();
    return new Promise((resolveP) => {
      const child = execFile(
        argv[0]!,
        argv.slice(1),
        {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
          maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const exitCode = child.exitCode ?? (err ? 1 : 0);
          resolveP({
            exitCode,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            durationMs,
          });
        },
      );
    });
  }

  /**
   * Spawns an isolated long-running process with controlled cwd and environment.
   */
  static spawnIsolated(
    argv: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      stdio?: "pipe" | "ignore";
      unref?: boolean;
    },
  ) {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "ignore",
    });
    if (options.unref) {
      child.unref();
    }
    return child;
  }

  /**
   * Bounded Process-Tree Termination (Tightener 3).
   * Executes best-effort bounded process-tree termination across OS platforms.
   */
  static async killProcessTree(hostPid: number | null, containerName?: string | null): Promise<void> {
    if (hostPid && hostPid > 0) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          execFile("taskkill", ["/PID", String(hostPid), "/T", "/F"], { timeout: 3000 }, () => resolve());
        });
      } else {
        // GATE B fix: same whole-tree strategy as the exec abort path —
        // group leadership is not assumed; descendants are killed explicitly.
        killTreePosix(hostPid);
      }
    }

    if (containerName) {
      await new Promise<void>((resolve) => {
        execFile("docker", ["kill", containerName], { timeout: 3000 }, () => resolve());
      });
    }
  }
}
