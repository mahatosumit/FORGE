// FORGE contracts — Capability Ecosystem & Governance (Step 6).
// Defines CapabilityManifestV2, CapabilityIdentity, DimensionalRiskVector,
// risk tiers, idempotency classes, and cryptographic identity verification.

import { z } from "zod";
import {
  CapabilityIdSchema,
  type CapabilityId,
} from "./grants.js";
import {
  Sha256HexSchema,
  type Sha256Hex,
} from "./base.js";
export { Sha256HexSchema, type Sha256Hex };
import { canonicalize } from "../codec/canonicalJson.js";
import { sha256Utf8 } from "../codec/hashChain.js";

export { CapabilityIdSchema, type CapabilityId };

export const CapabilityVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "capability version must be strict semver (x.y.z)");
export type CapabilityVersion = z.infer<typeof CapabilityVersionSchema>;

/** Cryptographic Capability Identity Quad (Phase 2). Immutable for registered version. */
export const CapabilityIdentitySchema = z
  .object({
    capabilityId: CapabilityIdSchema,
    version: CapabilityVersionSchema,
    manifestHash: Sha256HexSchema,
    implementationHash: Sha256HexSchema,
  })
  .strict();
export type CapabilityIdentity = z.infer<typeof CapabilityIdentitySchema>;

/** Coarse Autonomy Risk Tier: R0 through R4. */
export const CapabilityRiskTierSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export type CapabilityRiskTier = z.infer<typeof CapabilityRiskTierSchema>;

/** Execution Isolation Profile (Step 7A). Enforced authoritatively by Gate/Host. */
export const IsolationProfileSchema = z.enum(["sandboxed", "sandboxed-network", "host"]);
export type IsolationProfile = z.infer<typeof IsolationProfileSchema>;

/** Granular Dimensional Risk Vector for Gate constraint evaluation. */
export const DimensionalRiskVectorSchema = z
  .object({
    sideEffectScope: z.enum(["none", "workspace", "external-system", "process-lifecycle"]),
    networkScope: z.enum(["none", "loopback", "egress-read", "egress-write"]),
    resourceIntensity: z.enum(["negligible", "bounded", "heavy-subprocess", "long-running"]),
    dataSensitivity: z.enum(["public", "workspace-internal", "secret-bearer"]),
    injectionRisk: z.enum(["none", "trusted-schema", "untrusted-web", "untrusted-external-doc"]),
  })
  .strict();
export type DimensionalRiskVector = z.infer<typeof DimensionalRiskVectorSchema>;

/** Strict Idempotency Classification for recovery crash consistency. */
export const CapabilityIdempotencySchema = z.enum([
  "pure_read",
  "idempotent",
  "conditionally_idempotent",
  "non_idempotent",
  "unknown",
]);
export type CapabilityIdempotency = z.infer<typeof CapabilityIdempotencySchema>;

/** Side-effect category flags. */
export const CapabilitySideEffectClassSchema = z.enum([
  "none",
  "workspace_fs",
  "external_network",
  "process_spawn",
  "secret_access",
]);
export type CapabilitySideEffectClass = z.infer<typeof CapabilitySideEffectClassSchema>;

/** Lifecycle status in registry. */
export const CapabilityStatusSchema = z.enum(["active", "deprecated", "quarantined", "disabled"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityResourceLimitsSchema = z
  .object({
    maxOutputBytes: z.number().int().min(0).default(2 * 1024 * 1024),
    maxArtifactBytes: z.number().int().min(0).default(50 * 1024 * 1024),
    maxSubprocesses: z.number().int().min(0).default(1),
  })
  .strict();
export type CapabilityResourceLimits = z.infer<typeof CapabilityResourceLimitsSchema>;

export const CapabilityVerificationStrategySchema = z.enum([
  "exit_code",
  "file_state",
  "http_status",
  "artifact_ref",
  "none",
]);
export type CapabilityVerificationStrategy = z.infer<typeof CapabilityVerificationStrategySchema>;

/** Comprehensive Capability Manifest V2 (Phase 1). */
export const CapabilityManifestV2Schema = z
  .object({
    id: CapabilityIdSchema,
    version: CapabilityVersionSchema,
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024),
    proposalKind: z.string().min(1).max(64),
    riskTier: CapabilityRiskTierSchema,
    riskVector: DimensionalRiskVectorSchema,
    sideEffects: z.array(CapabilitySideEffectClassSchema).min(1),
    concurrency: z.enum(["parallel", "exclusive"]),
    constraintsVocab: z.array(z.string()),
    requiredGrants: z.array(CapabilityIdSchema).default([]),
    idempotency: CapabilityIdempotencySchema,
    timeoutMs: z.number().int().min(100).max(600000).default(30000),
    resourceLimits: CapabilityResourceLimitsSchema,
    verification: z
      .object({
        defaultStrategy: CapabilityVerificationStrategySchema,
        failureSignals: z.array(z.string()).default([]),
      })
      .strict(),
    provenance: z
      .object({
        pack: z.string().min(1).max(128),
        hash: Sha256HexSchema,
        signature: z.string().optional(),
      })
      .strict(),
    status: CapabilityStatusSchema.default("active"),
  })
  .strict();
export type CapabilityManifestV2 = z.infer<typeof CapabilityManifestV2Schema>;

/** Deterministically compute manifest hash by canonicalizing JSON representation. */
export function computeManifestHash(manifest: CapabilityManifestV2): Sha256Hex {
  const serializable = {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    proposalKind: manifest.proposalKind,
    riskTier: manifest.riskTier,
    riskVector: manifest.riskVector,
    sideEffects: manifest.sideEffects,
    concurrency: manifest.concurrency,
    constraintsVocab: manifest.constraintsVocab,
    requiredGrants: manifest.requiredGrants,
    idempotency: manifest.idempotency,
    timeoutMs: manifest.timeoutMs,
    resourceLimits: manifest.resourceLimits,
    verification: manifest.verification,
    provenance: manifest.provenance,
    status: manifest.status,
  };
  return sha256Utf8(canonicalize(serializable as Parameters<typeof canonicalize>[0])) as Sha256Hex;
}

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

/** Compute implementation hash strictly from immutable executable artifact bytes, on-disk file, or executable closure.
 * Self-reported implementationHash properties are strictly ignored and rejected. */
export function computeImplementationHash(implOrSource: unknown): Sha256Hex {
  if (implOrSource instanceof Uint8Array) {
    return createHash("sha256").update(implOrSource).digest("hex") as Sha256Hex;
  }
  if (typeof implOrSource === "string") {
    return createHash("sha256").update(implOrSource, "utf8").digest("hex") as Sha256Hex;
  }
  if (typeof implOrSource === "object" && implOrSource !== null) {
    // 1. Executable implementation with active run method: hash the executable method
    if ("run" in implOrSource && typeof (implOrSource as any).run === "function") {
      const fnStr = Function.prototype.toString.call((implOrSource as any).run);
      const hasher = createHash("sha256").update("EXECUTABLE_RUN:").update(fnStr, "utf8");
      if ("artifactBytes" in implOrSource && (implOrSource as any).artifactBytes instanceof Uint8Array) {
        hasher.update(":ARTIFACT:").update((implOrSource as any).artifactBytes);
      }
      return hasher.digest("hex") as Sha256Hex;
    }
    // 2. Direct executable artifact bytes
    if ("artifactBytes" in implOrSource && (implOrSource as any).artifactBytes instanceof Uint8Array) {
      return createHash("sha256").update((implOrSource as any).artifactBytes).digest("hex") as Sha256Hex;
    }
    // 3. On-disk immutable artifact file
    if ("artifactPath" in implOrSource && typeof (implOrSource as any).artifactPath === "string") {
      const p = (implOrSource as any).artifactPath;
      if (existsSync(p)) {
        const fileBytes = readFileSync(p);
        return createHash("sha256").update(fileBytes).digest("hex") as Sha256Hex;
      }
    }
    // 4. Immutable executable code string
    if ("code" in implOrSource && typeof (implOrSource as any).code === "string") {
      return createHash("sha256").update((implOrSource as any).code, "utf8").digest("hex") as Sha256Hex;
    }
  }
  if (typeof implOrSource === "function") {
    const fnStr = Function.prototype.toString.call(implOrSource);
    return createHash("sha256").update("EXECUTABLE_RUN:").update(fnStr, "utf8").digest("hex") as Sha256Hex;
  }
  throw new Error(
    "computeImplementationHash requires an executable artifact (artifactBytes, artifactPath, code, or run function). Self-reported implementationHash property is rejected as untrusted.",
  );
}
