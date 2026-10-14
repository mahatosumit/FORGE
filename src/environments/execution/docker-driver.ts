// FORGE Docker Container Driver (Step 7A: Containerized Sandboxing).
// Handles low-level interaction with Docker / Podman CLI and daemon.

import { execFile, spawn } from "node:child_process";
import type { ContainerDriver, ContainerRunConfig, ContainerRunResult } from "./types.js";
import { OUTPUT_MAX_BYTES } from "../local.js";

export class DockerDriver implements ContainerDriver {
  private runtimeCommand: "docker" | "podman" = "docker";

  constructor(runtime: "docker" | "podman" = "docker") {
    this.runtimeCommand = runtime;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = execFile(
        this.runtimeCommand,
        ["info", "--format", "{{.ServerVersion}}"],
        { timeout: 3000 },
        (err) => resolve(!err),
      );
      child.on("error", () => resolve(false));
    });
  }

  async run(config: ContainerRunConfig): Promise<ContainerRunResult> {
    const started = Date.now();
    const args: string[] = ["run", "--name", config.name];

    if (config.readOnlyRoot) args.push("--read-only");
    if (config.capDropAll) args.push("--cap-drop", "ALL");
    if (config.noNewPrivileges) args.push("--security-opt", "no-new-privileges:true");
    if (config.user) args.push("-u", config.user);
    if (config.pidsLimit > 0) args.push("--pids-limit", String(config.pidsLimit));
    if (config.memoryBytes > 0) {
      args.push("--memory", String(config.memoryBytes));
      args.push("--memory-swap", String(config.memoryBytes)); // Disable swap expansion
    }
    if (config.cpus > 0) args.push("--cpus", String(config.cpus));

    // Network isolation mode
    args.push("--network", config.network);

    // Ephemeral tmpfs mounts
    for (const [path, opts] of Object.entries(config.tmpfs)) {
      args.push("--tmpfs", `${path}:${opts}`);
    }

    // Controlled filesystem mounts
    for (const m of config.mounts) {
      args.push("-v", `${m.hostPath}:${m.containerPath}:${m.mode}`);
    }

    args.push("-w", config.workdir);

    for (const [k, v] of Object.entries(config.env)) {
      args.push("-e", `${k}=${v}`);
    }

    args.push(config.image);
    args.push(...config.argv);

    return new Promise((resolveP) => {
      let aborted = false;
      const child = execFile(
        this.runtimeCommand,
        args,
        {
          timeout: config.timeoutMs,
          maxBuffer: OUTPUT_MAX_BYTES,
        },
        async (err, so, se) => {
          let oomKilled = false;
          try {
            const insp = await this.inspect(config.name);
            // If container died due to OOM
            if (insp.exitCode === 137) oomKilled = true;
          } catch {}

          // Ensure container is cleaned up
          try {
            await this.rm(config.name);
          } catch {}

          const signal = aborted ? "SIGKILL" : (child.signalCode ?? null);
          const numericCode = (err as any)?.code;
          const exit = signal !== null ? null : !err ? (child.exitCode ?? 0) : typeof numericCode === "number" ? numericCode : 1;

          resolveP({
            exit,
            signal,
            stdout: Buffer.from(so ?? ""),
            stderr: Buffer.from(se ?? ""),
            durationMs: Date.now() - started,
            oomKilled,
          });
        },
      );

      // INV-17: Killing the container is the kill primitive
      config.signal.addEventListener(
        "abort",
        async () => {
          aborted = true;
          try {
            await this.kill(config.name);
            await this.rm(config.name);
          } catch {}
          try {
            child.kill("SIGKILL");
          } catch {}
        },
        { once: true },
      );
    });
  }

  async kill(containerName: string): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.runtimeCommand, ["kill", containerName], { timeout: 5000 }, () => resolve());
    });
  }

  async rm(containerName: string): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.runtimeCommand, ["rm", "-f", containerName], { timeout: 5000 }, () => resolve());
    });
  }

  async inspect(containerName: string): Promise<{ running: boolean; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      execFile(
        this.runtimeCommand,
        ["inspect", "--format", "{{.State.Running}},{{.State.ExitCode}}", containerName],
        { timeout: 3000 },
        (err, stdout) => {
          if (err) return reject(err);
          const parts = stdout.trim().split(",");
          resolve({
            running: parts[0] === "true",
            exitCode: parts[1] !== undefined ? parseInt(parts[1], 10) : null,
          });
        },
      );
    });
  }
}
