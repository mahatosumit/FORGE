// FORGE Autonomous Mission Model Contracts.
// State machine, transition validation, budget specification, risk policies,
// and checkpoint summaries.

import { z } from "zod";
import {
  CriterionIdSchema,
  ConstraintsSchema,
  Iso8601Schema,
  MissionIdSchema,
  Sha256HexSchema,
  type CriterionId,
  type Constraints,
  type Iso8601,
  type MissionId,
} from "./base.js";
import { CriterionExprSchema, type CriterionExpr } from "./records.js";

export const MissionStateSchema = z.enum([
  "created",
  "planning",
  "planned",
  "executing",
  "blocked",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "recovering",
  "paused",
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

/** Explicit deterministic transition table (arbitrary transitions forbidden). */
export const VALID_MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  created: ["planning", "cancelled"],
  planning: ["planned", "recovering", "failed", "cancelled"],
  planned: ["executing", "recovering", "cancelled"],
  executing: ["blocked", "verifying", "planning", "failed", "cancelled", "recovering", "paused"],
  blocked: ["executing", "planning", "recovering", "failed", "cancelled", "paused"],
  verifying: ["completed", "executing", "planning", "recovering", "failed"],
  recovering: ["executing", "planning", "failed", "cancelled"],
  paused: ["executing", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function validateMissionTransition(from: MissionState, to: MissionState): boolean {
  if (from === to) return true;
  return VALID_MISSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export const AutonomyLevelSchema = z.enum([
  "L0_ASK",
  "L1_SUGGEST",
  "L2_SAFE_AUTONOMOUS",
  "L3_GOVERNED_AUTONOMOUS",
  "L4_FULL_MISSION_AUTONOMY",
]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const MissionBudgetSchema = z.object({
  maxPlannerTurns: z.number().int().min(1).default(50),
  maxModelCalls: z.number().int().min(1).default(100),
  maxTokens: z.number().int().min(1000).default(2_000_000),
  maxCapabilityCalls: z.number().int().min(1).default(100),
  maxRetries: z.number().int().min(0).default(20),
  maxExecutionTimeMs: z.number().int().min(1000).default(3600_000), // 1 hour
  maxArtifactBytes: z.number().int().min(1024).default(100 * 1024 * 1024), // 100MB
  maxConcurrentTasks: z.number().int().min(1).max(10).default(1),
  maxDelegationDepth: z.number().int().min(1).max(5).default(2),
});
export type MissionBudget = z.infer<typeof MissionBudgetSchema>;

export const MissionBudgetConsumedSchema = z.object({
  plannerTurns: z.number().int().min(0).default(0),
  modelCalls: z.number().int().min(0).default(0),
  tokensIn: z.number().int().min(0).default(0),
  tokensOut: z.number().int().min(0).default(0),
  capabilityCalls: z.number().int().min(0).default(0),
  retries: z.number().int().min(0).default(0),
  executionTimeMs: z.number().int().min(0).default(0),
  artifactBytes: z.number().int().min(0).default(0),
});
export type MissionBudgetConsumed = z.infer<typeof MissionBudgetConsumedSchema>;

export const MissionRiskPolicySchema = z.object({
  allowedCapabilities: z.array(z.string()).default(["*"]),
  escalationPermitted: z.boolean().default(true),
  requireVerificationTiers: z.array(z.enum(["mechanical", "adjudicated"])).default(["mechanical"]),
  autonomyLevel: AutonomyLevelSchema.default("L3_GOVERNED_AUTONOMOUS"),
});
export type MissionRiskPolicy = z.infer<typeof MissionRiskPolicySchema>;

export const CheckpointSummarySchema = z.object({
  checkpointId: z.string(),
  planId: z.string(),
  milestoneId: z.string().nullable().default(null),
  activeTaskId: z.string().nullable().default(null),
  completedTasksCount: z.number().int().min(0),
  timestamp: Iso8601Schema,
  chainTip: Sha256HexSchema.nullable().optional(),
});
export type CheckpointSummary = z.infer<typeof CheckpointSummarySchema>;

export const MissionModelSchema = z.object({
  missionId: MissionIdSchema,
  intent: z.string().min(1).max(8192),
  goalSpec: z.object({
    summary: z.string().min(1).max(2048),
    proposedCriteria: z.array(CriterionExprSchema).default([]),
  }),
  successCriteria: z.array(CriterionIdSchema).default([]),
  constraints: ConstraintsSchema.default({}),
  riskPolicy: MissionRiskPolicySchema.default({}),
  budget: MissionBudgetSchema.default({}),
  budgetConsumed: MissionBudgetConsumedSchema.default({}),
  deadline: Iso8601Schema.nullable().default(null),
  status: MissionStateSchema.default("created"),
  currentPlanId: z.string().nullable().default(null),
  currentMilestoneId: z.string().nullable().default(null),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
  checkpoint: CheckpointSummarySchema.nullable().default(null),
});
export type MissionModel = z.infer<typeof MissionModelSchema>;
