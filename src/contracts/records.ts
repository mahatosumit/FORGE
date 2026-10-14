// FORGE contracts — the Record union: the ledger's element type and the
// epistemic contract (KERNEL primitive #1).
// Source of truth: architecture/DATA-CONTRACTS.md §4 (with M0 corrections in
// ADR-007: missing bodies plan.revised / observation.git / observation.search,
// the normative CapabilityErrorCode enum, bounded model-controlled fields,
// domain-prefixed IDs).
//
// Structural rules encoded here:
//   C-1  kinds are a closed enum; unknown kinds are unrepresentable;
//   C-2  authorship is fixed per kind (AUTHORSHIP matrix) — the ledger append
//        API (codec/hashChain) enforces it; record bodies are hand-typed so
//        Omit<ForgeRecord,"hash"> stays precise for hash computation.

import { z } from "zod";
import {
  ArgvSchema,
  AuthorSchema,
  CriterionIdSchema,
  GrantIdSchema,
  Iso8601Schema,
  JsonValueSchema,
  type JsonValue,
  MissionIdSchema,
  RecordIdSchema,
  SeqSchema,
  Sha256HexSchema,
  StageIdSchema,
  WorkspacePathSchema,
  HttpMethodSchema,
  ConstraintsSchema,
  type Author,
  type CriterionId,
  type GrantId,
  type Iso8601,
  type MissionId,
  type RecordId,
  type Seq,
  type Sha256Hex,
  type StageId,
  type WorkspacePath,
  type Argv,
  type Constraints,
} from "./base.js";
import { EnvIdentitySchema, type EnvIdentity } from "./env.js";
import { GrantSchema, type Grant } from "./grants.js";
import { ProposalSchema, ProposalMetaSchema, type Proposal, type ProposalMeta } from "./proposals.js";
import { ReceiptSchema, MissionClosureSchema, type Receipt, type MissionClosure } from "./receipt.js";
import { ModelErrorCodeSchema, type ModelErrorCode } from "./model.js";
import {
  DelegationIdSchema,
  AgentIdSchema,
  IncarnationEpochSchema,
  DelegationBudgetSchema,
  EffectiveAuthorityEnvelopeSchema,
  type DelegationId,
  type AgentId,
  type IncarnationEpoch,
  type DelegationBudget,
  type EffectiveAuthorityEnvelope,
} from "./delegation.js";

/** Journal schema version (ADR-002). Bumping this is a breaking ledger change
 *  requiring an ADR. The codec rejects records with an unsupported version. */
export const JOURNAL_SCHEMA_VERSION = 1;

/** Schema annotation that decouples input from output: branded transforms
 *  accept plain strings on input and produce branded values on output. */
type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------------------
// Capability error codes — normative enum (M0 correction, ADR-007). Names are
// the ones used across FAILURE-SEMANTICS.md / STATE-MACHINES.md.
// ---------------------------------------------------------------------------
export const CapabilityErrorCodeSchema = z.enum([
  "capability-fault",
  "capability-timeout",
  "sidecar-crash",
  "artifact-missing",
  "budget-exhausted",
  "stage-budget",
  "mission-closed",
  "stage-terminal",
  "locked",
  "aborted",
  "projection",
  "unknown",
]);
export type CapabilityErrorCode = z.infer<typeof CapabilityErrorCodeSchema>;

export const EngineErrorCodeSchema = z.union([ModelErrorCodeSchema, CapabilityErrorCodeSchema]);
export type EngineErrorCode = ModelErrorCode | CapabilityErrorCode;

// ---------------------------------------------------------------------------
// Criterion expressions (§4).
// ---------------------------------------------------------------------------
export const CriterionExprSchema = z
  .discriminatedUnion("kind", [
    z
      .object({ kind: z.literal("command-exit"), argv: ArgvSchema, expect: z.number().int().min(0).max(255) })
      .strict(),
    z.object({ kind: z.literal("test-suite"), argv: ArgvSchema }).strict(),
    z
      .object({
        kind: z.literal("file-state"),
        path: WorkspacePathSchema,
        expect: z.enum(["exists", "hash", "diff-contains"]),
        hash: Sha256HexSchema.optional(),
        pattern: z.string().max(1024).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("artifact-exists"), hash: Sha256HexSchema }).strict(),
    z.object({ kind: z.literal("reproducible"), argv: ArgvSchema, outputHash: Sha256HexSchema }).strict(),
    z
      .object({
        kind: z.literal("http"),
        url: z.string().max(2048),
        expectStatus: z.number().int().min(100).max(599),
      })
      .strict(),
    z
      .object({
        kind: z.literal("adjudicate"),
        question: z.string().min(1).max(2000),
        judges: z.array(z.enum(["user", "model"])).min(1).max(2),
      })
      .strict(),
  ])
  .superRefine((c, ctx) => {
    if (c.kind === "file-state") {
      if ((c.expect === "hash") !== (c.hash !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "hash required for expect:'hash'" });
      }
      if ((c.expect === "diff-contains") !== (c.pattern !== undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "pattern required for expect:'diff-contains'" });
      }
    }
  });
export type CriterionExpr = z.infer<typeof CriterionExprSchema>;

// ---------------------------------------------------------------------------
// Record kinds (C-1: closed enum).
// ---------------------------------------------------------------------------

export const RecordKindSchema = z.enum([
  "mission.opened",
  "mission.directive",
  "mission.goal-revised",
  "mission.stage-summary",
  "mission.closed",
  "plan.proposed",
  "plan.confirmed",
  "plan.revised",
  "stage.completed",
  "criterion.defined",
  "grant.issued",
  "grant.requested",
  "grant.decided",
  "grant.revoked",
  "proposal.received",
  "proposal.validated",
  "proposal.dispatched",
  "observation.shell",
  "observation.fs",
  "observation.git",
  "observation.http",
  "observation.search",
  "observation.web_search",
  "observation.web_fetch",
  "observation.mcp",
  "observation.mcp_server_start",
  "observation.mcp_server_stop",
  "observation.doc_parse",
  "observation.verify",
  "observation.artifact",
  "observation.interrupted",
  "claim.asserted",
  "claim.rejected",
  "verdict.recorded",
  "engine.error",
  "security.note",
  // Autonomous Mission Engine Records (Step 4)
  "mission.created",
  "mission.state_changed",
  "plan.accepted",
  "task.started",
  "task.completed",
  "task.failed",
  "task.retry_scheduled",
  "verification.started",
  "verification.completed",
  "checkpoint.created",
  "mission.completed",
  "mission.failed",
  "mission.cancelled",
  // Model Runtime & Autonomous Reasoning Loop Records (Step 5)
  "model.requested",
  "model.completed",
  "model.failed",
  "decision.generated",
  "decision.rejected",
  "autonomy.policy_evaluated",
  "budget.updated",
  "mission.paused",
  "mission.resumed",
  // Multi-Agent Authority Records (Step 8 Phase 1)
  "delegation.proposed",
  "delegation.authorized",
  "delegation.activated",
  "delegation.reincarnated",
  "delegation.revoked",
  "delegation.receipt_verified",
  "delegation.receipt_rejected",
  "delegation.budget_reconciled",
  "delegation.cancelled",
]);
export type RecordKind = z.infer<typeof RecordKindSchema>;

// ---------------------------------------------------------------------------
// Body interfaces (hand-written; schemas below validate exactly these).
// ---------------------------------------------------------------------------

export interface StageDecl {
  id: StageId;
  purpose: string;
  mode: "model" | "deterministic";
  criteria: CriterionId[];
  grantsRequired: string[]; // capability ids, advisory
  budget: { steps: number; tokens: number; wallClockMs: number };
}

export interface MissionOpenedBody {
  intent: JsonValue; // user content, bounded by the schema/codec
  goalSpec: { summary: string; proposedCriteria: CriterionExpr[] };
}
export interface DirectiveBody {
  delivery: "steer" | "queue" | "revise";
  content: string; // C-5: ≤ 8 KiB
}
export interface GoalRevisedBody {
  from: string;
  to: string;
  reason: string;
  requestedBy: Author;
  confirmedBy: "user" | null;
}
export interface StageSummaryBody {
  stageId: StageId;
  summary: string; // C-5: ≤ 8 KiB — the runtime-authored compaction checkpoint
}
export interface MissionClosedBody {
  closure: MissionClosure;
  receipt: Receipt;
}
export interface PlanProposedBody {
  stages: StageDecl[];
}
export interface PlanConfirmedBody {
  stages: StageDecl[];
  grantIds: GrantId[];
}
export interface PlanRevisedBody {
  stages: StageDecl[];
  reason: string;
  material: boolean;
  confirmedBy: "user" | null;
}
export interface StageCompletedBody {
  stageId: StageId;
  outcome: "proceed" | "fail" | "blocked";
}
export interface CriterionBody {
  criterionId: CriterionId;
  expression: CriterionExpr;
  tier: "mechanical" | "adjudicated";
  origin: "model-proposed" | "user";
}
export interface GrantIssuedBody {
  grant: Grant;
}
export interface GrantRequestedBody {
  proposalId: RecordId;
  capability: string;
  requested: Constraints;
  rationale: string; // C-5: ≤ 4 KiB
  citations: RecordId[];
}
export interface GrantDecidedBody {
  requestId: RecordId;
  decision: "extend" | "deny" | "extend-project";
}
export interface GrantRevokedBody {
  grantId: GrantId;
  reason: string;
}
export interface ProposalReceivedBody {
  proposal: Proposal;
  meta: ProposalMeta;
}
export interface ProposalValidatedBody {
  proposalId: RecordId;
  result: "accepted" | "rejected-schema" | "rejected-gate";
  reasonCode: string;
  grantId?: GrantId;
}
export interface ProposalDispatchedBody {
  proposalId: RecordId;
  grantId: GrantId;
  capabilityId?: string;
  version?: string;
  manifestHash?: Sha256Hex;
  implementationHash?: Sha256Hex;
  environment: "local" | "container";
  isolationProfile?: "sandboxed" | "sandboxed-network" | "host";
  timeoutMs: number; // runtime-assigned (C-3), 1s–600s
  missionId?: string;
  taskId?: string;
  delegationId?: string;
  agentId?: string;
  incarnationEpoch?: number;
}
export interface ObservationShellBody {
  argv: Argv;
  cwd: WorkspacePath;
  exit: number | null;
  signal: string | null;
  outputRef: Sha256Hex;
  truncated: boolean;
  durationMs: number;
  envIdentity: EnvIdentity;
}
export interface ObservationFsBody {
  op: "write" | "append" | "patch" | "mkdir";
  path: WorkspacePath;
  beforeHash: Sha256Hex | null;
  afterHash: Sha256Hex;
  diffRef: Sha256Hex | null;
}
export interface ObservationGitBody {
  op: "status" | "diff" | "add" | "commit" | "rev-parse";
  exit: number | null;
  outputRef: Sha256Hex | null;
  commitHash: Sha256Hex | null;
  envIdentity: EnvIdentity;
}
export interface ObservationHttpBody {
  method: "GET" | "HEAD";
  url: string;
  status: number;
  bodyRef: Sha256Hex | null;
  truncated: boolean;
  effectiveUrl: string;      // last URL actually requested (ADR-007 #14)
  redirectBlocked: boolean;  // a redirect target exceeded grant scope
}
export interface ObservationSearchBody {
  mode: "grep" | "glob" | "symbol";
  query: string;
  matchCount: number;
  resultsRef: Sha256Hex | null;
}
export interface ObservationWebSearchBody {
  query: string;
  resultsCount: number;
  resultsRef: Sha256Hex | null;
  provider: string;
}
export interface ObservationWebFetchBody {
  url: string;
  status: number;
  title: string | null;
  contentRef: Sha256Hex | null;
  extractMode: "markdown" | "text" | "raw";
  byteLength: number;
  truncated: boolean;
}
export interface ObservationMcpBody {
  serverId: string;
  toolName: string;
  status: "success" | "tool_error" | "protocol_error" | "timeout";
  durationMs: number;
  requestRef: Sha256Hex;
  resultRef: Sha256Hex | null;
  error: string | null;
  truncated: boolean;
}
export interface ObservationMcpServerStartBody {
  serverId: string;
  command: string;
  args: string[];
  pid: number | null;
  status: "started" | "failed";
  discoveredTools: string[];
  durationMs: number;
  error?: string | null;
}
export interface ObservationMcpServerStopBody {
  serverId: string;
  status: "stopped" | "failed";
  durationMs: number;
  error?: string | null;
}
export interface ObservationDocParseBody {
  path: WorkspacePath;
  mime: string;
  parser: string;
  parserVersion: string;
  status: "success" | "parse_error" | "unsupported_format" | "timeout";
  byteLength: number;
  contentRef: Sha256Hex | null;
  pageCount?: number;
  sheetCount?: number;
  imageCount?: number;
  metadata?: Record<string, string | number | boolean>;
  error?: string | null;
  truncated: boolean;
  durationMs: number;
}
export interface ObservationVerifyBody {
  criterionId: CriterionId;
  /** M3 correction (ADR-007): verification is not only command-shaped. */
  via: "command" | "file-state" | "artifact-exists" | "http";
  command: Argv | null;
  exit: number | null;
  outputRef: Sha256Hex | null;
  matched: boolean;
}
export interface ObservationArtifactBody {
  hash: Sha256Hex;
  bytes: number;
  sourcePath: WorkspacePath | null;
}
export interface ObservationInterruptedBody {
  proposalId: RecordId;
  phase: "pre-effect" | "post-effect-unknown"; // post ⇒ duplicate risk flagged (ADR-006)
  note: string;
  capabilityId?: string;
  version?: string;
  manifestHash?: Sha256Hex;
  expectedImplementationHash?: Sha256Hex;
  observedImplementationHash?: Sha256Hex;
  grantId?: GrantId;
  missionId?: string;
  taskId?: string;
}
export interface ClaimAssertedBody {
  statement: string; // C-5: ≤ 8 KiB
  citations: RecordId[]; // INV-2: ≥ 1, must resolve (ledger enforces)
}
export interface ClaimRejectedBody {
  // M3 correction (ADR-007 #13): a rejected claim is never stored, so there is
  // no valid claim id to reference — the record carries the rejected content.
  reason: "unresolved-citation" | "foreign-mission";
  statement: string; // truncated to 512 chars
  citations: RecordId[];
}
export interface VerdictBody {
  criterionId: CriterionId;
  result: "pass" | "fail" | "inconclusive";
  tier: "mechanical" | "adjudicated";
  by: "runtime" | "adjudicator:user" | "adjudicator:model";
  refs: RecordId[];
}
export interface EngineErrorBody {
  code: EngineErrorCode;
  message: string;
  retryable: boolean;
}
export interface SecurityNoteBody {
  kind: "injection-suspected" | "gate-bypass-attempt" | "secret-redacted";
  detail: string;
  refs: RecordId[];
}

export interface MissionCreatedBody {
  missionId: MissionId;
  intent: string;
  goalSummary: string;
}
export interface MissionStateChangedBody {
  from: string;
  to: string;
  reason: string | null;
}
export interface PlanAcceptedBody {
  planId: string;
  version: number;
  milestoneCount: number;
  taskCount: number;
}
export interface TaskStartedBody {
  taskId: string;
  milestoneId: string;
  capability: string;
  attempt: number;
}
export interface TaskCompletedBody {
  taskId: string;
  milestoneId: string;
  capability: string;
  evidenceRefs: Sha256Hex[];
  durationMs: number;
}
export interface TaskFailedBody {
  taskId: string;
  milestoneId: string;
  capability: string;
  errorCategory: string;
  errorMessage: string;
  attempt: number;
  retryable: boolean;
}
export interface TaskRetryScheduledBody {
  taskId: string;
  attempt: number;
  delayMs: number;
  reason: string;
}
export interface VerificationStartedBody {
  targetId: string;
  targetType: "task" | "milestone" | "mission";
  criteria: string[];
}
export interface VerificationCompletedBody {
  targetId: string;
  targetType: "task" | "milestone" | "mission";
  passed: boolean;
  evidenceRefs: Sha256Hex[];
  reason: string | null;
}
export interface CheckpointCreatedBody {
  checkpointId: string;
  state: string;
  planId: string;
  completedTasks: number;
  totalTasks: number;
}
export interface MissionCompletedBody {
  summary: string;
  totalTasksCompleted: number;
  durationMs: number;
  chainTip: Sha256Hex;
}
export interface MissionFailedBody {
  reason: string;
  failedTaskId: string | null;
  errorCategory: string | null;
}
export interface MissionCancelledBody {
  reason: string;
  cancelledBy: "user" | "runtime";
}

export interface ModelRequestedBody {
  taskId: string | null;
  modelId: string;
  providerId: string;
  promptTokensEstimate: number;
  messageCount: number;
}
export interface ModelCompletedBody {
  taskId: string | null;
  modelId: string;
  providerId: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  stopReason: string;
}
export interface ModelFailedBody {
  taskId: string | null;
  modelId: string;
  providerId: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
}
export interface DecisionGeneratedBody {
  taskId: string | null;
  decisionType: string;
  hasProposal: boolean;
  capability: string | null;
  rationale: string;
}
export interface DecisionRejectedBody {
  taskId: string | null;
  reason: string;
  validationErrors: string[];
}
export interface AutonomyPolicyEvaluatedBody {
  level: string;
  proposalCapability: string;
  requiresApproval: boolean;
  approved: boolean;
  reason: string;
}
export interface BudgetUpdatedBody {
  modelCalls: number;
  tokensUsed: number;
  wallClockMs: number;
  remainingTurns: number;
  remainingTokens: number;
}
export interface MissionPausedBody {
  reason: string;
  checkpointId: string;
}
export interface MissionResumedBody {
  fromCheckpointId: string | null;
  resumedAt: Iso8601;
}

export interface DelegationProposedBody {
  delegationId: DelegationId;
  parentDelegationId: DelegationId | null;
  parentMissionId: MissionId;
  childMissionId: MissionId;
  parentAgentId: AgentId;
  childAgentId: AgentId;
  depth: number;
  ancestorPath: DelegationId[];
  grantId: GrantId;
  grantRevision: number;
  requestedCapabilities: string[];
  requestedConstraints: Constraints;
  requestedBudget: DelegationBudget;
  expiry: Iso8601 | null;
}

export interface DelegationAuthorizedBody {
  delegationId: DelegationId;
  parentDelegationId: DelegationId | null;
  parentMissionId: MissionId;
  childMissionId: MissionId;
  parentAgentId: AgentId;
  childAgentId: AgentId;
  depth: number;
  ancestorPath: DelegationId[];
  grantId: GrantId;
  grantRevision: number;
  effectiveAuthorityHash: Sha256Hex;
  effectiveEnvelope: EffectiveAuthorityEnvelope;
  budgetEscrow: DelegationBudget;
  newAvailableTokens: number;
}

export interface DelegationActivatedBody {
  delegationId: DelegationId;
  childMissionId: MissionId;
  childAgentId: AgentId;
  childIncarnationEpoch: IncarnationEpoch;
  containerId: string | null;
  hostPid: number | null;
}

export interface DelegationReincarnatedBody {
  delegationId: DelegationId;
  childMissionId: MissionId;
  childAgentId: AgentId;
  oldEpoch: IncarnationEpoch;
  newEpoch: IncarnationEpoch;
  reason: string;
}

export interface DelegationRevokedBody {
  delegationId: DelegationId;
  parentDelegationId: DelegationId | null;
  childMissionId: MissionId;
  revokedAt: Iso8601;
  reason: string;
  revokedBy: "parent" | "operator" | "cascade";
}

export interface DelegationReceiptVerifiedBody {
  receiptId: string;
  delegationId: DelegationId;
  parentMissionId: MissionId;
  childMissionId: MissionId;
  parentTaskId: string;
  childLedgerTip: Sha256Hex;
  childRecordCount: number;
  evidenceRefs: Sha256Hex[];
  budgetConsumed: {
    plannerTurns: number;
    modelCalls: number;
    tokensIn: number;
    tokensOut: number;
    capabilityCalls: number;
    retries: number;
    executionTimeMs: number;
    artifactBytes: number;
  };
  status: "succeeded" | "failed" | "inconclusive";
  receiptDigest: Sha256Hex;
}

export interface DelegationReceiptRejectedBody {
  receiptId: string;
  delegationId: DelegationId;
  parentMissionId: MissionId;
  childMissionId: MissionId;
  reasonCode: string;
  detail: string;
}

export interface DelegationBudgetReconciledBody {
  delegationId: DelegationId;
  parentMissionId: MissionId;
  childMissionId: MissionId;
  escrowedBudget: DelegationBudget;
  actualConsumed: {
    tokens: number;
    modelCalls: number;
    capabilityCalls: number;
    executionTimeMs: number;
  };
  refundedTokens: number;
  newAvailableTokens: number;
}

export interface DelegationCancelledBody {
  delegationId: DelegationId;
  childMissionId: MissionId;
  reason: string;
  cancelledBy: "parent" | "runtime" | "user";
}

export interface RecordBodyMap {
  "mission.opened": MissionOpenedBody;
  "mission.directive": DirectiveBody;
  "mission.goal-revised": GoalRevisedBody;
  "mission.stage-summary": StageSummaryBody;
  "mission.closed": MissionClosedBody;
  "plan.proposed": PlanProposedBody;
  "plan.confirmed": PlanConfirmedBody;
  "plan.revised": PlanRevisedBody;
  "stage.completed": StageCompletedBody;
  "criterion.defined": CriterionBody;
  "grant.issued": GrantIssuedBody;
  "grant.requested": GrantRequestedBody;
  "grant.decided": GrantDecidedBody;
  "grant.revoked": GrantRevokedBody;
  "proposal.received": ProposalReceivedBody;
  "proposal.validated": ProposalValidatedBody;
  "proposal.dispatched": ProposalDispatchedBody;
  "observation.shell": ObservationShellBody;
  "observation.fs": ObservationFsBody;
  "observation.git": ObservationGitBody;
  "observation.http": ObservationHttpBody;
  "observation.search": ObservationSearchBody;
  "observation.web_search": ObservationWebSearchBody;
  "observation.web_fetch": ObservationWebFetchBody;
  "observation.mcp": ObservationMcpBody;
  "observation.mcp_server_start": ObservationMcpServerStartBody;
  "observation.mcp_server_stop": ObservationMcpServerStopBody;
  "observation.doc_parse": ObservationDocParseBody;
  "observation.verify": ObservationVerifyBody;
  "observation.artifact": ObservationArtifactBody;
  "observation.interrupted": ObservationInterruptedBody;
  "claim.asserted": ClaimAssertedBody;
  "claim.rejected": ClaimRejectedBody;
  "verdict.recorded": VerdictBody;
  "engine.error": EngineErrorBody;
  "security.note": SecurityNoteBody;
  "mission.created": MissionCreatedBody;
  "mission.state_changed": MissionStateChangedBody;
  "plan.accepted": PlanAcceptedBody;
  "task.started": TaskStartedBody;
  "task.completed": TaskCompletedBody;
  "task.failed": TaskFailedBody;
  "task.retry_scheduled": TaskRetryScheduledBody;
  "verification.started": VerificationStartedBody;
  "verification.completed": VerificationCompletedBody;
  "checkpoint.created": CheckpointCreatedBody;
  "mission.completed": MissionCompletedBody;
  "mission.failed": MissionFailedBody;
  "mission.cancelled": MissionCancelledBody;
  "model.requested": ModelRequestedBody;
  "model.completed": ModelCompletedBody;
  "model.failed": ModelFailedBody;
  "decision.generated": DecisionGeneratedBody;
  "decision.rejected": DecisionRejectedBody;
  "autonomy.policy_evaluated": AutonomyPolicyEvaluatedBody;
  "budget.updated": BudgetUpdatedBody;
  "mission.paused": MissionPausedBody;
  "mission.resumed": MissionResumedBody;
  "delegation.proposed": DelegationProposedBody;
  "delegation.authorized": DelegationAuthorizedBody;
  "delegation.activated": DelegationActivatedBody;
  "delegation.reincarnated": DelegationReincarnatedBody;
  "delegation.revoked": DelegationRevokedBody;
  "delegation.receipt_verified": DelegationReceiptVerifiedBody;
  "delegation.receipt_rejected": DelegationReceiptRejectedBody;
  "delegation.budget_reconciled": DelegationBudgetReconciledBody;
  "delegation.cancelled": DelegationCancelledBody;
}

// ---------------------------------------------------------------------------
// Body schemas (one per kind, validating exactly the interfaces above).
// ---------------------------------------------------------------------------

const StageDeclSchema: Schema<StageDecl> = z
  .object({
    id: StageIdSchema,
    purpose: z.string().min(1).max(500),
    mode: z.enum(["model", "deterministic"]),
    criteria: z.array(CriterionIdSchema).max(32),
    grantsRequired: z.array(z.string().max(64)).max(32),
    budget: z
      .object({
        steps: z.number().int().min(1).max(10_000),
        tokens: z.number().int().min(1).max(10_000_000),
        wallClockMs: z.number().int().min(1000).max(86_400_000),
      })
      .strict(),
  })
  .strict();

const bodySchemas: { [K in RecordKind]: Schema<RecordBodyMap[K]> } = {
  "mission.opened": z
    .object({
      intent: JsonValueSchema,
      goalSpec: z
        .object({
          summary: z.string().min(1).max(2000),
          proposedCriteria: z.array(CriterionExprSchema).max(32),
        })
        .strict(),
    })
    .strict(),
  "mission.directive": z
    .object({
      delivery: z.enum(["steer", "queue", "revise"]),
      content: z.string().min(1).max(8192),
    })
    .strict(),
  "mission.goal-revised": z
    .object({
      from: z.string().min(1).max(2000),
      to: z.string().min(1).max(2000),
      reason: z.string().min(1).max(2000),
      requestedBy: AuthorSchema,
      confirmedBy: z.enum(["user"]).nullable(),
    })
    .strict(),
  "mission.stage-summary": z
    .object({ stageId: StageIdSchema, summary: z.string().min(1).max(8192) })
    .strict(),
  "mission.closed": z.object({ closure: MissionClosureSchema, receipt: ReceiptSchema }).strict(),
  "plan.proposed": z.object({ stages: z.array(StageDeclSchema).max(64) }).strict(),
  "plan.confirmed": z
    .object({ stages: z.array(StageDeclSchema).max(64), grantIds: z.array(GrantIdSchema).max(64) })
    .strict(),
  "plan.revised": z
    .object({
      stages: z.array(StageDeclSchema).max(64),
      reason: z.string().min(1).max(2000),
      material: z.boolean(),
      confirmedBy: z.enum(["user"]).nullable(),
    })
    .strict(),
  "stage.completed": z
    .object({
      stageId: StageIdSchema,
      outcome: z.enum(["proceed", "fail", "blocked"]),
    })
    .strict(),
  "criterion.defined": z
    .object({
      criterionId: CriterionIdSchema,
      expression: CriterionExprSchema,
      tier: z.enum(["mechanical", "adjudicated"]),
      origin: z.enum(["model-proposed", "user"]),
    })
    .strict(),
  "grant.issued": z.object({ grant: GrantSchema }).strict(),
  "grant.requested": z
    .object({
      proposalId: RecordIdSchema,
      capability: z.string().max(64),
      requested: ConstraintsSchema,
      rationale: z.string().min(1).max(4096),
      citations: z.array(RecordIdSchema).max(64),
    })
    .strict(),
  "grant.decided": z
    .object({
      requestId: RecordIdSchema,
      decision: z.enum(["extend", "deny", "extend-project"]),
    })
    .strict(),
  "grant.revoked": z.object({ grantId: GrantIdSchema, reason: z.string().min(1).max(2000) }).strict(),
  "proposal.received": z.object({ proposal: ProposalSchema, meta: ProposalMetaSchema }).strict(),
  "proposal.validated": z
    .object({
      proposalId: RecordIdSchema,
      result: z.enum(["accepted", "rejected-schema", "rejected-gate"]),
      reasonCode: z.string().max(64),
      grantId: GrantIdSchema.optional(),
    })
    .strict(),
  "proposal.dispatched": z
    .object({
      proposalId: RecordIdSchema,
      grantId: GrantIdSchema,
      capabilityId: z.string().min(1).max(64).default("unknown"),
      version: z.string().min(1).max(32).default("1.0.0"),
      manifestHash: Sha256HexSchema.default("0".repeat(64) as Sha256Hex),
      implementationHash: Sha256HexSchema.default("0".repeat(64) as Sha256Hex),
      environment: z.enum(["local", "container"]),
      isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]).optional(),
      timeoutMs: z.number().int().min(1000).max(600_000),
      missionId: z.string().optional(),
      taskId: z.string().optional(),
      delegationId: DelegationIdSchema.optional(),
      agentId: AgentIdSchema.optional(),
      incarnationEpoch: IncarnationEpochSchema.optional(),
    })
    .strict(),
  "observation.shell": z
    .object({
      argv: ArgvSchema,
      cwd: WorkspacePathSchema,
      exit: z.number().int().min(0).max(255).nullable(),
      signal: z.string().max(16).nullable(),
      outputRef: Sha256HexSchema,
      truncated: z.boolean(),
      durationMs: z.number().int().min(0).max(86_400_000),
      envIdentity: EnvIdentitySchema,
    })
    .strict(),
  "observation.fs": z
    .object({
      op: z.enum(["write", "append", "patch", "mkdir"]),
      path: WorkspacePathSchema,
      beforeHash: Sha256HexSchema.nullable(),
      afterHash: Sha256HexSchema,
      diffRef: Sha256HexSchema.nullable(),
    })
    .strict(),
  "observation.git": z
    .object({
      op: z.enum(["status", "diff", "add", "commit", "rev-parse"]),
      exit: z.number().int().min(0).max(255).nullable(),
      outputRef: Sha256HexSchema.nullable(),
      commitHash: Sha256HexSchema.nullable(),
      envIdentity: EnvIdentitySchema,
    })
    .strict(),
  "observation.http": z
    .object({
      method: HttpMethodSchema,
      url: z.string().max(2048),
      status: z.number().int().min(100).max(599),
      bodyRef: Sha256HexSchema.nullable(),
      truncated: z.boolean(),
      effectiveUrl: z.string().max(2048),
      redirectBlocked: z.boolean(),
    })
    .strict(),
  "observation.search": z
    .object({
      mode: z.enum(["grep", "glob", "symbol"]),
      // Empty query is the scoped-read idiom (proposal requires pathPrefix then).
      query: z.string().max(1024),
      matchCount: z.number().int().min(0).refine(Number.isSafeInteger),
      resultsRef: Sha256HexSchema.nullable(),
    })
    .strict(),
  "observation.web_search": z
    .object({
      query: z.string().min(1).max(1024),
      resultsCount: z.number().int().min(0).refine(Number.isSafeInteger),
      resultsRef: Sha256HexSchema.nullable(),
      provider: z.string().min(1).max(64),
    })
    .strict(),
  "observation.web_fetch": z
    .object({
      url: z.string().max(2048),
      status: z.number().int().min(100).max(599),
      title: z.string().max(1024).nullable(),
      contentRef: Sha256HexSchema.nullable(),
      extractMode: z.enum(["markdown", "text", "raw"]),
      byteLength: z.number().int().min(0).refine(Number.isSafeInteger),
      truncated: z.boolean(),
    })
    .strict(),
  "observation.mcp": z
    .object({
      serverId: z.string().min(1).max(64),
      toolName: z.string().min(1).max(128),
      status: z.enum(["success", "tool_error", "protocol_error", "timeout"]),
      durationMs: z.number().int().min(0).refine(Number.isSafeInteger),
      requestRef: Sha256HexSchema,
      resultRef: Sha256HexSchema.nullable(),
      error: z.string().max(4096).nullable(),
      truncated: z.boolean(),
    })
    .strict(),
  "observation.mcp_server_start": z
    .object({
      serverId: z.string().min(1).max(64),
      command: z.string().min(1).max(512),
      args: z.array(z.string().max(2048)).max(64),
      pid: z.number().int().nullable(),
      status: z.enum(["started", "failed"]),
      discoveredTools: z.array(z.string().max(128)).max(256),
      durationMs: z.number().int().min(0).refine(Number.isSafeInteger),
      error: z.string().max(4096).nullable().optional(),
    })
    .strict(),
  "observation.mcp_server_stop": z
    .object({
      serverId: z.string().min(1).max(64),
      status: z.enum(["stopped", "failed"]),
      durationMs: z.number().int().min(0).refine(Number.isSafeInteger),
      error: z.string().max(4096).nullable().optional(),
    })
    .strict(),
  "observation.doc_parse": z
    .object({
      path: WorkspacePathSchema,
      mime: z.string().min(1).max(128),
      parser: z.string().min(1).max(64),
      parserVersion: z.string().min(1).max(32),
      status: z.enum(["success", "parse_error", "unsupported_format", "timeout"]),
      byteLength: z.number().int().min(0).refine(Number.isSafeInteger),
      contentRef: Sha256HexSchema.nullable(),
      pageCount: z.number().int().min(0).optional(),
      sheetCount: z.number().int().min(0).optional(),
      imageCount: z.number().int().min(0).optional(),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      error: z.string().max(4096).nullable().optional(),
      truncated: z.boolean(),
      durationMs: z.number().int().min(0).refine(Number.isSafeInteger),
    })
    .strict(),
  "observation.verify": z
    .object({
      criterionId: CriterionIdSchema,
      via: z.enum(["command", "file-state", "artifact-exists", "http"]),
      command: ArgvSchema.nullable(),
      exit: z.number().int().min(0).max(255).nullable(),
      outputRef: Sha256HexSchema.nullable(),
      matched: z.boolean(),
    })
    .strict(),
  "observation.artifact": z
    .object({
      hash: Sha256HexSchema,
      bytes: z.number().int().min(0).max(2 ** 40),
      sourcePath: WorkspacePathSchema.nullable(),
    })
    .strict(),
  "observation.interrupted": z
    .object({
      proposalId: RecordIdSchema,
      phase: z.enum(["pre-effect", "post-effect-unknown"]),
      note: z.string().min(1).max(2000),
      capabilityId: z.string().optional(),
      version: z.string().optional(),
      manifestHash: Sha256HexSchema.optional(),
      expectedImplementationHash: Sha256HexSchema.optional(),
      observedImplementationHash: Sha256HexSchema.optional(),
      grantId: GrantIdSchema.optional(),
      missionId: z.string().optional(),
      taskId: z.string().optional(),
    })
    .strict(),
  "claim.asserted": z
    .object({
      statement: z.string().min(1).max(8192),
      citations: z.array(RecordIdSchema).min(1).max(64),
    })
    .strict(),
  "claim.rejected": z
    .object({
      reason: z.enum(["unresolved-citation", "foreign-mission"]),
      statement: z.string().min(1).max(512),
      citations: z.array(RecordIdSchema).max(64),
    })
    .strict(),
  "verdict.recorded": z
    .object({
      criterionId: CriterionIdSchema,
      result: z.enum(["pass", "fail", "inconclusive"]),
      tier: z.enum(["mechanical", "adjudicated"]),
      by: z.enum(["runtime", "adjudicator:user", "adjudicator:model"]),
      refs: z.array(RecordIdSchema).max(128),
    })
    .strict(),
  "engine.error": z
    .object({
      code: EngineErrorCodeSchema,
      message: z.string().min(1).max(4096),
      retryable: z.boolean(),
    })
    .strict(),
  "security.note": z
    .object({
      kind: z.enum(["injection-suspected", "gate-bypass-attempt", "secret-redacted"]),
      detail: z.string().min(1).max(4096),
      refs: z.array(RecordIdSchema).max(64),
    })
    .strict(),
  "mission.created": z
    .object({
      missionId: MissionIdSchema,
      intent: z.string().min(1).max(8192),
      goalSummary: z.string().min(1).max(2048),
    })
    .strict(),
  "mission.state_changed": z
    .object({
      from: z.string().min(1).max(64),
      to: z.string().min(1).max(64),
      reason: z.string().max(2048).nullable(),
    })
    .strict(),
  "plan.accepted": z
    .object({
      planId: z.string().min(1).max(64),
      version: z.number().int().min(1),
      milestoneCount: z.number().int().min(0),
      taskCount: z.number().int().min(0),
    })
    .strict(),
  "task.started": z
    .object({
      taskId: z.string().min(1).max(64),
      milestoneId: z.string().min(1).max(64),
      capability: z.string().min(1).max(64),
      attempt: z.number().int().min(1),
    })
    .strict(),
  "task.completed": z
    .object({
      taskId: z.string().min(1).max(64),
      milestoneId: z.string().min(1).max(64),
      capability: z.string().min(1).max(64),
      evidenceRefs: z.array(Sha256HexSchema).max(64),
      durationMs: z.number().int().min(0),
    })
    .strict(),
  "task.failed": z
    .object({
      taskId: z.string().min(1).max(64),
      milestoneId: z.string().min(1).max(64),
      capability: z.string().min(1).max(64),
      errorCategory: z.string().min(1).max(64),
      errorMessage: z.string().min(1).max(4096),
      attempt: z.number().int().min(1),
      retryable: z.boolean(),
    })
    .strict(),
  "task.retry_scheduled": z
    .object({
      taskId: z.string().min(1).max(64),
      attempt: z.number().int().min(1),
      delayMs: z.number().int().min(0),
      reason: z.string().min(1).max(2048),
    })
    .strict(),
  "verification.started": z
    .object({
      targetId: z.string().min(1).max(64),
      targetType: z.enum(["task", "milestone", "mission"]),
      criteria: z.array(z.string()).max(32),
    })
    .strict(),
  "verification.completed": z
    .object({
      targetId: z.string().min(1).max(64),
      targetType: z.enum(["task", "milestone", "mission"]),
      passed: z.boolean(),
      evidenceRefs: z.array(Sha256HexSchema).max(64),
      reason: z.string().max(2048).nullable(),
    })
    .strict(),
  "checkpoint.created": z
    .object({
      checkpointId: z.string().min(1).max(64),
      state: z.string().min(1).max(64),
      planId: z.string().min(1).max(64),
      completedTasks: z.number().int().min(0),
      totalTasks: z.number().int().min(0),
    })
    .strict(),
  "mission.completed": z
    .object({
      summary: z.string().min(1).max(4096),
      totalTasksCompleted: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      chainTip: Sha256HexSchema,
    })
    .strict(),
  "mission.failed": z
    .object({
      reason: z.string().min(1).max(4096),
      failedTaskId: z.string().max(64).nullable(),
      errorCategory: z.string().max(64).nullable(),
    })
    .strict(),
  "mission.cancelled": z
    .object({
      reason: z.string().min(1).max(2048),
      cancelledBy: z.enum(["user", "runtime"]),
    })
    .strict(),
  "model.requested": z
    .object({
      taskId: z.string().max(64).nullable(),
      modelId: z.string().min(1).max(128),
      providerId: z.string().min(1).max(64),
      promptTokensEstimate: z.number().int().min(0),
      messageCount: z.number().int().min(0),
    })
    .strict(),
  "model.completed": z
    .object({
      taskId: z.string().max(64).nullable(),
      modelId: z.string().min(1).max(128),
      providerId: z.string().min(1).max(64),
      tokensIn: z.number().int().min(0),
      tokensOut: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      stopReason: z.string().max(64),
    })
    .strict(),
  "model.failed": z
    .object({
      taskId: z.string().max(64).nullable(),
      modelId: z.string().min(1).max(128),
      providerId: z.string().min(1).max(64),
      errorCode: z.string().max(64),
      errorMessage: z.string().max(4096),
      retryable: z.boolean(),
    })
    .strict(),
  "decision.generated": z
    .object({
      taskId: z.string().max(64).nullable(),
      decisionType: z.string().max(64),
      hasProposal: z.boolean(),
      capability: z.string().max(64).nullable(),
      rationale: z.string().max(8192),
    })
    .strict(),
  "decision.rejected": z
    .object({
      taskId: z.string().max(64).nullable(),
      reason: z.string().max(4096),
      validationErrors: z.array(z.string().max(1024)),
    })
    .strict(),
  "autonomy.policy_evaluated": z
    .object({
      level: z.string().max(64),
      proposalCapability: z.string().max(64),
      requiresApproval: z.boolean(),
      approved: z.boolean(),
      reason: z.string().max(2048),
    })
    .strict(),
  "budget.updated": z
    .object({
      modelCalls: z.number().int().min(0),
      tokensUsed: z.number().int().min(0),
      wallClockMs: z.number().int().min(0),
      remainingTurns: z.number().int().min(0),
      remainingTokens: z.number().int().min(0),
    })
    .strict(),
  "mission.paused": z
    .object({
      reason: z.string().max(2048),
      checkpointId: z.string().max(64),
    })
    .strict(),
  "mission.resumed": z
    .object({
      fromCheckpointId: z.string().max(64).nullable(),
      resumedAt: Iso8601Schema,
    })
    .strict(),
  "delegation.proposed": z
    .object({
      delegationId: DelegationIdSchema,
      parentDelegationId: DelegationIdSchema.nullable(),
      parentMissionId: MissionIdSchema,
      childMissionId: MissionIdSchema,
      parentAgentId: AgentIdSchema,
      childAgentId: AgentIdSchema,
      depth: z.number().int().min(1).max(3),
      ancestorPath: z.array(DelegationIdSchema).min(1).max(4),
      grantId: GrantIdSchema,
      grantRevision: z.number().int().min(1),
      requestedCapabilities: z.array(z.string().max(64)),
      requestedConstraints: ConstraintsSchema,
      requestedBudget: DelegationBudgetSchema,
      expiry: Iso8601Schema.nullable(),
    })
    .strict(),
  "delegation.authorized": z
    .object({
      delegationId: DelegationIdSchema,
      parentDelegationId: DelegationIdSchema.nullable(),
      parentMissionId: MissionIdSchema,
      childMissionId: MissionIdSchema,
      parentAgentId: AgentIdSchema,
      childAgentId: AgentIdSchema,
      depth: z.number().int().min(1).max(3),
      ancestorPath: z.array(DelegationIdSchema).min(1).max(4),
      grantId: GrantIdSchema,
      grantRevision: z.number().int().min(1),
      effectiveAuthorityHash: Sha256HexSchema,
      effectiveEnvelope: EffectiveAuthorityEnvelopeSchema,
      budgetEscrow: DelegationBudgetSchema,
      newAvailableTokens: z.number().int().min(0),
    })
    .strict(),
  "delegation.activated": z
    .object({
      delegationId: DelegationIdSchema,
      childMissionId: MissionIdSchema,
      childAgentId: AgentIdSchema,
      childIncarnationEpoch: IncarnationEpochSchema,
      containerId: z.string().min(1).max(128).nullable(),
      hostPid: z.number().int().nullable(),
    })
    .strict(),
  "delegation.reincarnated": z
    .object({
      delegationId: DelegationIdSchema,
      childMissionId: MissionIdSchema,
      childAgentId: AgentIdSchema,
      oldEpoch: IncarnationEpochSchema,
      newEpoch: IncarnationEpochSchema,
      reason: z.string().max(2000),
    })
    .strict(),
  "delegation.revoked": z
    .object({
      delegationId: DelegationIdSchema,
      parentDelegationId: DelegationIdSchema.nullable(),
      childMissionId: MissionIdSchema,
      revokedAt: Iso8601Schema,
      reason: z.string().max(2000),
      revokedBy: z.enum(["parent", "operator", "cascade"]),
    })
    .strict(),
  "delegation.receipt_verified": z
    .object({
      receiptId: z.string().max(64),
      delegationId: DelegationIdSchema,
      parentMissionId: MissionIdSchema,
      childMissionId: MissionIdSchema,
      parentTaskId: z.string().max(64),
      childLedgerTip: Sha256HexSchema,
      childRecordCount: z.number().int().min(1),
      evidenceRefs: z.array(Sha256HexSchema).max(64),
      budgetConsumed: z
        .object({
          plannerTurns: z.number().int().min(0),
          modelCalls: z.number().int().min(0),
          tokensIn: z.number().int().min(0),
          tokensOut: z.number().int().min(0),
          capabilityCalls: z.number().int().min(0),
          retries: z.number().int().min(0),
          executionTimeMs: z.number().int().min(0),
          artifactBytes: z.number().int().min(0),
        })
        .strict(),
      status: z.enum(["succeeded", "failed", "inconclusive"]),
      receiptDigest: Sha256HexSchema,
    })
    .strict(),
  "delegation.receipt_rejected": z
    .object({
      receiptId: z.string().max(64),
      delegationId: DelegationIdSchema,
      parentMissionId: MissionIdSchema,
      childMissionId: MissionIdSchema,
      reasonCode: z.string().max(64),
      detail: z.string().max(2000),
    })
    .strict(),
  "delegation.budget_reconciled": z
    .object({
      delegationId: DelegationIdSchema,
      parentMissionId: MissionIdSchema,
      childMissionId: MissionIdSchema,
      escrowedBudget: DelegationBudgetSchema,
      actualConsumed: z
        .object({
          tokens: z.number().int().min(0),
          modelCalls: z.number().int().min(0),
          capabilityCalls: z.number().int().min(0),
          executionTimeMs: z.number().int().min(0),
        })
        .strict(),
      refundedTokens: z.number().int().min(0),
      newAvailableTokens: z.number().int().min(0),
    })
    .strict(),
  "delegation.cancelled": z
    .object({
      delegationId: DelegationIdSchema,
      childMissionId: MissionIdSchema,
      reason: z.string().max(2000),
      cancelledBy: z.enum(["parent", "runtime", "user"]),
    })
    .strict(),
};

/** Validated body access for the codec/ledger: parse a body against its kind's
 *  schema. Throws a zod error on invalid input. */
export function parseBody<K extends RecordKind>(kind: K, body: unknown): RecordBodyMap[K] {
  return bodySchemas[kind].parse(body) as RecordBodyMap[K];
}

// ---------------------------------------------------------------------------
// Record envelope + union.
// ---------------------------------------------------------------------------

export interface RecordBase<K extends RecordKind> {
  id: RecordId;
  missionId: MissionId;
  seq: Seq;
  kind: K;
  author: Author;
  ts: Iso8601;
  refs: RecordId[];
  prevHash: Sha256Hex | null; // null only for seq=1
  hash: Sha256Hex;
}

type RecordOf<K extends RecordKind> = RecordBase<K> & { body: RecordBodyMap[K] };

/** The Record union: exactly one shape per kind, discriminated on `kind`.
 *  (Named ForgeRecord to avoid shadowing TypeScript's Record utility inside
 *  this module; contracts/index re-exports it as `Record` for consumers.) */
export type ForgeRecord = { [K in RecordKind]: RecordOf<K> }[RecordKind];

const RecordEnvelopeSchema = z.object({
  id: RecordIdSchema,
  missionId: MissionIdSchema,
  seq: SeqSchema,
  kind: RecordKindSchema,
  author: AuthorSchema,
  ts: Iso8601Schema,
  refs: z.array(RecordIdSchema).max(128),
  prevHash: Sha256HexSchema.nullable(),
  hash: Sha256HexSchema,
});

/** The record before its hash exists (append-time validation). */
export const RecordCoreSchema = RecordEnvelopeSchema.omit({ hash: true });

export const RecordSchema: Schema<ForgeRecord> = z.discriminatedUnion(
  "kind",
  (Object.keys(bodySchemas) as RecordKind[]).map((kind) =>
    RecordEnvelopeSchema.extend({ kind: z.literal(kind), body: bodySchemas[kind] }).strict(),
  ) as never,
) as unknown as Schema<ForgeRecord>;

// ---------------------------------------------------------------------------
// Authorship matrix (C-2 / INV-1 / INV-4).
// ---------------------------------------------------------------------------

export type AuthorClass = Author;

export const AUTHORSHIP: Readonly<Record<RecordKind, readonly Author[]>> = {
  "mission.opened": ["runtime"],
  "mission.directive": ["user"],
  "mission.goal-revised": ["runtime", "user"],
  "mission.stage-summary": ["runtime"],
  "mission.closed": ["runtime"],
  "plan.proposed": ["model", "runtime"], // runtime ⇒ quick-lane policy-derived plan (ADR-007 #12)
  "plan.confirmed": ["runtime"],
  "plan.revised": ["runtime"],
  "stage.completed": ["runtime"],
  "criterion.defined": ["model", "user"],
  "grant.issued": ["runtime"],
  "grant.requested": ["runtime"],
  "grant.decided": ["user"],
  "grant.revoked": ["runtime"],
  "proposal.received": ["model", "runtime"], // runtime ⇒ verifier-initiated (ADR-007 #9); still Gate-checked
  "proposal.validated": ["runtime"],
  "proposal.dispatched": ["runtime"],
  "observation.shell": ["runtime"],
  "observation.fs": ["runtime"],
  "observation.git": ["runtime"],
  "observation.http": ["runtime"],
  "observation.search": ["runtime"],
  "observation.web_search": ["runtime"],
  "observation.web_fetch": ["runtime"],
  "observation.mcp": ["runtime"],
  "observation.mcp_server_start": ["runtime"],
  "observation.mcp_server_stop": ["runtime"],
  "observation.doc_parse": ["runtime"],
  "observation.verify": ["runtime"],
  "observation.artifact": ["runtime"],
  "observation.interrupted": ["runtime"],
  "claim.asserted": ["model"],
  "claim.rejected": ["runtime"],
  "verdict.recorded": ["runtime"],
  "engine.error": ["runtime"],
  "security.note": ["runtime"],
  "mission.created": ["runtime"],
  "mission.state_changed": ["runtime"],
  "plan.accepted": ["runtime"],
  "task.started": ["runtime"],
  "task.completed": ["runtime"],
  "task.failed": ["runtime"],
  "task.retry_scheduled": ["runtime"],
  "verification.started": ["runtime"],
  "verification.completed": ["runtime"],
  "checkpoint.created": ["runtime"],
  "mission.completed": ["runtime"],
  "mission.failed": ["runtime"],
  "mission.cancelled": ["runtime", "user"],
  "model.requested": ["runtime"],
  "model.completed": ["runtime"],
  "model.failed": ["runtime"],
  "decision.generated": ["runtime"],
  "decision.rejected": ["runtime"],
  "autonomy.policy_evaluated": ["runtime"],
  "budget.updated": ["runtime"],
  "mission.paused": ["runtime"],
  "mission.resumed": ["runtime"],
  "delegation.proposed": ["runtime", "model"],
  "delegation.authorized": ["runtime"],
  "delegation.activated": ["runtime"],
  "delegation.reincarnated": ["runtime"],
  "delegation.revoked": ["runtime", "user"],
  "delegation.receipt_verified": ["runtime"],
  "delegation.receipt_rejected": ["runtime"],
  "delegation.budget_reconciled": ["runtime"],
  "delegation.cancelled": ["runtime", "user"],
};

/** C-2: is this (kind, author) pair constructible? Applies the matrix plus the
 *  criterion.defined origin↔author consistency rule. */
export function authorshipAllows(kind: RecordKind, author: Author, body?: unknown): boolean {
  const allowed = AUTHORSHIP[kind];
  if (!allowed.includes(author)) return false;
  if (kind === "criterion.defined" && body !== undefined) {
    const origin = (body as { origin?: string }).origin;
    if (author === "model" && origin !== "model-proposed") return false;
    if (author === "user" && origin !== "user") return false;
  }
  return true;
}
