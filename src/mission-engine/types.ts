// FORGE Autonomous Mission Engine — Core Types and Interfaces (Step 4)

import type {
  CriterionExpr,
  ForgeRecord,
} from "../contracts/records.js";
import type {
  RecordId,
  Sha256Hex,
  Iso8601,
  MissionId,
  SecretName,
} from "../contracts/base.js";
import type { Proposal, ProposalMeta } from "../contracts/proposals.js";
import type { ModelFn } from "../contracts/model.js";
import type { Grant } from "../contracts/index.js";
import type {
  MissionModel,
  MissionState,
  MissionBudget,
  MissionBudgetConsumed,
  MissionRiskPolicy,
  CheckpointSummary,
} from "../contracts/mission.js";
import type {
  Plan,
  Milestone,
  Task,
  TaskFailureRecord,
  FailureCategory,
  DelegationSpec,
} from "../contracts/plan.js";

export interface PlannerContext {
  mission: MissionModel;
  plan: Plan | null;
  currentMilestone: Milestone | null;
  completedTasks: Task[];
  failedTasks: Task[];
  recentObservations: readonly ForgeRecord[];
  availableCapabilities: string[];
  activeGrants: Grant[];
  budgetRemaining: MissionBudget;
  workspaceRoot: string;
}

export type ProposalAction =
  | {
      type: "execute_task";
      task: Task;
      proposal: Proposal;
      meta?: ProposalMeta;
    }
  | {
      type: "replan";
      reason: string;
      diagnosis?: FailureDiagnosis;
    }
  | {
      type: "complete";
      summary: string;
    }
  | {
      type: "fail";
      reason: string;
    };

export interface FailureDiagnosis {
  category: FailureCategory;
  rootCause: string;
  recommendation: "retry" | "replan" | "escalate" | "abort";
  suggestedRemediation?: string;
}

export interface Planner {
  generatePlan(context: PlannerContext): Promise<Plan>;
  proposeNextAction(context: PlannerContext): Promise<ProposalAction>;
  diagnoseFailure(
    context: PlannerContext,
    task: Task,
    failure: TaskFailureRecord,
  ): Promise<FailureDiagnosis>;
}

export interface EscalationRequest {
  missionId: string;
  requestId: string;
  capability: string;
  requested: Grant["constraints"];
  rationale: string;
  citations: string[];
}

export interface EscalationDecision {
  decision: "extend" | "deny";
  expiresAt: string | null;
}

import type { CapabilityRegistry } from "../capabilities/registry.js";

export interface AutonomousMissionEngineOptions {
  dataDir: string;
  workspaceRoot: string;
  modelFn?: ModelFn;
  planner?: Planner;
  registry?: CapabilityRegistry;
  onEscalation?: (request: EscalationRequest) => Promise<EscalationDecision>;
  onPostEffectUnknown?: (missionId: string, proposalId: string) => Promise<boolean>;
  secrets?: { resolve(name: SecretName): string | null };
  onEvent?: (event: { missionId: string; kind: string; body: unknown }) => void;
  onModelDelta?: (event: { missionId: string; text: string; kind?: "text" | "reasoning" }) => void;
  timeoutFor?: (proposal: Proposal) => number;
  defaultRiskPolicy?: Partial<MissionRiskPolicy>;
  defaultBudget?: Partial<MissionBudget>;
}

export interface MissionSnapshot {
  missionId: MissionId;
  status: MissionState;
  intent: string;
  plan: Plan | null;
  currentMilestoneId: string | null;
  activeTaskId: string | null;
  budget: MissionBudget;
  budgetConsumed: MissionBudgetConsumed;
  completedTasksCount: number;
  totalTasksCount: number;
  progressPercent: number;
  error?: string | null;
  evidenceRefs: Sha256Hex[];
  checkpoints: CheckpointSummary[];
  ledgerHeadHash: Sha256Hex | null;
}

export class MissionBudgetExceededError extends Error {
  constructor(
    public readonly budgetKind: keyof MissionBudget,
    public readonly limit: number,
    public readonly consumed: number,
  ) {
    super(`Mission budget exceeded for ${budgetKind}: limit ${limit}, consumed ${consumed}`);
    this.name = "MissionBudgetExceededError";
  }
}

export class MissionSecurityViolationError extends Error {
  constructor(public readonly detail: string) {
    super(`Mission security violation: ${detail}`);
    this.name = "MissionSecurityViolationError";
  }
}

export class MissionStateTransitionError extends Error {
  constructor(
    public readonly from: MissionState,
    public readonly to: MissionState,
  ) {
    super(`Illegal mission state transition: ${from} -> ${to}`);
    this.name = "MissionStateTransitionError";
  }
}
