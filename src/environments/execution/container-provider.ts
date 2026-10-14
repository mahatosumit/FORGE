// FORGE Container Execution Provider (Step 7A: Execution Isolation).
// Enforces containerized sandboxing, banned mount restrictions, ephemeral tmpfs,
// cgroup resource limits, non-root user execution, and container-level termination.

import { randomBytes, createHash } from "node:crypto";
import { resolve, normalize } from "node:path";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  ContainerDriver,
  ContainerRunConfig,
} from "./types.js";
import type { IsolationProfile } from "../../contracts/capabilities.js";
import { OUTPUT_MAX_BYTES } from "../local.js";

export class ContainerRuntimeUnavailableError extends Error {
  constructor(message = "Container runtime daemon is unavailable and host fallback is not authorized") {
    super(message);
    this.name = "ContainerRuntimeUnavailableError";
  }
}

export class BannedMountSecurityError extends Error {
  constructor(path: string, reason: string) {
    super(`Security policy rejected container mount of "${path}": ${reason}`);
    this.name = "BannedMountSecurityError";
  }
}

export interface ContainerExecutionProviderOptions {
  workspaceRoot: string;
  driver: ContainerDriver;
  image?: string;
  defaultProfile?: "sandboxed" | "sandboxed-network";
  ledgerPathsDir?: string; // Protected ledger dir that must never be mounted
  allowHostFallback?: boolean;
}

export class ContainerExecutionProvider implements ExecutionProvider {
  readonly profile: IsolationProfile;
  private outputs = new Map<string, { bytes: Buffer; truncated: boolean }>();
  private seq = 0;

  constructor(private readonly opts: ContainerExecutionProviderOptions) {
    this.profile = opts.defaultProfile ?? "sandboxed";
  }

  /**
   * Validates that a requested host mount path is safe and does not expose
   * docker sockets, host root, or ledger journals.
   */
  static validateMountPath(hostPath: string, ledgerDir?: string): void {
    const norm = normalize(resolve(hostPath)).toLowerCase();

    // Banned container daemon sockets (SANDBOX-010 & Requirement 4)
    const bannedSockets = [
      "docker.sock",
      "podman.sock",
      "containerd.sock",
      "nerdctl.sock",
      "crio.sock",
      "dockershim.sock",
    ];
    if (bannedSockets.some((s) => norm.includes(s))) {
      throw new BannedMountSecurityError(hostPath, "mounting container daemon socket is strictly forbidden");
    }

    // Banned host system roots
    if (norm === "/" || norm === "c:\\" || norm === "c:/" || norm === "\\") {
      throw new BannedMountSecurityError(hostPath, "mounting host root directory is strictly forbidden");
    }

    // Banned ledger directory (SANDBOX-009)
    if (ledgerDir) {
      const normLedger = normalize(resolve(ledgerDir)).toLowerCase();
      if (norm === normLedger || norm.startsWith(normLedger + "/") || norm.startsWith(normLedger + "\\")) {
        throw new BannedMountSecurityError(hostPath, "mounting FORGE ledger audit directory is strictly forbidden");
      }
    }
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    if (req.isolationProfile === "host") {
      throw new Error(`ContainerExecutionProvider cannot execute with profile "host"`);
    }

    // Verify container driver is available
    const available = await this.opts.driver.isAvailable();
    if (!available) {
      throw new ContainerRuntimeUnavailableError();
    }

    // Verify workspace mount safety
    ContainerExecutionProvider.validateMountPath(this.opts.workspaceRoot, this.opts.ledgerPathsDir);

    const containerName = `forge-sbx-${randomBytes(8).toString("hex")}`;
    const image = this.opts.image ?? "node:22-bookworm-slim";

    const envObj: Record<string, string> = {
      WORKSPACE_DIR: "/workspace",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp",
    };

    // Requirement 4: The sandbox must not contain credentials or control surfaces
    // capable of controlling its own sandbox runtime.
    const BANNED_RUNTIME_ENV = new Set([
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
      "CONTAINER_HOST",
      "CONTAINER_SSHKEY",
      "KUBECONFIG",
      "PODMAN_HOST",
    ]);

    if (req.env) {
      if (req.env instanceof Map) {
        for (const [k, v] of req.env.entries()) {
          const keyStr = String(k);
          if (!BANNED_RUNTIME_ENV.has(keyStr.toUpperCase())) {
            envObj[keyStr] = v;
          }
        }
      } else {
        for (const [k, v] of Object.entries(req.env)) {
          if (!BANNED_RUNTIME_ENV.has(k.toUpperCase())) {
            envObj[k] = v;
          }
        }
      }
    }

    const networkMode =
      req.isolationProfile === "sandboxed-network" && req.networkPolicy?.mode !== "none"
        ? "bridge"
        : "none";

    const config: ContainerRunConfig = {
      name: containerName,
      image,
      argv: req.argv,
      readOnlyRoot: true,
      tmpfs: {
        "/tmp": "size=128m,noexec,nosuid",
      },
      mounts: [
        {
          hostPath: resolve(this.opts.workspaceRoot),
          containerPath: "/workspace",
          mode: "rw",
        },
      ],
      network: networkMode,
      capDropAll: true,
      noNewPrivileges: true,
      user: "1000:1000",
      pidsLimit: req.resourceLimits?.pidsLimit ?? 64,
      memoryBytes: req.resourceLimits?.memoryBytes ?? 512 * 1024 * 1024,
      cpus: req.resourceLimits?.cpus ?? 1.0,
      workdir: req.cwd ? `/workspace/${req.cwd.replace(/^\//, "")}` : "/workspace",
      env: envObj,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
    };

    const runResult = await this.opts.driver.run(config);

    // Bounded evidence capture (INV-18: Evidence survives container destruction)
    const combined = Buffer.concat([runResult.stdout, runResult.stderr]);
    const isTruncated = combined.byteLength > (req.maxOutputBytes ?? OUTPUT_MAX_BYTES);
    const boundedBytes = combined.subarray(0, req.maxOutputBytes ?? OUTPUT_MAX_BYTES);

    const hash = createHash("sha256").update(boundedBytes).digest("hex");
    const outputHandle = `${hash}-${this.seq++}`;
    this.outputs.set(outputHandle, { bytes: boundedBytes, truncated: isTruncated });

    return {
      exit: runResult.exit,
      signal: runResult.signal,
      outputHandle,
      durationMs: runResult.durationMs,
      truncated: isTruncated,
      oomKilled: runResult.oomKilled,
      isolationProfile: req.isolationProfile,
    };
  }

  output(handle: string): { bytes: Buffer; truncated: boolean } {
    const out = this.outputs.get(handle);
    if (!out) throw new Error(`unknown output handle "${handle}"`);
    return out;
  }
}
