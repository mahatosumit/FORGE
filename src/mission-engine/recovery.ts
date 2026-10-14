// FORGE Autonomous Mission Recovery & Crash Consistency (Step 4)
// Scans the cryptographic ledger for interruptions, resolves post-effect-unknown states,
// cleans interrupted tasks, and guarantees idempotency.

import type { ForgeRecord } from "../contracts/records.js";
import type { Plan } from "../contracts/plan.js";
import type { AutonomousMissionStore } from "./store.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import { getReadyTasks } from "./scheduler.js";

export interface RecoveryAnalysis {
  isInterrupted: boolean;
  hasPostEffectUnknown: boolean;
  undispatchedProposalIds: string[];
  dispatchedWithoutObservationIds: string[];
  replayableDispatchedProposalIds?: string[];
  nonIdempotentDispatchedProposalIds?: string[];
  interruptedTaskIds: string[];
  completedTaskIds: string[];
}

export class MissionRecovery {
  /**
   * Analyzes the ledger history of a mission to detect interrupted state.
   */
  static analyzeLedger(records: readonly ForgeRecord[], registry?: CapabilityRegistry): RecoveryAnalysis {
    const receivedProposals = new Set<string>();
    const dispatchedProposals = new Set<string>();
    const completedProposals = new Set<string>();
    const startedTasks = new Set<string>();
    const completedTasks = new Set<string>();
    const failedTasks = new Set<string>();

    for (const r of records) {
      if (r.kind === "proposal.received") {
        receivedProposals.add(r.id);
      } else if (r.kind === "proposal.dispatched") {
        const body = r.body as { proposalId?: string };
        if (body.proposalId) {
          dispatchedProposals.add(body.proposalId);
        }
      } else if (
        r.kind.startsWith("observation.") ||
        r.kind === "proposal.validated"
      ) {
        if (r.refs && r.refs.length > 0) {
          for (const ref of r.refs) {
            completedProposals.add(ref);
          }
        }
      } else if (r.kind === "task.started") {
        const body = r.body as { taskId: string };
        startedTasks.add(body.taskId);
      } else if (r.kind === "task.completed") {
        const body = r.body as { taskId: string };
        completedTasks.add(body.taskId);
      } else if (r.kind === "task.failed") {
        const body = r.body as { taskId: string };
        failedTasks.add(body.taskId);
      }
    }

    const proposalMap = new Map<string, { capability: string; args?: any }>();
    for (const r of records) {
      if (r.kind === "proposal.received") {
        const body = r.body as { proposal?: { capability?: string; args?: any } };
        if (body.proposal?.capability) {
          proposalMap.set(r.id, {
            capability: body.proposal.capability,
            args: body.proposal.args,
          });
        }
      }
    }

    const undispatchedProposalIds = Array.from(receivedProposals).filter(
      (pid) => !dispatchedProposals.has(pid) && !completedProposals.has(pid),
    );

    const dispatchedWithoutObservationIds = Array.from(dispatchedProposals).filter(
      (pid) => !completedProposals.has(pid),
    );

    const nonIdempotentDispatchedIds: string[] = [];
    const replayableDispatchedIds: string[] = [];

    for (const pid of dispatchedWithoutObservationIds) {
      const propInfo = proposalMap.get(pid);
      const cap = propInfo?.capability;
      const args = propInfo?.args;
      let idempotency = "non_idempotent";

      if (cap === "fs") {
        const op = args?.op;
        if (op === "write" || op === "mkdir" || op === "readFile" || op === "read") {
          idempotency = "idempotent";
        } else {
          // append and patch are non-idempotent: replaying causes silent duplicate/corruption
          idempotency = "non_idempotent";
        }
      } else if (cap && registry) {
        try {
          const desc = registry.resolve(cap);
          if (desc.manifest.idempotency === "conditionally_idempotent") {
            idempotency = "non_idempotent";
          } else {
            idempotency = desc.manifest.idempotency;
          }
        } catch {
          idempotency = "unknown";
        }
      } else if (cap === "search" || cap === "doc_parse" || cap === "artifact") {
        idempotency = "idempotent";
      }

      if (idempotency === "pure_read" || idempotency === "idempotent") {
        replayableDispatchedIds.push(pid);
      } else {
        nonIdempotentDispatchedIds.push(pid);
      }
    }

    const interruptedTaskIds = Array.from(startedTasks).filter(
      (tid) => !completedTasks.has(tid) && !failedTasks.has(tid),
    );

    const hasPostEffectUnknown = nonIdempotentDispatchedIds.length > 0;
    const isInterrupted =
      undispatchedProposalIds.length > 0 ||
      dispatchedWithoutObservationIds.length > 0 ||
      interruptedTaskIds.length > 0;

    return {
      isInterrupted,
      hasPostEffectUnknown,
      undispatchedProposalIds,
      dispatchedWithoutObservationIds,
      replayableDispatchedProposalIds: replayableDispatchedIds,
      nonIdempotentDispatchedProposalIds: nonIdempotentDispatchedIds,
      interruptedTaskIds,
      completedTaskIds: Array.from(completedTasks),
    };
  }

  /**
   * Recovers an interrupted mission safely:
   * - Marks interrupted tasks back to "ready" or "failed"
   * - Resolves post-effect-unknown with operator/callback if necessary
   * - Transitions mission from "recovering" to "executing" or "replanning"
   */
  static async recoverMission(
    store: AutonomousMissionStore,
    plan: Plan | null,
    onPostEffectUnknown?: (missionId: string, proposalId: string) => Promise<boolean>,
  ): Promise<{ recovered: boolean; readyTasks: string[] }> {
    const analysis = this.analyzeLedger(store.ledgerStore.read());

    if (analysis.isInterrupted && store.getMission().status !== "recovering") {
      // Transition to recovering
      store.transitionState("recovering", "Recovering from unexpected shutdown / interruption");
    }

    // Handle post-effect-unknown (fails closed on non-idempotent and unknown)
    if (analysis.hasPostEffectUnknown) {
      const blockingIds = analysis.nonIdempotentDispatchedProposalIds ?? analysis.dispatchedWithoutObservationIds;
      for (const pid of blockingIds) {
        if (!onPostEffectUnknown) {
          store.transitionState("failed", `Recovery blocked: proposal ${pid} is post-effect-unknown and requires operator acknowledgement`);
          return { recovered: false, readyTasks: [] };
        }
        const proceed = await onPostEffectUnknown(store.getMission().missionId, pid);
        if (!proceed) {
          store.transitionState("failed", `Recovery aborted on post-effect-unknown proposal ${pid}`);
          return { recovered: false, readyTasks: [] };
        }
      }
    }

    // Reconcile tasks in active plan with ledger
    const resetTaskIds: string[] = [];
    if (plan) {
      // Mark already completed tasks as succeeded so they are never executed twice
      for (const tid of analysis.completedTaskIds) {
        store.updateTaskState(tid, (task) => {
          task.status = "succeeded";
        });
      }

      // Reset interrupted tasks in active plan back to ready
      for (const tid of analysis.interruptedTaskIds) {
        store.updateTaskState(tid, (task) => {
          task.status = "ready";
          resetTaskIds.push(tid);
        });
      }

      // Promote pending tasks whose dependencies are satisfied to ready
      for (const milestone of plan.milestones) {
        const ready = getReadyTasks(milestone, plan.milestones);
        for (const t of ready) {
          if (t.status === "pending") {
            store.updateTaskState(t.taskId, (task) => {
              task.status = "ready";
            });
            resetTaskIds.push(t.taskId);
          }
        }
      }
    }

    if (store.getMission().status === "recovering") {
      // Transition back to executing
      store.transitionState("executing", "Recovery complete; resuming execution loop");
    }

    return { recovered: true, readyTasks: resetTaskIds };
  }
}
