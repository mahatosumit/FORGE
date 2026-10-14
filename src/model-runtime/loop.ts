// FORGE Model Runtime — Autonomous Reasoning Loop (Step 5)
// Connects the governed mission engine to real model providers and creates
// a continuously operating autonomous reasoning/execution loop.
//
// Invariant:
// Model -> Context -> ModelDecision -> Autonomy Policy -> Proposal -> Authority Gate ->
// Capability Host -> Evidence Capture -> Ledger -> Mechanical Verification -> State Update -> Loop.

import { readFileSync } from "node:fs";
import type { Proposal, ProposalMeta } from "../contracts/proposals.js";
import type { Grant } from "../contracts/grants.js";
import type { SecretName } from "../contracts/base.js";
import type { MissionId, MissionModel, AutonomyLevel, CriterionExpr, Sha256Hex, Iso8601 } from "../contracts/index.js";
import { CriterionExprSchema } from "../contracts/records.js";
import type { Plan, Milestone, Task } from "../contracts/plan.js";
import { CapabilityHost } from "../capability-host/host.js";
import { builtinCapabilities, CapabilityRegistry, createDefaultCapabilityRegistry } from "../capabilities/index.js";
import { evaluateProposal, type GateVerdict, type PathResolver } from "../gate/gate.js";
import { GrantStore } from "../grants/grants.js";
import { LocalEnvironment, sha256Hex } from "../environments/local.js";
import { AutonomousMissionStore } from "../mission-engine/store.js";
import { VerificationEngine } from "../mission-engine/verifier.js";
import { FailureAnalyzer } from "../mission-engine/retry.js";
import { getReadyTasks, isMilestoneComplete, getNextActiveMilestone } from "../mission-engine/scheduler.js";
import { MissionBudgetExceededError, MissionSecurityViolationError } from "../mission-engine/types.js";
import { ContextBuilder } from "./context-builder.js";
import { parseModelDecision, type ModelDecision } from "./decision.js";
import { AutonomyPolicyEngine } from "./autonomy-policy.js";
import type { ModelRouter } from "./router.js";
import type { MissionSnapshot } from "../mission-engine/types.js";

function nowIso(): Iso8601 {
  return new Date().toISOString() as Iso8601;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function replaceAllBytes(bytes: Uint8Array, needle: Uint8Array, replacement: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i <= bytes.length - needle.length) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) {
      parts.push(bytes.subarray(0, i), replacement);
      const rest = replaceAllBytes(bytes.subarray(i + needle.length), needle, replacement);
      parts.push(rest);
      return concatBytes(parts);
    }
    i++;
  }
  return bytes;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export interface AutonomousReasoningLoopOptions {
  store: AutonomousMissionStore;
  grantStore: GrantStore;
  router: ModelRouter;
  workspaceRoot: string;
  registry?: CapabilityRegistry;
  onApproval?: (decision: ModelDecision, proposal: Proposal) => Promise<boolean>;
  onEscalation?: (request: {
    missionId: string;
    requestId: string;
    capability: string;
    requested: Grant["constraints"];
    rationale: string;
    citations: string[];
  }) => Promise<{ decision: "extend" | "deny"; expiresAt: string | null }>;
  secrets?: { resolve(name: SecretName): string | null };
}

export class AutonomousReasoningLoop {
  private isPaused = false;
  private isCancelled = false;
  public readonly registry: CapabilityRegistry;

  constructor(private readonly opts: AutonomousReasoningLoopOptions) {
    this.registry = opts.registry ?? createDefaultCapabilityRegistry();
  }

  /**
   * Runs the autonomous reasoning loop until the mission completes, fails, pauses, or cancels.
   */
  async runLoop(signal?: AbortSignal): Promise<MissionSnapshot> {
    const { store, grantStore, router, workspaceRoot } = this.opts;
    const startTime = Date.now();
    const effSignal = signal ?? new AbortController().signal;

    const env = new LocalEnvironment(workspaceRoot);
    const host = this.makeHost(store, grantStore);
    const verifier = new VerificationEngine(
      env,
      (sha) => {
        const p = store.ledgerStore.ledger.artifactPath(sha);
        return p ? new Uint8Array(readFileSync(p)) : null;
      },
      (bytes) => {
        const sha = sha256Hex(bytes) as Sha256Hex;
        store.ledgerStore.ledger.writeArtifact(bytes, sha);
        return sha;
      },
      async (argv, sig) => {
        const verifyProposal: Proposal = {
          capability: "shell",
          args: { argv: argv as any, cwd: "." as any },
        };
        const meta: ProposalMeta = {
          rationale: "mechanical verification check",
          citations: [],
        };
        const dispatchResult = await this.dispatchProposal(
          store,
          grantStore,
          host,
          verifyProposal,
          meta,
          sig ?? effSignal,
        );
        if ("observation" in dispatchResult) {
          const obsBody = dispatchResult.observation.body as any;
          return { exit: obsBody.exit ?? null, evidenceRef: obsBody.outputRef };
        }
        return { exit: null };
      },
    );

    // Initial transition if created
    if (store.getMission().status === "created") {
      store.transitionState("planning", "Initial plan synthesis");
      store.transitionState("planned", "Plan ready");
      store.transitionState("executing", "Commencing autonomous reasoning loop");
    } else if (store.getMission().status === "paused") {
      store.transitionState("executing", "Resuming from paused state");
    }

    while (store.getMission().status === "executing") {
      if (effSignal.aborted || this.isCancelled) {
        store.transitionState("cancelled", "Execution cancelled via external signal");
        store.appendRecord("mission.cancelled", { reason: "Aborted via signal", cancelledBy: "user" }, [], "user");
        break;
      }

      if (this.isPaused) {
        break;
      }

      // 1. Hard Budget Enforcement
      this.checkHardBudgets(store, startTime);

      const plan = store.getActivePlan();
      if (!plan) {
        store.transitionState("failed", "No active plan found during autonomous reasoning loop");
        store.appendRecord("mission.failed", { reason: "No active plan", failedTaskId: null, errorCategory: "planner_error" });
        break;
      }

      // 2. Identify active milestone
      let currentMilestoneId = store.getMission().currentMilestoneId;
      let milestone = plan.milestones.find((m) => m.milestoneId === currentMilestoneId) ?? null;

      if (!milestone || milestone.status === "succeeded" || milestone.status === "skipped") {
        const nextMilestone = getNextActiveMilestone(plan);
        if (!nextMilestone) {
          // All milestones succeeded! Transition to verifying
          store.transitionState("verifying", "All milestones succeeded; verifying mission criteria");
          break;
        }
        milestone = nextMilestone;
        store.setCurrentMilestoneId(milestone.milestoneId);
        store.updateMilestoneState(milestone.milestoneId, (m) => {
          m.status = "in_progress";
        });
      }

      // Check if current milestone tasks are all complete
      if (isMilestoneComplete(milestone)) {
        const milestoneCheck = await verifier.verifyMilestone(milestone);
        if (milestoneCheck.passed) {
          store.updateMilestoneState(milestone.milestoneId, (m) => {
            m.status = "succeeded";
          });
          store.createCheckpoint(`chk_mls_${milestone.milestoneId}`);
          continue;
        } else {
          store.updateMilestoneState(milestone.milestoneId, (m) => {
            m.status = "failed";
          });
          store.transitionState("failed", `Milestone ${milestone.milestoneId} verification failed`);
          store.appendRecord("mission.failed", {
            reason: milestoneCheck.reason ?? "Milestone verification failed",
            failedTaskId: null,
            errorCategory: "verification_failure",
          });
          break;
        }
      }

      // 3. Select ready task
      const readyTasks = getReadyTasks(milestone, plan.milestones);
      if (readyTasks.length === 0) {
        store.transitionState("failed", "No ready tasks remaining in active milestone");
        store.appendRecord("mission.failed", {
          reason: "Scheduler deadlock",
          failedTaskId: null,
          errorCategory: "planner_error",
        });
        break;
      }

      const task = readyTasks[0]!;
      const taskStartMs = Date.now();

      // Mark task running and emit task.started
      store.updateTaskState(task.taskId, (t) => {
        t.status = "running";
        t.attempt++;
      });
      store.appendRecord("task.started", {
        taskId: task.taskId,
        milestoneId: task.milestoneId,
        capability: task.capability,
        attempt: task.attempt,
      });

      // 4. Governed Context Assembly (INV-14 isolation)
      const contextReq = ContextBuilder.buildContext({
        mission: store.getMission(),
        plan,
        milestone,
        task,
        activeGrants: grantStore.active(),
        recentObservations: store.ledgerStore.read().slice(-12),
        availableCapabilities: Array.from(this.registry.list().map((c) => c.manifest.id)),
        registry: this.registry,
        budgetRemaining: {
          maxPlannerTurns: Math.max(0, store.getMission().budget.maxPlannerTurns - store.getMission().budgetConsumed.plannerTurns),
          maxModelCalls: Math.max(0, store.getMission().budget.maxModelCalls - store.getMission().budgetConsumed.modelCalls),
          maxTokens: Math.max(0, store.getMission().budget.maxTokens - (store.getMission().budgetConsumed.tokensIn + store.getMission().budgetConsumed.tokensOut)),
          maxCapabilityCalls: Math.max(0, store.getMission().budget.maxCapabilityCalls - store.getMission().budgetConsumed.capabilityCalls),
          maxRetries: Math.max(0, store.getMission().budget.maxRetries - store.getMission().budgetConsumed.retries),
          maxExecutionTimeMs: Math.max(0, store.getMission().budget.maxExecutionTimeMs - store.getMission().budgetConsumed.executionTimeMs),
          maxArtifactBytes: Math.max(0, store.getMission().budget.maxArtifactBytes - store.getMission().budgetConsumed.artifactBytes),
          maxConcurrentTasks: 1,
          maxDelegationDepth: store.getMission().budget.maxDelegationDepth,
        },
        signal: effSignal,
      });

      store.getMission().budgetConsumed.plannerTurns++;

      // 5. Invoke Model through ModelRouter
      let modelResponse;
      try {
        modelResponse = await router.invokeModel(contextReq, task, store);
      } catch (err) {
        // Model failure classified
        const errCategory = FailureAnalyzer.classifyError(err, task.capability);
        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
        });
        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory: errCategory,
          errorMessage: err instanceof Error ? err.message : String(err),
          attempt: task.attempt,
          retryable: false,
        });
        store.transitionState("failed", `Model invocation error: ${err instanceof Error ? err.message : String(err)}`);
        store.appendRecord("mission.failed", {
          reason: err instanceof Error ? err.message : String(err),
          failedTaskId: task.taskId,
          errorCategory: errCategory,
        });
        break;
      }

      // 6. Structured Model Decision Parsing & Validation
      const parsedDecision = parseModelDecision(modelResponse.text);

      if (!parsedDecision.ok || !parsedDecision.decision) {
        // Controlled schema validation error
        store.appendRecord("decision.rejected", {
          taskId: task.taskId,
          reason: parsedDecision.error ?? "Failed to parse model decision",
          validationErrors: parsedDecision.validationErrors ?? [],
        });

        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
        });
        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory: "validation_error",
          errorMessage: parsedDecision.error ?? "Malformed model decision",
          attempt: task.attempt,
          retryable: false,
        });

        store.transitionState("failed", `Model output schema validation failed: ${parsedDecision.error}`);
        store.appendRecord("mission.failed", {
          reason: parsedDecision.error ?? "Invalid model decision",
          failedTaskId: task.taskId,
          errorCategory: "validation_error",
        });
        break;
      }

      const decision = parsedDecision.decision;

      // Record valid decision in ledger
      store.appendRecord("decision.generated", {
        taskId: task.taskId,
        decisionType: decision.decisionType,
        hasProposal: decision.proposal !== undefined,
        capability: decision.proposal ? decision.proposal.capability : null,
        rationale: decision.analysis,
      });

      // Handle Pause decision
      if (decision.decisionType === "pause") {
        store.updateTaskState(task.taskId, (t) => {
          t.status = "pending";
          t.attempt = Math.max(0, t.attempt - 1);
        });
        await this.pauseMission("Model requested pause");
        break;
      }

      // Handle Fail Task decision
      if (decision.decisionType === "fail_task") {
        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
        });
        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory: "planner_error",
          errorMessage: decision.analysis,
          attempt: task.attempt,
          retryable: false,
        });
        store.transitionState("failed", `Model signaled failure: ${decision.analysis}`);
        store.appendRecord("mission.failed", {
          reason: decision.analysis,
          failedTaskId: task.taskId,
          errorCategory: "planner_error",
        });
        break;
      }

      // Handle Replan decision
      if (decision.decisionType === "replan") {
        store.transitionState("planning", `Replanning: ${decision.planRevision?.reason ?? decision.analysis}`);
        // Create revision $v+1
        const revisedPlan: Plan = {
          ...plan,
          version: plan.version + 1,
          supersedesPlanId: plan.planId,
          createdAt: nowIso(),
        };
        store.acceptPlan(revisedPlan);
        store.transitionState("executing", "Resumed execution under revised plan");
        continue;
      }

      // Handle Complete Task decision
      if (decision.decisionType === "complete_task" && !decision.proposal) {
        store.updateTaskState(task.taskId, (t) => {
          t.status = "succeeded";
        });
        store.appendRecord("task.completed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          evidenceRefs: [],
          durationMs: Date.now() - taskStartMs,
        });
        continue;
      }

      // 7. Autonomy Policy Evaluation
      const proposal = decision.proposal!;
      const policyLevel = store.getMission().riskPolicy.autonomyLevel;
      const policyDecision = AutonomyPolicyEngine.evaluatePolicy(
        policyLevel,
        proposal,
        grantStore.active(),
      );

      store.appendRecord("autonomy.policy_evaluated", {
        level: policyDecision.level,
        proposalCapability: proposal.capability,
        requiresApproval: policyDecision.requiresApproval,
        approved: policyDecision.approved,
        reason: policyDecision.reason,
      });

      if (policyDecision.requiresApproval && !policyDecision.approved) {
        if (this.opts.onApproval) {
          const userApproved = await this.opts.onApproval(decision, proposal);
          if (!userApproved) {
            store.transitionState("blocked", `Proposal rejected by user approval under policy ${policyLevel}`);
            break;
          }
        } else {
          store.transitionState("blocked", `Policy ${policyLevel} requires operator approval for "${proposal.capability}"`);
          break;
        }
      }

      // 8. Authority Gate Evaluation & Dispatch
      const meta: ProposalMeta = decision.meta ?? {
        rationale: decision.analysis,
        citations: [],
      };

      let dispatchResult;
      try {
        dispatchResult = await this.dispatchProposal(
          store,
          grantStore,
          host,
          proposal,
          meta,
          effSignal,
        );
      } catch (err) {
        const category = FailureAnalyzer.classifyError(err, task.capability);
        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
        });
        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory: category,
          errorMessage: err instanceof Error ? err.message : String(err),
          attempt: task.attempt,
          retryable: false,
        });
        store.transitionState("failed", `Capability execution threw: ${err instanceof Error ? err.message : String(err)}`);
        store.appendRecord("mission.failed", {
          reason: err instanceof Error ? err.message : String(err),
          failedTaskId: task.taskId,
          errorCategory: category,
        });
        break;
      }

      const taskDurationMs = Date.now() - taskStartMs;
      store.getMission().budgetConsumed.executionTimeMs = Date.now() - startTime;

      if ("rejected" in dispatchResult) {
        // Gate rejection is a non-retryable security violation
        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
        });
        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory: "security_violation",
          errorMessage: dispatchResult.rejected,
          attempt: task.attempt,
          retryable: false,
        });
        store.transitionState("failed", `Authority gate rejected task: ${dispatchResult.rejected}`);
        store.appendRecord("mission.failed", {
          reason: dispatchResult.rejected,
          failedTaskId: task.taskId,
          errorCategory: "security_violation",
        });
        break;
      }

      if ("escalated" in dispatchResult) {
        store.transitionState("blocked", "Proposal required unapproved grant escalation");
        break;
      }

      if ("observation" in dispatchResult) {
        const observation = dispatchResult.observation;
        store.getMission().budgetConsumed.capabilityCalls++;

        // 9. Mechanical Verification (Zero Trust)
        store.appendRecord("verification.started", {
          targetId: task.taskId,
          targetType: "task",
          criteria: [task.capability],
        });

        const taskVerification = await verifier.verifyTask(task, observation);

        store.appendRecord("verification.completed", {
          targetId: task.taskId,
          targetType: "task",
          passed: taskVerification.passed,
          evidenceRefs: taskVerification.evidenceRefs,
          reason: taskVerification.reason,
        });

        if (taskVerification.passed) {
          store.updateTaskState(task.taskId, (t) => {
            t.status = "succeeded";
            t.evidenceRefs = taskVerification.evidenceRefs;
          });

          store.appendRecord("task.completed", {
            taskId: task.taskId,
            milestoneId: task.milestoneId,
            capability: task.capability,
            evidenceRefs: taskVerification.evidenceRefs,
            durationMs: taskDurationMs,
          });
        } else {
          // Failure handling & retry evaluation
          const category = FailureAnalyzer.classifyError(
            new Error(taskVerification.reason ?? "Task verification failed"),
            task.capability,
          );

          const remainingBudget = {
            ...store.getMission().budget,
            maxRetries: store.getMission().budget.maxRetries - store.getMission().budgetConsumed.retries,
          };

          const retryEval = FailureAnalyzer.evaluateRetry(
            task,
            category,
            remainingBudget,
            taskVerification.reason ?? "Task verification failure",
          );

          if (retryEval.retryable) {
            store.getMission().budgetConsumed.retries++;
            store.appendRecord("task.retry_scheduled", {
              taskId: task.taskId,
              attempt: task.attempt,
              delayMs: retryEval.delayMs,
              reason: retryEval.reason,
            });

            store.updateTaskState(task.taskId, (t) => {
              t.status = "ready";
            });

            if (retryEval.delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, retryEval.delayMs));
            }
          } else {
            store.updateTaskState(task.taskId, (t) => {
              t.status = "failed";
            });

            store.appendRecord("task.failed", {
              taskId: task.taskId,
              milestoneId: task.milestoneId,
              capability: task.capability,
              errorCategory: category,
              errorMessage: retryEval.reason,
              attempt: task.attempt,
              retryable: false,
            });

            store.transitionState("failed", `Task permanently failed: ${retryEval.reason}`);
            store.appendRecord("mission.failed", {
              reason: retryEval.reason,
              failedTaskId: task.taskId,
              errorCategory: category,
            });
            break;
          }
        }
      }
    }

    // 10. Mission-Level Verification
    if (store.getMission().status === "verifying") {
      const criteria = store.getMission().goalSpec.proposedCriteria;
      store.appendRecord("verification.started", {
        targetId: store.getMission().missionId,
        targetType: "mission",
        criteria: criteria.map((c) => c.kind),
      });

      const missionCheck = await verifier.verifyMission(store.getMission(), criteria);

      store.appendRecord("verification.completed", {
        targetId: store.getMission().missionId,
        targetType: "mission",
        passed: missionCheck.passed,
        evidenceRefs: missionCheck.evidenceRefs,
        reason: missionCheck.reason,
      });

      if (missionCheck.passed) {
        store.transitionState("completed", "All criteria mechanically verified");
        const totalCompleted = this.countCompletedTasks(store);
        const durationMs = Date.now() - startTime;
        const chainTip = store.getChainTip() ?? ("0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex);

        store.appendRecord("mission.completed", {
          summary: "Autonomous mission completed and mechanically verified",
          totalTasksCompleted: totalCompleted,
          durationMs,
          chainTip,
        });
      } else {
        store.transitionState("failed", `Mission verification failed: ${missionCheck.reason}`);
        store.appendRecord("mission.failed", {
          reason: missionCheck.reason ?? "Verification failed",
          failedTaskId: null,
          errorCategory: "verification_failure",
        });
      }
    }

    store.getMission().budgetConsumed.executionTimeMs = Date.now() - startTime;
    return this.createSnapshot(store);
  }

  /**
   * Pauses the mission and writes a durable checkpoint.
   */
  async pauseMission(reason: string = "Operator paused"): Promise<MissionSnapshot> {
    this.isPaused = true;
    const store = this.opts.store;
    if (store.getMission().status === "executing") {
      const plan = store.getActivePlan();
      if (plan) {
        for (const m of plan.milestones) {
          for (const t of m.tasks) {
            if (t.status === "running") {
              store.updateTaskState(t.taskId, (task) => {
                task.status = "pending";
                task.attempt = Math.max(0, task.attempt - 1);
              });
            }
          }
        }
      }
      const chk = store.createCheckpoint(`chk_pause_${Date.now()}`);
      store.transitionState("paused", reason);
      store.appendRecord("mission.paused", {
        reason,
        checkpointId: chk.checkpointId,
      });
    }
    return this.createSnapshot(store);
  }

  /**
   * Resumes a paused or interrupted mission.
   */
  async resumeMission(signal?: AbortSignal): Promise<MissionSnapshot> {
    this.isPaused = false;
    const store = this.opts.store;
    if (store.getMission().status === "paused" || store.getMission().status === "blocked") {
      const plan = store.getActivePlan();
      if (plan) {
        for (const m of plan.milestones) {
          for (const t of m.tasks) {
            if (t.status === "running") {
              store.updateTaskState(t.taskId, (task) => {
                task.status = "pending";
                task.attempt = Math.max(0, task.attempt - 1);
              });
            }
          }
        }
      }
      const lastCheckpoint = store.getCheckpoints().slice(-1)[0];
      store.appendRecord("mission.resumed", {
        fromCheckpointId: lastCheckpoint ? lastCheckpoint.checkpointId : null,
        resumedAt: nowIso(),
      });
      store.transitionState("executing", "Mission resumed by operator");
      return this.runLoop(signal);
    }
    return this.createSnapshot(store);
  }

  /**
   * Cancels a mission.
   */
  async cancelMission(reason: string = "Operator cancelled"): Promise<MissionSnapshot> {
    this.isCancelled = true;
    const store = this.opts.store;
    store.transitionState("cancelled", reason);
    store.appendRecord("mission.cancelled", { reason, cancelledBy: "user" }, [], "user");
    return this.createSnapshot(store);
  }

  private async dispatchProposal(
    store: AutonomousMissionStore,
    grants: GrantStore,
    host: CapabilityHost,
    proposal: Proposal,
    meta: ProposalMeta,
    signal: AbortSignal,
  ): Promise<{ observation: any } | { escalated: true } | { rejected: string }> {
    const received = store.appendRecord("proposal.received", { proposal, meta });
    const pid = received.id;

    const activeGrants = grants.active();
    const mission = store.getMission();
    const remainingCalls = mission.budget.maxCapabilityCalls - mission.budgetConsumed.capabilityCalls;
    const remainingArtifactBytes = mission.budget.maxArtifactBytes - mission.budgetConsumed.artifactBytes;
    const remainingExecutionTimeMs = mission.budget.maxExecutionTimeMs - mission.budgetConsumed.executionTimeMs;

    const verdict = evaluateProposal(proposal, meta, {
      grants: activeGrants,
      resolvePath: this.pathResolver(),
      registry: this.registry,
      missionBudget: {
        remainingCalls,
        remainingArtifactBytes,
        remainingExecutionTimeMs,
      },
    });

    if (verdict.type === "reject") {
      store.appendRecord("proposal.validated", {
        proposalId: pid,
        result: verdict.reasonCode === "rejected-schema" ? "rejected-schema" : "rejected-gate",
        reasonCode: verdict.reasonCode,
      });
      return { rejected: verdict.detail };
    }

    if (verdict.type === "escalate") {
      store.appendRecord("proposal.validated", {
        proposalId: pid,
        result: "rejected-gate",
        reasonCode: "out-of-grant",
      });

      const req = store.appendRecord("grant.requested", {
        proposalId: pid,
        capability: verdict.request.capability,
        requested: verdict.request.requested,
        rationale: verdict.request.rationale || meta.rationale,
        citations: verdict.request.citations,
      });

      if (this.opts.onEscalation) {
        const decision = await this.opts.onEscalation({
          missionId: store.getMission().missionId,
          requestId: req.id,
          capability: verdict.request.capability,
          requested: verdict.request.requested,
          rationale: verdict.request.rationale || meta.rationale,
          citations: verdict.request.citations,
        });

        if (decision.decision === "extend") {
          store.appendRecord("grant.decided", { requestId: req.id, decision: "extend" }, [], "user");
          const issued = grants.issue({
            capability: verdict.request.capability,
            constraints: verdict.request.requested,
            expiresAt: decision.expiresAt,
            issuer: "escalation",
            parentGrantId: null,
          });

          const v2 = evaluateProposal(proposal, meta, {
            grants: [...activeGrants, issued],
            resolvePath: this.pathResolver(),
            registry: this.registry,
            missionBudget: {
              remainingCalls,
              remainingArtifactBytes,
              remainingExecutionTimeMs,
            },
          });

          if (v2.type !== "allow") return { rejected: "Escalated grant did not satisfy proposal" };

          store.appendRecord("proposal.validated", {
            proposalId: pid,
            result: "accepted",
            reasonCode: "escalated-grant",
            grantId: v2.grantId,
          }, [pid]);

          const obs = await this.executeAllowed(store, grants, host, proposal, v2, pid, signal);
          return { observation: obs };
        }

        store.appendRecord("grant.decided", { requestId: req.id, decision: "deny" }, [], "user");
      }

      return { escalated: true };
    }

    store.appendRecord("proposal.validated", {
      proposalId: pid,
      result: "accepted",
      reasonCode: "in-grant",
      grantId: verdict.grantId,
    }, [pid]);

    const obs = await this.executeAllowed(store, grants, host, proposal, verdict, pid, signal);
    return { observation: obs };
  }

  private async executeAllowed(
    store: AutonomousMissionStore,
    grants: GrantStore,
    host: CapabilityHost,
    proposal: Proposal,
    verdict: GateVerdict & { type: "allow" },
    proposalRecordId: string,
    signal: AbortSignal,
  ): Promise<any> {
    const secretsMap = this.resolveSecrets(grants, verdict.grantId);
    return host.execute(proposal, verdict, proposalRecordId, {
      workspaceRoot: this.opts.workspaceRoot,
      environment: new LocalEnvironment(this.opts.workspaceRoot),
      environmentKind: "local",
      secrets: secretsMap,
      urlAuthority: (url: string) => this.urlWithinGrantScope(grants, verdict.grantId, url),
      capture: (bytes) => {
        let out = bytes;
        for (const value of secretsMap.values()) {
          if (value.length < 4) continue;
          const needle = new TextEncoder().encode(value);
          if (indexOfBytes(out, needle) === -1) continue;
          out = replaceAllBytes(out, needle, new TextEncoder().encode("[REDACTED]"));
        }
        if (
          store.getMission().budgetConsumed.artifactBytes + out.byteLength >
          store.getMission().budget.maxArtifactBytes
        ) {
          throw new MissionBudgetExceededError(
            "maxArtifactBytes",
            store.getMission().budget.maxArtifactBytes,
            store.getMission().budgetConsumed.artifactBytes + out.byteLength,
          );
        }
        const sha = sha256Hex(out) as Sha256Hex;
        store.ledgerStore.ledger.writeArtifact(out, sha);
        store.getMission().budgetConsumed.artifactBytes += out.byteLength;
        return sha;
      },
      artifactBytes: (sha) => {
        const p = store.ledgerStore.ledger.artifactPath(sha);
        return p ? new Uint8Array(readFileSync(p)) : null;
      },
      criterionResolver: (cid) => {
        const rec = store.ledgerStore
          .read()
          .find((r) => r.kind === "criterion.defined" && (r.body as { criterionId?: string }).criterionId === cid);
        return rec ? CriterionExprSchema.parse((rec.body as { expression: unknown }).expression) : null;
      },
      signal,
      isGrantActive: (gid) => grants.active().some((g) => g.id === gid),
    });
  }

  private resolveSecrets(grants: GrantStore, grantId: string): ReadonlyMap<SecretName, string> {
    const grant = grants.active().find((g) => g.id === grantId);
    const names = grant?.constraints.secretNames ?? [];
    const map = new Map<SecretName, string>();
    for (const name of names) {
      const value = this.opts.secrets?.resolve(name) ?? null;
      if (value !== null) map.set(name, value);
    }
    return map;
  }

  private urlWithinGrantScope(grants: GrantStore, grantId: string, url: string): boolean {
    const grant = grants.active().find((g) => g.id === grantId);
    const hosts = grant?.constraints.hosts ?? [];
    if (hosts.length === 0) return false;
    let host: string;
    try { host = new URL(url).host; } catch { return false; }
    return hosts.some((pat) => {
      if (pat.startsWith("*.")) return host === pat.slice(2) || host.endsWith(pat.slice(1));
      return host === pat;
    });
  }

  private pathResolver(): PathResolver {
    const env = new LocalEnvironment(this.opts.workspaceRoot);
    return { resolveReal: (p) => env.resolveReal(p as never) };
  }

  private makeHost(store: AutonomousMissionStore, grants: GrantStore): CapabilityHost {
    return new CapabilityHost({
      capabilities: builtinCapabilities(),
      registry: this.registry,
      isGrantActive: (gid) => grants.active().some((g) => g.id === gid),
      timeoutFor: (m) => (m.id === "shell" || m.id === "git" || m.id === "verify" ? 120_000 : 30_000),
      append: (input) => store.ledgerStore.append({ ...input, ts: nowIso() }),
      environment: (kind) => {
        if (kind === "container") throw new Error("container environment not configured");
        return new LocalEnvironment(this.opts.workspaceRoot);
      },
    });
  }

  private checkHardBudgets(store: AutonomousMissionStore, startTime: number): void {
    const mission = store.getMission();
    const budget = mission.budget;
    const consumed = mission.budgetConsumed;

    if (consumed.modelCalls >= budget.maxModelCalls) {
      throw new MissionBudgetExceededError("maxModelCalls", budget.maxModelCalls, consumed.modelCalls);
    }
    const totalTokens = consumed.tokensIn + consumed.tokensOut;
    if (totalTokens >= budget.maxTokens) {
      throw new MissionBudgetExceededError("maxTokens", budget.maxTokens, totalTokens);
    }
    if (consumed.plannerTurns >= budget.maxPlannerTurns) {
      throw new MissionBudgetExceededError("maxPlannerTurns", budget.maxPlannerTurns, consumed.plannerTurns);
    }
    if (consumed.capabilityCalls >= budget.maxCapabilityCalls) {
      throw new MissionBudgetExceededError("maxCapabilityCalls", budget.maxCapabilityCalls, consumed.capabilityCalls);
    }
    if (consumed.retries >= budget.maxRetries) {
      throw new MissionBudgetExceededError("maxRetries", budget.maxRetries, consumed.retries);
    }
    const elapsedMs = Date.now() - startTime;
    if (elapsedMs >= budget.maxExecutionTimeMs) {
      throw new MissionBudgetExceededError("maxExecutionTimeMs", budget.maxExecutionTimeMs, elapsedMs);
    }
    if (consumed.artifactBytes >= budget.maxArtifactBytes) {
      throw new MissionBudgetExceededError("maxArtifactBytes", budget.maxArtifactBytes, consumed.artifactBytes);
    }
  }

  private countCompletedTasks(store: AutonomousMissionStore): number {
    const plan = store.getActivePlan();
    if (!plan) return 0;
    let count = 0;
    for (const m of plan.milestones) {
      for (const t of m.tasks) {
        if (t.status === "succeeded" || t.status === "skipped") count++;
      }
    }
    return count;
  }

  private createSnapshot(store: AutonomousMissionStore): MissionSnapshot {
    const mission = store.getMission();
    const plan = store.getActivePlan();
    let totalTasks = 0;
    let completedTasks = 0;
    const evidenceRefs: Sha256Hex[] = [];

    if (plan) {
      for (const m of plan.milestones) {
        totalTasks += m.tasks.length;
        for (const t of m.tasks) {
          if (t.status === "succeeded" || t.status === "skipped") {
            completedTasks++;
          }
          for (const ref of t.evidenceRefs) {
            evidenceRefs.push(ref);
          }
        }
      }
    }

    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    return {
      missionId: mission.missionId,
      status: mission.status,
      intent: mission.intent,
      plan,
      currentMilestoneId: mission.currentMilestoneId,
      activeTaskId: null,
      budget: mission.budget,
      budgetConsumed: mission.budgetConsumed,
      completedTasksCount: completedTasks,
      totalTasksCount: totalTasks,
      progressPercent,
      error: null,
      evidenceRefs,
      checkpoints: store.getCheckpoints(),
      ledgerHeadHash: store.getChainTip(),
    };
  }
}
