// FORGE capability host — shared types for capability implementations.

import type { CapabilityManifest } from "../contracts/grants.js";
import type { CriterionExpr } from "../contracts/records.js";
export type { CapabilityManifest };
import type { Proposal, RecordKind } from "../contracts/index.js";
import type { Environment } from "../contracts/env.js";
import type { SecretName } from "../contracts/base.js";


import type { CapabilityIdentity, CapabilityManifestV2, IsolationProfile } from "../contracts/capabilities.js";
import type { ExecutionProvider } from "../environments/execution/types.js";

export interface DispatchContext {
  /** The mission's workspace-relative root for operations. */
  workspaceRoot: string;
  /** The selected environment (local | container). */
  environment: Environment;
  environmentKind: "local" | "container";
  /** Authoritative isolation profile assigned by Gate verdict (Step 7A). */
  isolationProfile?: IsolationProfile;
  /** Active execution provider for running tasks. */
  executionProvider?: ExecutionProvider;
  /** Secrets resolved at dispatch time by name — never model-visible. */
  secrets: ReadonlyMap<SecretName, string>;
  /** Persist bytes into the mission's artifact store; returns the sha256 ref. */
  capture(bytes: Uint8Array): string;
  /** Fetch a previously ingested blob (model content events) by sha256. */
  artifactBytes(sha256hex: string): Uint8Array | null;
  /** Per-hop URL authority for the http capability (F-01): bound by the
   *  engine to the dispatching grant's host scope. Returns true if the URL's
   *  host is within the granted scope. */
  urlAuthority: (url: string) => boolean;
  /** Mission-specific resolution: verify criteria by id. */
  criterionResolver: (criterionId: string) => CriterionExpr | null;
  signal: AbortSignal;
  /** Optional pinned capability identity for tamper detection. */
  pinnedIdentity?: CapabilityIdentity;
  /** Optional active grant checker for revocation windows. */
  isGrantActive?: (grantId: string) => boolean;
  /** Mission ID executing this dispatch. */
  missionId?: string;
  /** Task ID executing this dispatch. */
  taskId?: string;
}

export interface CapabilityRunResult {
  /** The runtime-authored observation record kind + body. */
  observationKind: RecordKind;
  observation: unknown;
}

export interface CapabilityImpl {
  manifest: CapabilityManifest;
  manifestV2?: CapabilityManifestV2;
  run(
    proposal: Proposal,
    ctx: DispatchContext,
    opts: { timeoutMs: number; signal: AbortSignal; isolationProfile: string },
  ): Promise<CapabilityRunResult>;
}

