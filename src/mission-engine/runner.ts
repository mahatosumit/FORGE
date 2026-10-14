// FORGE Autonomous Mission Engine Runner (Step 4)
// End-to-end execution loop strictly enforcing:
// Model/Planner -> Mission State -> Planner -> Proposal -> Authority Gate ->
// Capability Host -> Evidence Capture -> Cryptographic Ledger -> Verification ->
// State Update -> Planner.

import { readFileSync } from "node:fs";
import {
  type CriterionExpr,
  type ForgeRecord,
  CriterionExprSchema,
} from "../contracts/records.js";
import {
  type RecordId,
  type Sha256Hex,
  type Iso8601,
  type MissionId,
  type SecretName,
} from "../contracts/base.js";
import type { Proposal, ProposalMeta } from "../contracts/proposals.js";
import { type Grant, GrantSchema } from "../contracts/grants.js";
import {
  type MissionModel,
  type MissionBudget,
  type MissionBudgetConsumed,
  type CheckpointSummary,
  MissionBudgetSchema,
  MissionBudgetConsumedSchema,
  MissionRiskPolicySchema,
  MissionModelSchema,
} from "../contracts/mission.js";
import type { Plan, Milestone, Task } from "../contracts/plan.js";
import { CapabilityHost } from "../capability-host/host.js";
import { builtinCapabilities } from "../capabilities/index.js";
import { evaluateProposal, type GateVerdict, type PathResolver } from "../gate/gate.js";
import { GrantStore, newMissionId } from "../grants/grants.js";
import { openMission, type MissionStore } from "../ledger/index.js";
import { LocalEnvironment, sha256Hex } from "../environments/local.js";
import {
  type AutonomousMissionEngineOptions,
  type MissionSnapshot,
  type PlannerContext,
  MissionBudgetExceededError,
  MissionSecurityViolationError,
} from "./types.js";
import { AutonomousMissionStore } from "./store.js";
import { DeterministicPlanner, newTaskId, newMilestoneId, newPlanId } from "./planner.js";
import { VerificationEngine } from "./verifier.js";
import { FailureAnalyzer } from "./retry.js";
import { MissionRecovery } from "./recovery.js";
import { getReadyTasks, isMilestoneComplete, getNextActiveMilestone } from "./scheduler.js";

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

import { CapabilityRegistry, createDefaultCapabilityRegistry } from "../capabilities/index.js";
import type { CapabilityIdentity } from "../contracts/capabilities.js";

export class AutonomousMissionRunner {
  private activeStores = new Map<string, { store: AutonomousMissionStore; grants: GrantStore }>();
  public readonly registry: CapabilityRegistry;

  constructor(private readonly opts: AutonomousMissionEngineOptions) {
    this.registry = opts.registry ?? createDefaultCapabilityRegistry();
  }

  /**
   * Initializes and opens a new autonomous mission.
   */
  async createMission(
    intent: string,
    options?: {
      budget?: Partial<MissionBudget>;
      riskPolicy?: Record<string, unknown>;
      criteria?: CriterionExpr[];
    },
  ): Promise<{ missionId: MissionId; store: AutonomousMissionStore; grantStore: GrantStore }> {
    const missionId = newMissionId();
    const ledgerStore = openMission({ dataDir: this.opts.dataDir, missionId });

    const budget = MissionBudgetSchema.parse({
      ...this.opts.defaultBudget,
      ...options?.budget,
    });
    const budgetConsumed = MissionBudgetConsumedSchema.parse({});
    const riskPolicy = MissionRiskPolicySchema.parse({
      ...this.opts.defaultRiskPolicy,
      ...options?.riskPolicy,
    });

    const missionModel: MissionModel = MissionModelSchema.parse({
      missionId,
      intent,
      goalSpec: {
        summary: intent.slice(0, 2048),
        proposedCriteria: options?.criteria ?? [],
      },
      successCriteria: [],
      constraints: {},
      riskPolicy,
      budget,
      budgetConsumed,
      deadline: null,
      status: "created",
      currentPlanId: null,
      currentMilestoneId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      checkpoint: null,
    });

    const missionStore = new AutonomousMissionStore(ledgerStore, missionModel);
    const grantStore = new GrantStore(ledgerStore);

    // Record mission.created in cryptographic ledger
    missionStore.appendRecord("mission.created", {
      missionId,
      intent,
      goalSummary: missionModel.goalSpec.summary,
    });

    this.activeStores.set(missionId, { store: missionStore, grants: grantStore });
    return { missionId, store: missionStore, grantStore };
  }

  /**
   * Retrieves an active or historical mission handle.
   */
  getMissionHandle(missionId: MissionId): { store: AutonomousMissionStore; grants: GrantStore } {
    let handle = this.activeStores.get(missionId);
    if (!handle) {
      const ledgerStore = openMission({ dataDir: this.opts.dataDir, missionId });
      const records = ledgerStore.read();
      const createdRecord = records.find((r) => r.kind === "mission.created");
      const intent = createdRecord ? (createdRecord.body as { intent: string }).intent : "Resumed mission";
      const goalSummary = createdRecord ? (createdRecord.body as { goalSummary: string }).goalSummary : intent;

      const missionModel: MissionModel = MissionModelSchema.parse({
        missionId,
        intent,
        goalSpec: {
          summary: goalSummary,
          proposedCriteria: [],
        },
        status: "created",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });

      const missionStore = new AutonomousMissionStore(ledgerStore, missionModel);
      const grantStore = new GrantStore(ledgerStore);
      handle = { store: missionStore, grants: grantStore };
      this.activeStores.set(missionId, handle);
    }
    return handle;
  }

  private pinPlan(plan: Plan): Plan {
    return {
      ...plan,
      milestones: plan.milestones.map((m) => ({
        ...m,
        tasks: m.tasks.map((t) => {
          try {
            const desc = this.registry.resolve(t.capability, t.capabilityVersion);
            return {
              ...t,
              capabilityVersion: desc.manifest.version,
              manifestHash: desc.identity.manifestHash,
              implementationHash: desc.identity.implementationHash,
            };
          } catch {
            return t;
          }
        }),
      })),
    };
  }

  /**
   * Runs the full autonomous mission execution loop.
   */
  async runMission(
    missionId: MissionId,
    initialGrants?: Grant[],
    signal?: AbortSignal,
  ): Promise<MissionSnapshot> {
    const { store, grants: grantStore } = this.getMissionHandle(missionId);
    const startTime = Date.now();
    const effSignal = signal ?? new AbortController().signal;

    const env = new LocalEnvironment(this.opts.workspaceRoot);
    const host = this.makeHost(store.ledgerStore, grantStore);
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
          rationale: "mechanical verification command execution",
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

    const planner = this.opts.planner ?? new DeterministicPlanner();

    // 1. Crash recovery check
    const recoveryAnalysis = MissionRecovery.analyzeLedger(store.ledgerStore.read(), this.registry);
    if (recoveryAnalysis.isInterrupted) {
      await MissionRecovery.recoverMission(store, store.getActivePlan(), this.opts.onPostEffectUnknown);
    }

    // 2. Initial state: created -> planning
    if (store.getMission().status === "created") {
      store.transitionState("planning", "Initial plan synthesis");

      const plannerCtx = this.buildPlannerContext(store, grantStore);
      const plan = await planner.generatePlan(plannerCtx);
      store.getMission().budgetConsumed.plannerTurns++;
      this.checkBudget(store, startTime);
      store.acceptPlan(this.pinPlan(plan));

      // Issue initial grants if provided
      if (initialGrants && initialGrants.length > 0) {
        for (const g of initialGrants) {
          grantStore.issue({
            capability: g.capability,
            constraints: g.constraints,
            expiresAt: g.expiresAt,
            issuer: g.issuer,
            parentGrantId: g.parentGrantId,
          });
        }
      }

      store.transitionState("planned", "Plan accepted; transitioning to execution");
      store.transitionState("executing", "Commencing autonomous execution loop");
    }

    // 3. Execution loop
    while (store.getMission().status === "executing") {
      // Periodic check for external cancellation or abort
      if (effSignal.aborted) {
        store.transitionState("cancelled", "Execution aborted via external signal");
        store.appendRecord("mission.cancelled", { reason: "Aborted via external signal", cancelledBy: "user" }, [], "user");
        break;
      }

      // Check budget
      this.checkBudget(store, startTime);

      const plan = store.getActivePlan();
      if (!plan) {
        store.transitionState("failed", "No active plan found during execution");
        store.appendRecord("mission.failed", {
          reason: "No active plan",
          failedTaskId: null,
          errorCategory: "planner_error",
        });
        break;
      }

      // Identify current milestone
      let currentMilestoneId = store.getMission().currentMilestoneId;
      let milestone = plan.milestones.find((m) => m.milestoneId === currentMilestoneId) ?? null;

      if (!milestone || milestone.status === "succeeded" || milestone.status === "skipped") {
        const nextMilestone = getNextActiveMilestone(plan);
        if (!nextMilestone) {
          // All milestones complete! Transition to verifying
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
        // Mechanically verify milestone
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

      // Select ready tasks
      const readyTasks = getReadyTasks(milestone, plan.milestones);
      if (readyTasks.length === 0) {
        // No tasks ready, but milestone incomplete: check if stuck
        store.transitionState("failed", "Scheduler deadlock: no ready tasks remaining in milestone");
        store.appendRecord("mission.failed", {
          reason: "No ready tasks remaining",
          failedTaskId: null,
          errorCategory: "planner_error",
        });
        break;
      }

      // Take the next ready task
      const task = readyTasks[0]!;
      const taskStartMs = Date.now();

      // Check pinned capability identity if present on task (CAP-005, CAP-006, CAP-018)
      const pinnedIdentity: CapabilityIdentity | undefined =
        task.capabilityVersion && task.manifestHash && task.implementationHash
          ? {
              capabilityId: task.capability as any,
              version: task.capabilityVersion,
              manifestHash: task.manifestHash,
              implementationHash: task.implementationHash,
            }
          : undefined;

      if (pinnedIdentity) {
        const val = this.registry.validateIdentity(pinnedIdentity);
        if (!val.valid) {
          store.updateTaskState(task.taskId, (t) => {
            t.status = "failed";
            t.error = {
              taskId: t.taskId,
              capability: t.capability,
              errorCategory: "security_violation",
              errorMessage: `Capability identity check failed for task: ${val.reason}`,
              evidenceRefs: [],
              attemptNumber: t.attempt,
              likelyCause: "Tampered or unregistered capability implementation",
              recoveryRecommendation: "escalate",
            };
          });
          store.appendRecord("task.failed", {
            taskId: task.taskId,
            milestoneId: task.milestoneId,
            capability: task.capability,
            errorCategory: "security_violation",
            errorMessage: `Capability identity check failed: ${val.reason}`,
            attempt: task.attempt,
            retryable: false,
          });
          store.transitionState("failed", `Capability identity check failed: ${val.reason}`);
          store.appendRecord("mission.failed", {
            reason: `Capability identity check failed: ${val.reason}`,
            failedTaskId: task.taskId,
            errorCategory: "security_violation",
          });
          break;
        }
      }

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

      // Planner action proposal
      const plannerCtx = this.buildPlannerContext(store, grantStore);
      const action = await planner.proposeNextAction(plannerCtx);
      store.getMission().budgetConsumed.plannerTurns++;

      if (action.type !== "execute_task") {
        if (action.type === "complete") {
          store.transitionState("verifying", "Planner signaled completion");
          break;
        }
        if (action.type === "fail") {
          store.transitionState("failed", action.reason);
          store.appendRecord("mission.failed", {
            reason: action.reason,
            failedTaskId: task.taskId,
            errorCategory: "planner_error",
          });
          break;
        }
        if (action.type === "replan") {
          store.transitionState("planning", `Planner requested replan: ${action.reason}`);
          const newPlan = await planner.generatePlan(this.buildPlannerContext(store, grantStore));
          store.acceptPlan(newPlan);
          store.transitionState("executing", "Resuming execution under revised plan");
          continue;
        }
      }

      // The core invariant: Proposal -> Gate -> Capability Host -> Evidence -> Ledger
      const proposal = action.proposal;
      const meta: ProposalMeta = action.meta ?? {
        rationale: `Executing autonomous task ${task.taskId}`,
        citations: [],
      };

      const dispatchResult = await this.dispatchProposal(
        store,
        grantStore,
        host,
        proposal,
        meta,
        effSignal,
        pinnedIdentity,
      );

      const taskDurationMs = Date.now() - taskStartMs;
      store.getMission().budgetConsumed.executionTimeMs = Date.now() - startTime;

      if ("rejected" in dispatchResult) {
        const errorCategory = FailureAnalyzer.classifyError(
          new Error(dispatchResult.rejected),
          task.capability,
          true,
        );

        store.updateTaskState(task.taskId, (t) => {
          t.status = "failed";
          t.error = {
            taskId: t.taskId,
            capability: t.capability,
            errorCategory,
            errorMessage: dispatchResult.rejected,
            evidenceRefs: [],
            attemptNumber: t.attempt,
            likelyCause: "Authority gate rejection",
            recoveryRecommendation: "escalate",
          };
        });

        store.appendRecord("task.failed", {
          taskId: task.taskId,
          milestoneId: task.milestoneId,
          capability: task.capability,
          errorCategory,
          errorMessage: dispatchResult.rejected,
          attempt: task.attempt,
          retryable: false,
        });

        // Security violations must not be silently retried
        store.transitionState("failed", `Authority gate rejected task: ${dispatchResult.rejected}`);
        store.appendRecord("mission.failed", {
          reason: dispatchResult.rejected,
          failedTaskId: task.taskId,
          errorCategory: "security_violation",
        });
        break;
      }

      if ("escalated" in dispatchResult) {
        // Escalation was denied or pending without approval
        store.transitionState("blocked", "Escalation requested but unapproved");
        break;
      }

      if ("observation" in dispatchResult) {
        const observation = dispatchResult.observation;
        store.getMission().budgetConsumed.capabilityCalls++;

        // Mechanical verification of task
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
          // Task succeeded
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
          // Task verification failed -> evaluate retry
          const category = FailureAnalyzer.classifyError(
            new Error(taskVerification.reason ?? "Task verification failed"),
            task.capability,
          );

          const remainingBudget: MissionBudget = {
            ...store.getMission().budget,
            maxRetries: store.getMission().budget.maxRetries - store.getMission().budgetConsumed.retries,
          };

          const retryEval = FailureAnalyzer.evaluateRetry(
            task,
            category,
            remainingBudget,
            taskVerification.reason ?? "Unknown failure",
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
            // Task permanently failed
            store.updateTaskState(task.taskId, (t) => {
              t.status = "failed";
              t.error = {
                taskId: t.taskId,
                capability: t.capability,
                errorCategory: category,
                errorMessage: retryEval.reason,
                evidenceRefs: taskVerification.evidenceRefs,
                attemptNumber: t.attempt,
                likelyCause: retryEval.reason,
                recoveryRecommendation: retryEval.recommendation,
              };
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

            if (retryEval.recommendation === "replan") {
              store.transitionState("planning", "Task failed; triggering replan");
              const revisedPlan = await planner.generatePlan(this.buildPlannerContext(store, grantStore));
              store.acceptPlan(revisedPlan);
              store.transitionState("executing", "Resuming execution under replanned model");
            } else {
              store.transitionState("failed", `Task ${task.taskId} failed: ${retryEval.reason}`);
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
    }

    // 4. Verification state: verify mission criteria
    if (store.getMission().status === "verifying") {
      const criteria = store.getMission().goalSpec.proposedCriteria;
      store.appendRecord("verification.started", {
        targetId: missionId,
        targetType: "mission",
        criteria: criteria.map((c) => c.kind),
      });

      const missionCheck = await verifier.verifyMission(store.getMission(), criteria);

      store.appendRecord("verification.completed", {
        targetId: missionId,
        targetType: "mission",
        passed: missionCheck.passed,
        evidenceRefs: missionCheck.evidenceRefs,
        reason: missionCheck.reason,
      });

      if (missionCheck.passed) {
        store.transitionState("completed", "All criteria mechanically verified");
        const completedTasksCount = this.countCompletedTasks(store);
        const durationMs = Date.now() - startTime;
        const chainTip = store.getChainTip() ?? ("0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex);

        store.appendRecord("mission.completed", {
          summary: "Mission completed and verified successfully",
          totalTasksCompleted: completedTasksCount,
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

    // 5. Final snapshot
    store.getMission().budgetConsumed.executionTimeMs = Date.now() - startTime;
    return this.createSnapshot(store);
  }

  /**
   * Dispatches a proposal through the Authority Gate and onto CapabilityHost.
   */
  private async dispatchProposal(
    store: AutonomousMissionStore,
    grants: GrantStore,
    host: CapabilityHost,
    proposal: Proposal,
    meta: ProposalMeta,
    signal: AbortSignal,
    pinnedIdentity?: CapabilityIdentity,
  ): Promise<{ observation: ForgeRecord } | { escalated: true } | { rejected: string }> {
    const received = store.appendRecord("proposal.received", { proposal, meta });
    const pid = received.id;

    const mission = store.getMission();
    const remainingCalls = mission.budget.maxCapabilityCalls - mission.budgetConsumed.capabilityCalls;
    const remainingArtifactBytes = mission.budget.maxArtifactBytes - mission.budgetConsumed.artifactBytes;
    const remainingExecutionTimeMs = mission.budget.maxExecutionTimeMs - mission.budgetConsumed.executionTimeMs;

    const activeGrants = grants.active();
    const verdict = evaluateProposal(proposal, meta, {
      grants: activeGrants,
      resolvePath: this.pathResolver(),
      registry: this.registry,
      pinnedIdentity,
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
            pinnedIdentity,
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

          const obs = await this.executeAllowed(store, grants, host, proposal, v2, pid, signal, pinnedIdentity);
          return { observation: obs };
        }

        store.appendRecord("grant.decided", { requestId: req.id, decision: "deny" }, [], "user");
      }

      return { escalated: true };
    }

    // Gate allows execution
    store.appendRecord("proposal.validated", {
      proposalId: pid,
      result: "accepted",
      reasonCode: "in-grant",
      grantId: verdict.grantId,
    }, [pid]);

    const obs = await this.executeAllowed(store, grants, host, proposal, verdict, pid, signal, pinnedIdentity);
    return { observation: obs };
  }

  /**
   * The sole path to the CapabilityHost: gate allow verdict.
   */
  private async executeAllowed(
    store: AutonomousMissionStore,
    grants: GrantStore,
    host: CapabilityHost,
    proposal: Proposal,
    verdict: GateVerdict & { type: "allow" },
    proposalRecordId: string,
    signal: AbortSignal,
    pinnedIdentity?: CapabilityIdentity,
  ): Promise<ForgeRecord> {
    return host.execute(proposal, verdict, proposalRecordId, {
      workspaceRoot: this.opts.workspaceRoot,
      environment: new LocalEnvironment(this.opts.workspaceRoot),
      environmentKind: "local",
      secrets: this.resolveSecrets(grants, verdict.grantId),
      urlAuthority: (url: string) => this.urlWithinGrantScope(grants, verdict.grantId, url),
      capture: (bytes) => {
        const secrets = this.resolveSecrets(grants, verdict.grantId);
        const { ref } = this.redactAndCapture(store, secrets, bytes);
        return ref;
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
      pinnedIdentity,
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

  private redactAndCapture(
    store: AutonomousMissionStore,
    secrets: ReadonlyMap<SecretName, string>,
    bytes: Uint8Array,
  ): { ref: string; redacted: boolean } {
    let out = bytes;
    let redacted = false;
    for (const value of secrets.values()) {
      if (value.length < 4) continue;
      const needle = new TextEncoder().encode(value);
      if (indexOfBytes(out, needle) === -1) continue;
      out = replaceAllBytes(out, needle, new TextEncoder().encode("[REDACTED]"));
      redacted = true;
    }
    const ref = sha256Hex(out);
    store.ledgerStore.ledger.writeArtifact(out, ref);
    store.getMission().budgetConsumed.artifactBytes += out.byteLength;
    return { ref, redacted };
  }

  private pathResolver(): PathResolver {
    const env = new LocalEnvironment(this.opts.workspaceRoot);
    return { resolveReal: (p) => env.resolveReal(p as never) };
  }

  private makeHost(ledgerStore: MissionStore, grants?: GrantStore): CapabilityHost {
    return new CapabilityHost({
      capabilities: builtinCapabilities(),
      registry: this.registry,
      isGrantActive: (gid) => (grants ? grants.active().some((g) => g.id === gid) : true),
      timeoutFor: (m) => (m.id === "shell" || m.id === "git" || m.id === "verify" ? 120_000 : 30_000),
      append: (input) => ledgerStore.append({ ...input, ts: nowIso() }),
      environment: (kind) => {
        if (kind === "container") throw new Error("container environment not configured");
        return new LocalEnvironment(this.opts.workspaceRoot);
      },
    });
  }

  private checkBudget(store: AutonomousMissionStore, startTime: number): void {
    const mission = store.getMission();
    const budget = mission.budget;
    const consumed = mission.budgetConsumed;

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

  private buildPlannerContext(store: AutonomousMissionStore, grants: GrantStore): PlannerContext {
    const mission = store.getMission();
    const plan = store.getActivePlan();
    const milestone = plan?.milestones.find((m) => m.milestoneId === mission.currentMilestoneId) ?? null;

    const completedTasks: Task[] = [];
    const failedTasks: Task[] = [];
    if (plan) {
      for (const m of plan.milestones) {
        for (const t of m.tasks) {
          if (t.status === "succeeded") completedTasks.push(t);
          if (t.status === "failed") failedTasks.push(t);
        }
      }
    }

    const recentRecords = store.ledgerStore.read().slice(-20);
    const availableCapabilities = Array.from(this.registry.list().map((c) => c.manifest.id));
    const activeGrants = grants.active();

    const budgetRemaining: MissionBudget = {
      maxPlannerTurns: Math.max(0, mission.budget.maxPlannerTurns - mission.budgetConsumed.plannerTurns),
      maxModelCalls: Math.max(0, mission.budget.maxModelCalls - mission.budgetConsumed.modelCalls),
      maxTokens: Math.max(0, mission.budget.maxTokens - (mission.budgetConsumed.tokensIn + mission.budgetConsumed.tokensOut)),
      maxCapabilityCalls: Math.max(0, mission.budget.maxCapabilityCalls - mission.budgetConsumed.capabilityCalls),
      maxRetries: Math.max(0, mission.budget.maxRetries - mission.budgetConsumed.retries),
      maxExecutionTimeMs: Math.max(0, mission.budget.maxExecutionTimeMs - mission.budgetConsumed.executionTimeMs),
      maxArtifactBytes: Math.max(0, mission.budget.maxArtifactBytes - mission.budgetConsumed.artifactBytes),
      maxConcurrentTasks: mission.budget.maxConcurrentTasks,
      maxDelegationDepth: mission.budget.maxDelegationDepth,
    };

    return {
      mission,
      plan,
      currentMilestone: milestone,
      completedTasks,
      failedTasks,
      recentObservations: recentRecords,
      availableCapabilities,
      activeGrants,
      budgetRemaining,
      workspaceRoot: this.opts.workspaceRoot,
    };
  }

  private countCompletedTasks(store: AutonomousMissionStore): number {
    const plan = store.getActivePlan();
    if (!plan) return 0;
    let count = 0;
    for (const m of plan.milestones) {
      for (const t of m.tasks) {
        if (t.status === "succeeded" || t.status === "skipped") {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Generates a machine-readable observability snapshot.
   */
  createSnapshot(store: AutonomousMissionStore): MissionSnapshot {
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

  /**
   * Cancels a running or pending mission.
   */
  async cancelMission(missionId: MissionId, reason: string): Promise<MissionSnapshot> {
    const { store } = this.getMissionHandle(missionId);
    store.transitionState("cancelled", reason);
    store.appendRecord("mission.cancelled", { reason, cancelledBy: "user" }, [], "user");
    return this.createSnapshot(store);
  }
}
