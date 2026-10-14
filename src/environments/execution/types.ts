// FORGE Execution Provider Layer (Step 7A: Execution Isolation & Sandboxing).
// Defines ExecutionProvider, ExecutionRequest, ExecutionResult, and ContainerDriver.

import type { IsolationProfile } from "../../contracts/capabilities.js";
import type { SecretName, WorkspacePath } from "../../contracts/base.js";

export interface ResourceLimits {
  cpus?: number;
  memoryBytes?: number;
  pidsLimit?: number;
}

export interface NetworkPolicy {
  mode: "none" | "proxy" | "allowlist";
  allowedHosts?: string[];
}

export interface ExecutionRequest {
  argv: string[];
  cwd?: string;
  env?: ReadonlyMap<SecretName, string> | Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal: AbortSignal;
  isolationProfile: IsolationProfile;
  resourceLimits?: ResourceLimits;
  networkPolicy?: NetworkPolicy;
}

export interface ExecutionResult {
  exit: number | null;
  signal: string | null;
  outputHandle: string;
  durationMs: number;
  truncated: boolean;
  oomKilled: boolean;
  isolationProfile: IsolationProfile;
}

export interface ExecutionProvider {
  readonly profile: IsolationProfile;
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
  output(handle: string): { bytes: Buffer; truncated: boolean };
}

/**
 * Driver abstraction for interacting with container runtimes (Docker, Podman, OCI).
 * Allows test drivers to simulate container daemon events or execute in lightweight test sandboxes.
 */
export interface ContainerDriver {
  isAvailable(): Promise<boolean>;
  run(config: ContainerRunConfig): Promise<ContainerRunResult>;
  kill(containerName: string): Promise<void>;
  rm(containerName: string): Promise<void>;
  inspect(containerName: string): Promise<{ running: boolean; exitCode: number | null }>;
}

export interface ContainerRunConfig {
  name: string;
  image: string;
  argv: string[];
  readOnlyRoot: boolean;
  tmpfs: Record<string, string>; // mountPath -> options (e.g. "/tmp" -> "size=128m,noexec,nosuid")
  mounts: Array<{ hostPath: string; containerPath: string; mode: "ro" | "rw" }>;
  network: "none" | "host" | "bridge";
  capDropAll: boolean;
  noNewPrivileges: boolean;
  user: string;
  pidsLimit: number;
  memoryBytes: number;
  cpus: number;
  workdir: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ContainerRunResult {
  exit: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  durationMs: number;
  oomKilled: boolean;
}
