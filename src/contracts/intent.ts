// FORGE Intent Model Contracts (Step 8 Phase 2C.1)
// Machine-checkable schemas for IntentEnvelope, Canonical IntentHash,
// MachineCriterion state machines, and untrusted observation containment.

import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalize, type JsonLike } from "../codec/canonicalJson.js";
import {
  MissionIdSchema,
  CriterionIdSchema,
  Sha256HexSchema,
  type MissionId,
  type CriterionId,
  type Sha256Hex,
} from "./base.js";
import { RiskClassSchema } from "./grants.js";

// ---------------------------------------------------------------------------
// 1. Completion Verifier & Intent Envelope Schemas
// ---------------------------------------------------------------------------

export const CompletionVerifierTypeSchema = z.enum([
  "command",
  "test_suite",
  "file_hash",
  "schema",
  "regex",
  "test_exit_code",
  "schema_validation",
  "sha256_match",
  "ast_query",
]);
export type CompletionVerifierType = z.infer<typeof CompletionVerifierTypeSchema>;

export const CompletionVerifierSchema = z
  .object({
    type: CompletionVerifierTypeSchema,
    target: z.string().min(1).max(512).optional(),
    harnessPath: z.string().min(1).max(512).optional(),
    expectedOutputHash: Sha256HexSchema.optional(),
    expectedExitCode: z.number().int().min(0).max(255).optional(),
    expectedHash: Sha256HexSchema.optional(),
    schema: z.string().max(4096).optional(),
  })
  .strict();
export type CompletionVerifier = z.infer<typeof CompletionVerifierSchema>;

export const SuccessCriterionSpecSchema = z
  .object({
    criterionId: CriterionIdSchema,
    description: z.string().min(1).max(2000),
    completionVerifier: CompletionVerifierSchema,
  })
  .strict();
export type SuccessCriterionSpec = z.infer<typeof SuccessCriterionSpecSchema>;

export const IntentConstraintsSchema = z
  .object({
    riskCeiling: RiskClassSchema.default("read"),
    allowedOutputClasses: z.array(z.string()).default(["workspace", "artifacts"]),
    bannedPatterns: z.array(z.string()).default([]),
    maxTotalWallClockMs: z.number().int().min(1000).max(3600_000).default(3600_000),
    maxTotalTokens: z.number().int().min(1000).max(10_000_000).default(2_000_000),
    dataPolicy: z.enum(["isolated", "airgapped", "restricted_egress"]).default("isolated"),
  })
  .strict();
export type IntentConstraints = z.infer<typeof IntentConstraintsSchema>;

export const IntentEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    rootMissionId: MissionIdSchema,
    rootGoal: z
      .object({
        summary: z.string().min(1).max(1000),
        description: z.string().min(1).max(10000),
      })
      .strict(),
    successCriteria: z.array(SuccessCriterionSpecSchema).min(1).max(64),
    constraints: IntentConstraintsSchema,
    policyEngineVersion: z.string().min(1).max(64).default("1.0.0"),
  })
  .strict();
export type IntentEnvelope = z.infer<typeof IntentEnvelopeSchema>;

/**
 * Derives the immutable cryptographic identity of the mission lineage
 * via Canonical JSON (RFC 8785) SHA-256 (DR-01).
 */
export function computeIntentHash(envelope: IntentEnvelope): Sha256Hex {
  const json = canonicalize(envelope as unknown as JsonLike);
  return createHash("sha256").update(json).digest("hex") as Sha256Hex;
}

// ---------------------------------------------------------------------------
// 2. Machine-Addressable Criteria State Machines (DR-02)
// ---------------------------------------------------------------------------

export const CriterionStatusSchema = z.enum([
  "pending",
  "in_progress",
  "satisfied",
  "failed",
  "invalidated",
]);
export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

export const ContributionTypeSchema = z.enum([
  "code_mutation",
  "test_verification",
  "artifact_generation",
  "analysis_report",
]);
export type ContributionType = z.infer<typeof ContributionTypeSchema>;

export const MachineCriterionSchema = z
  .object({
    criterionId: CriterionIdSchema,
    intentHash: Sha256HexSchema,
    parentCriterionId: CriterionIdSchema.nullable().default(null),
    status: CriterionStatusSchema,
    allowedContributionTypes: z.array(ContributionTypeSchema).min(1).max(4),
    requiredEvidenceSchema: z.string().max(256).optional(),
    completionVerifier: CompletionVerifierSchema,
    immutableVersion: z.number().int().min(1),
  })
  .strict();
export type MachineCriterion = z.infer<typeof MachineCriterionSchema>;

// ---------------------------------------------------------------------------
// 3. Untrusted Observation Containment (DR-05)
// ---------------------------------------------------------------------------

export function wrapUntrustedObservation(rawOutput: string): string {
  const sanitized = rawOutput
    .replace(/SYSTEM:/gi, "[STRIPPED_SYSTEM]:")
    .replace(/\[ADMIN\]/gi, "[STRIPPED_ADMIN]")
    .replace(/BEGIN INSTRUCTION/gi, "[STRIPPED_INSTRUCTION]");
  return `<untrusted_child_observation>\n${sanitized}\n</untrusted_child_observation>`;
}
