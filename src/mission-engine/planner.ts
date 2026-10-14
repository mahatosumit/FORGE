// FORGE Autonomous Mission Planner (Step 4)
// Provider-neutral planner interface, deterministic heuristic planner for tests & offline runs,
// and model-driven autonomous planner.

import { ulidBody, type Iso8601 } from "../contracts/base.js";
import { ProposalSchema, type Proposal } from "../contracts/proposals.js";
import type {
  Plan,
  Milestone,
  Task,
  TaskFailureRecord,
} from "../contracts/plan.js";
import type {
  Planner,
  PlannerContext,
  ProposalAction,
  FailureDiagnosis,
} from "./types.js";
import { getReadyTasks } from "./scheduler.js";

function nowIso(): Iso8601 {
  return new Date().toISOString() as Iso8601;
}

export function newPlanId(): string {
  return `pln_${ulidBody()}`;
}

export function newMilestoneId(): string {
  return `mls_${ulidBody()}`;
}

export function newTaskId(): string {
  return `tsk_${ulidBody()}`;
}

/**
 * Deterministic heuristic planner.
 * Decomposes intents into structured milestones and tasks,
 * and proposes concrete, schema-valid proposals.
 */
export class DeterministicPlanner implements Planner {
  constructor(private readonly customPlanFactory?: (ctx: PlannerContext) => Plan) {}

  async generatePlan(context: PlannerContext): Promise<Plan> {
    if (this.customPlanFactory) {
      return this.customPlanFactory(context);
    }

    const planId = newPlanId();
    const intent = context.mission.intent.toLowerCase();

    // 1. Doc-processing intent
    if (intent.includes("parse") || intent.includes("pdf") || intent.includes("docx") || intent.includes("document")) {
      const m1Id = newMilestoneId();
      const t1Id = newTaskId();
      return {
        planId,
        missionId: context.mission.missionId,
        version: 1,
        objective: context.mission.intent,
        assumptions: ["Document file exists in workspace"],
        milestones: [
          {
            milestoneId: m1Id,
            objective: "Ingest and parse target document",
            dependencies: [],
            status: "pending",
            successCriteria: ["document parsed successfully"],
            verificationCriteria: [],
            tasks: [
              {
                taskId: t1Id,
                milestoneId: m1Id,
                title: "Parse document",
                description: "Extract structured text and metadata from document",
                capability: "doc_parse",
                args: { path: "sample.pdf", mode: "structured" },
                dependsOn: [],
                status: "pending",
                attempt: 0,
                maxAttempts: 3,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
        ],
        dependencies: {},
        verificationStrategy: "mechanical doc_parse status check",
        createdAt: nowIso(),
        supersedesPlanId: null,
        immutable: true,
      };
    }

    // 2. Web research intent
    if (intent.includes("web") || intent.includes("search") || intent.includes("fetch")) {
      const m1Id = newMilestoneId();
      const t1Id = newTaskId();
      return {
        planId,
        missionId: context.mission.missionId,
        version: 1,
        objective: context.mission.intent,
        assumptions: ["Network is accessible"],
        milestones: [
          {
            milestoneId: m1Id,
            objective: "Perform web search",
            dependencies: [],
            status: "pending",
            successCriteria: ["web search returned relevant results"],
            verificationCriteria: [],
            tasks: [
              {
                taskId: t1Id,
                milestoneId: m1Id,
                title: "Search web",
                description: "Execute governed web search",
                capability: "web_search",
                args: { query: context.mission.intent.slice(0, 50) },
                dependsOn: [],
                status: "pending",
                attempt: 0,
                maxAttempts: 3,
                evidenceRefs: [],
                error: null,
              },
            ],
          },
        ],
        dependencies: {},
        verificationStrategy: "mechanical web_search observation check",
        createdAt: nowIso(),
        supersedesPlanId: null,
        immutable: true,
      };
    }

    // 3. Default workspace inspection and verification intent
    const m1Id = newMilestoneId();
    const t1Id = newTaskId();
    return {
      planId,
      missionId: context.mission.missionId,
      version: 1,
      objective: context.mission.intent,
      assumptions: ["Workspace is initialized"],
      milestones: [
        {
          milestoneId: m1Id,
          objective: "Workspace discovery and check",
          dependencies: [],
          status: "pending",
          successCriteria: ["workspace inspected"],
          verificationCriteria: [],
          tasks: [
            {
              taskId: t1Id,
              milestoneId: m1Id,
              title: "Search workspace",
              description: "Inspect workspace files",
              capability: "search",
              args: { query: "package.json", mode: "grep" },
              dependsOn: [],
              status: "pending",
              attempt: 0,
              maxAttempts: 3,
              evidenceRefs: [],
              error: null,
            },
          ],
        },
      ],
      dependencies: {},
      verificationStrategy: "mechanical observation check",
      createdAt: nowIso(),
      supersedesPlanId: null,
      immutable: true,
    };
  }

  async proposeNextAction(context: PlannerContext): Promise<ProposalAction> {
    if (!context.plan || !context.currentMilestone) {
      return { type: "fail", reason: "No active plan or milestone in planner context" };
    }

    const runningTask = context.currentMilestone.tasks.find((t) => t.status === "running");
    const readyTasks = getReadyTasks(context.currentMilestone, context.plan.milestones);
    const task = runningTask ?? readyTasks[0];
    if (!task) {
      return { type: "complete", summary: "All ready tasks in current milestone executed" };
    }

    // Construct valid proposal based on task capability and args
    const rawProposal = {
      capability: task.capability,
      args: task.args,
    };

    let proposal: Proposal;
    try {
      proposal = ProposalSchema.parse(rawProposal);
    } catch (err) {
      return {
        type: "replan",
        reason: `Invalid proposal arguments for task ${task.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      type: "execute_task",
      task,
      proposal,
      meta: {
        rationale: `Executing scheduled task: ${task.title} (${task.description})`,
        citations: [],
      },
    };
  }

  async diagnoseFailure(
    _context: PlannerContext,
    task: Task,
    failure: TaskFailureRecord,
  ): Promise<FailureDiagnosis> {
    if (failure.errorCategory === "security_violation") {
      return {
        category: "security_violation",
        rootCause: `Unauthorized capability call or path traversal in task ${task.taskId}`,
        recommendation: "escalate",
        suggestedRemediation: "Request broader grants or modify task parameters to stay within permitted boundary.",
      };
    }

    if (failure.errorCategory === "transient") {
      return {
        category: "transient",
        rootCause: "Temporary network, service, or rate limit interruption",
        recommendation: "retry",
        suggestedRemediation: "Retry with exponential backoff delay.",
      };
    }

    if (task.attempt >= task.maxAttempts) {
      return {
        category: failure.errorCategory,
        rootCause: `Task ${task.taskId} reached max attempts (${task.maxAttempts}) without success`,
        recommendation: "replan",
        suggestedRemediation: "Revise plan with alternate approach or intermediate steps.",
      };
    }

    return {
      category: failure.errorCategory,
      rootCause: failure.errorMessage,
      recommendation: "retry",
      suggestedRemediation: "Retry task with refreshed environment state.",
    };
  }
}
