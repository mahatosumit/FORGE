// FORGE Multi-Agent Authority Contracts (Step 8 Phase 1)
// Machine-checkable schemas for delegation grants, effective authority envelopes,
// registry entries, and identity structures.

import { z } from "zod";
import {
  ConstraintsSchema,
  CriterionIdSchema,
  GrantIdSchema,
  Iso8601Schema,
  MissionIdSchema,
  Sha256HexSchema,
  WorkspacePathSchema,
  HostPatternSchema,
  HttpMethodSchema,
} from "./base.js";
import { CapabilityIdSchema, RiskClassSchema } from "./grants.js";

// ---------------------------------------------------------------------------
// 1. Identity & Lineage Schemas
// ---------------------------------------------------------------------------

export const DelegationIdSchema = z
  .string()
  .regex(/^del_[0-9A-HJKMNP-TV-Z]{26}$/, "ULID format for delegation id");
export type DelegationId = z.infer<typeof DelegationIdSchema>;

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/i, "agentId must be alphanumeric with dashes or underscores");
export type AgentId = z.infer<typeof AgentIdSchema>;

export const IncarnationEpochSchema = z
  .number()
  .int()
  .min(1)
  .refine(Number.isSafeInteger, "epoch must be a safe integer");
export type IncarnationEpoch = z.infer<typeof IncarnationEpochSchema>;

export const DelegationStatusSchema = z.enum([
  "requested",
  "proposed",
  "authorized",
  "activating",
  "active",
  "paused",
  "suspended",
  "revoking",
  "revoked",
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "uncertain",
  "expired",
  "post_effect_unknown",
  "rejected",
]);
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

// ---------------------------------------------------------------------------
// 2. Budget Escrow Schemas
// ---------------------------------------------------------------------------

export const BudgetEscrowStateSchema = z.enum([
  "AVAILABLE",
  "ESCROWED",
  "ALLOCATED",
  "CONSUMED",
  "REFUNDABLE",
  "REFUNDED",
  "UNCERTAIN",
]);
export type BudgetEscrowState = z.infer<typeof BudgetEscrowStateSchema>;

export const DelegationBudgetSchema = z
  .object({
    maxPlannerTurns: z.number().int().min(1).max(50),
    maxModelCalls: z.number().int().min(1).max(100),
    maxTokens: z.number().int().min(1000).max(2_000_000),
    maxCapabilityCalls: z.number().int().min(1).max(100),
    maxRetries: z.number().int().min(0).max(20),
    maxExecutionTimeMs: z.number().int().min(1000).max(3600_000),
    maxArtifactBytes: z.number().int().min(1024).max(100 * 1024 * 1024),
    maxConcurrentTasks: z.number().int().min(1).max(5),
    maxSubprocesses: z.number().int().min(1).max(10).default(2),
  })
  .strict();
export type DelegationBudget = z.infer<typeof DelegationBudgetSchema>;

// ---------------------------------------------------------------------------
// 3. Effective Authority Envelope & Request Schemas
// ---------------------------------------------------------------------------

export const EffectiveAuthorityEnvelopeSchema = z
  .object({
    capabilities: z.array(CapabilityIdSchema).min(0).max(32),
    constraints: ConstraintsSchema.strict(),
    riskCeiling: RiskClassSchema,
    isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]),
    allowHostExecution: z.boolean(),
    budgetEscrow: DelegationBudgetSchema,
    expiresAt: Iso8601Schema.nullable(),
    depth: z.number().int().min(0).max(3),
    maxChildren: z.number().int().min(1).max(3).default(3),
  })
  .strict();
export type EffectiveAuthorityEnvelope = z.infer<typeof EffectiveAuthorityEnvelopeSchema>;

export const ChildRequestedAuthoritySchema = z
  .object({
    capabilities: z.array(CapabilityIdSchema).min(0).max(32).optional(),
    constraints: ConstraintsSchema.strict().optional(),
    riskCeiling: RiskClassSchema.optional(),
    isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]).optional(),
    allowHostExecution: z.boolean().optional(),
    budget: DelegationBudgetSchema.partial().optional(),
    expiresAt: Iso8601Schema.nullable().optional(),
  })
  .strict();
export type ChildRequestedAuthority = z.infer<typeof ChildRequestedAuthoritySchema>;

export const RequestedAuthoritySchema = z
  .object({
    capabilities: z.array(CapabilityIdSchema).min(1).max(32),
    constraints: ConstraintsSchema.strict(),
    riskCeiling: RiskClassSchema.optional(),
    isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]).optional(),
    allowHostExecution: z.boolean().optional(),
  })
  .strict();
export type RequestedAuthority = z.infer<typeof RequestedAuthoritySchema>;

export const TopologyMetadataSchema = z
  .object({
    depth: z.number().int().min(1).max(3),
    ancestorPath: z.array(DelegationIdSchema).min(1).max(4),
  })
  .strict();
export type TopologyMetadata = z.infer<typeof TopologyMetadataSchema>;

export const DelegateProposalArgsSchema = z
  .object({
    delegationId: DelegationIdSchema,
    parentDelegationId: DelegationIdSchema.nullable().default(null),
    parentMissionId: MissionIdSchema,
    childMissionId: MissionIdSchema,
    parentAgentId: AgentIdSchema,
    childAgentId: AgentIdSchema,
    incarnationEpoch: IncarnationEpochSchema,
    grantId: GrantIdSchema,
    grantRevision: z.number().int().min(1),
    requestedAuthority: RequestedAuthoritySchema,
    requestedBudget: DelegationBudgetSchema,
    expiry: Iso8601Schema.nullable(),
    topologyMetadata: TopologyMetadataSchema,
    targetCriterionId: CriterionIdSchema.optional(),
    criterionVersion: z.number().int().min(1).optional(),
    contributionType: z.enum(["code_mutation", "test_verification", "artifact_generation", "analysis_report"]).optional(),
    intentHash: Sha256HexSchema.optional(),
  })
  .strict();
export type DelegateProposalArgs = z.infer<typeof DelegateProposalArgsSchema>;

// ---------------------------------------------------------------------------
// 4. Central Delegation Registry Entry Schema
// ---------------------------------------------------------------------------

export const DelegationRegistryEntrySchema = z
  .object({
    delegationId: DelegationIdSchema,
    parentDelegationId: DelegationIdSchema.nullable(),
    rootMissionId: MissionIdSchema,
    parentMissionId: MissionIdSchema,
    childMissionId: MissionIdSchema,
    parentAgentId: AgentIdSchema,
    childAgentId: AgentIdSchema,
    depth: z.number().int().min(1).max(3),
    ancestorPath: z.array(DelegationIdSchema).min(1).max(4),

    // Incarnation & Process Binding
    childIncarnationEpoch: IncarnationEpochSchema,
    containerId: z.string().min(1).max(128).nullable().default(null),
    hostPid: z.number().int().nullable().default(null),

    // Authority Envelope & Cryptographic Binding
    grantId: GrantIdSchema,
    grantRevision: z.number().int().min(1),
    effectiveAuthorityHash: Sha256HexSchema,
    effectiveEnvelope: EffectiveAuthorityEnvelopeSchema,

    // Status & Timestamps
    status: DelegationStatusSchema,
    issuedAt: Iso8601Schema,
    expiresAt: Iso8601Schema.nullable(),
    revokedAt: Iso8601Schema.nullable().default(null),
    revocationReason: z.string().max(2000).nullable().default(null),

    // Topology counters snapshot
    activeChildCount: z.number().int().min(0).default(0),
    totalDescendantCount: z.number().int().min(0).default(0),
  })
  .strict();
export type DelegationRegistryEntry = z.infer<typeof DelegationRegistryEntrySchema>;

// ---------------------------------------------------------------------------
// 5. Canonical Identity Structure
// ---------------------------------------------------------------------------

export const AgentIdentityTupleSchema = z
  .object({
    agentId: AgentIdSchema,
    delegationId: DelegationIdSchema,
    missionId: MissionIdSchema,
    incarnationEpoch: IncarnationEpochSchema,
    grantId: GrantIdSchema,
    grantRevision: z.number().int().min(1),
  })
  .strict();
export type AgentIdentityTuple = z.infer<typeof AgentIdentityTupleSchema>;
