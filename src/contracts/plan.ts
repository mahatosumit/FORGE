// FORGE Autonomous Plan Model Contracts.
// Immutable versioned plans, milestones, tasks, failure diagnosis, and delegation specs.

import { z } from "zod";
import {
  Iso8601Schema,
  MissionIdSchema,
  Sha256HexSchema,
  type Iso8601,
  type MissionId,
  type Sha256Hex,
} from "./base.js";
import { CriterionExprSchema, type CriterionExpr } from "./records.js";
import { GrantSchema, type Grant } from "./grants.js";
import { MissionBudgetSchema, type MissionBudget } from "./mission.js";

export const TaskStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "skipped",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const FailureCategorySchema = z.enum([
  "transient",
  "capability_error",
  "authorization_error",
  "validation_error",
  "verification_failure",
  "planner_error",
  "resource_exhaustion",
  "security_violation",
  "unknown",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const TaskFailureRecordSchema = z.object({
  taskId: z.string(),
  capability: z.string(),
  errorCategory: FailureCategorySchema,
  errorMessage: z.string(),
  evidenceRefs: z.array(Sha256HexSchema).default([]),
  attemptNumber: z.number().int().min(1),
  likelyCause: z.string(),
  recoveryRecommendation: z.enum(["retry", "replan", "escalate", "abort"]),
});
export type TaskFailureRecord = z.infer<typeof TaskFailureRecordSchema>;

export const TaskSchema = z.object({
  taskId: z.string(),
  milestoneId: z.string(),
  title: z.string(),
  description: z.string(),
  capability: z.string(),
  capabilityVersion: z.string().optional(),
  manifestHash: Sha256HexSchema.optional(),
  implementationHash: Sha256HexSchema.optional(),
  args: z.record(z.unknown()),
  dependsOn: z.array(z.string()).default([]),
  status: TaskStateSchema.default("pending"),
  attempt: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(3),
  evidenceRefs: z.array(Sha256HexSchema).default([]),
  error: TaskFailureRecordSchema.nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

export const MilestoneStateSchema = z.enum([
  "pending",
  "in_progress",
  "succeeded",
  "failed",
  "skipped",
]);
export type MilestoneState = z.infer<typeof MilestoneStateSchema>;

export const MilestoneSchema = z.object({
  milestoneId: z.string(),
  objective: z.string(),
  dependencies: z.array(z.string()).default([]),
  tasks: z.array(TaskSchema),
  successCriteria: z.array(z.string()).default([]),
  verificationCriteria: z.array(CriterionExprSchema).default([]),
  status: MilestoneStateSchema.default("pending"),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

export const PlanSchema = z.object({
  planId: z.string(),
  missionId: MissionIdSchema,
  version: z.number().int().min(1),
  objective: z.string(),
  assumptions: z.array(z.string()).default([]),
  milestones: z.array(MilestoneSchema),
  dependencies: z.record(z.array(z.string())).default({}),
  verificationStrategy: z.string(),
  createdAt: Iso8601Schema,
  supersedesPlanId: z.string().nullable().default(null),
  immutable: z.literal(true).default(true),
});
export type Plan = z.infer<typeof PlanSchema>;

export const DelegationSpecSchema = z.object({
  delegationId: z.string(),
  parentMissionId: MissionIdSchema,
  objective: z.string(),
  scopedCapabilities: z.array(z.string()),
  scopedGrants: z.array(GrantSchema),
  budget: MissionBudgetSchema,
  deadline: Iso8601Schema.nullable().default(null),
  successCriteria: z.array(CriterionExprSchema),
});
export type DelegationSpec = z.infer<typeof DelegationSpecSchema>;
