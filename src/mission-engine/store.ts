// FORGE Autonomous Mission State & Ledger Store (Step 4)
// Projects mission state and immutable versioned plans from the cryptographic ledger,
// appends runtime-authored mission engine records, and validates state transitions.

import type {
  ForgeRecord,
  RecordKind,
} from "../contracts/records.js";
import type {
  Sha256Hex,
  Iso8601,
} from "../contracts/base.js";
import {
  type MissionModel,
  type MissionState,
  type CheckpointSummary,
  validateMissionTransition,
} from "../contracts/mission.js";
import type { Plan, Milestone, Task } from "../contracts/plan.js";
import type { MissionStore } from "../ledger/index.js";
import { MissionStateTransitionError } from "./types.js";

function nowIso(): Iso8601 {
  return new Date().toISOString() as Iso8601;
}

export class AutonomousMissionStore {
  private plans = new Map<string, Plan>();
  private activePlanId: string | null = null;
  private currentMilestoneId: string | null = null;
  private activeTaskId: string | null = null;
  private checkpoints: CheckpointSummary[] = [];

  constructor(
    public readonly ledgerStore: MissionStore,
    private readonly mission: MissionModel,
  ) {
    this.rebuildFromLedger();
  }

  getMission(): MissionModel {
    return {
      ...this.mission,
      currentPlanId: this.activePlanId,
      currentMilestoneId: this.currentMilestoneId,
      checkpoint: this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1]! : null,
    };
  }

  getActivePlan(): Plan | null {
    if (!this.activePlanId) return null;
    return this.plans.get(this.activePlanId) ?? null;
  }

  getAllPlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  getCheckpoints(): CheckpointSummary[] {
    return [...this.checkpoints];
  }

  getChainTip(): Sha256Hex | null {
    const current = this.ledgerStore.ledger.current();
    return current ? (current.hash as Sha256Hex) : null;
  }

  /**
   * Appends a record to the cryptographic ledger.
   * Author is runtime for mission engine events (or user for cancellations).
   */
  appendRecord<K extends RecordKind>(
    kind: K,
    body: unknown,
    refs: string[] = [],
    author: "runtime" | "user" = "runtime",
  ): ForgeRecord {
    return this.ledgerStore.append({
      kind,
      author,
      ts: nowIso(),
      refs: refs as never,
      body: body as never,
    });
  }

  /**
   * Transition mission status with strict transition table validation.
   */
  transitionState(to: MissionState, reason: string | null = null): void {
    const from = this.mission.status;
    if (!validateMissionTransition(from, to)) {
      throw new MissionStateTransitionError(from, to);
    }

    this.mission.status = to;
    this.mission.updatedAt = nowIso();

    this.appendRecord("mission.state_changed", {
      from,
      to,
      reason,
    });
  }

  /**
   * Records acceptance of a new immutable plan version.
   */
  acceptPlan(plan: Plan): void {
    const totalMilestones = plan.milestones.length;
    let totalTasks = 0;
    for (const m of plan.milestones) {
      totalTasks += m.tasks.length;
    }

    // Mark superseded plans
    if (plan.supersedesPlanId && this.plans.has(plan.supersedesPlanId)) {
      // previous plan superseded
    }

    this.plans.set(plan.planId, plan);
    this.activePlanId = plan.planId;
    this.mission.currentPlanId = plan.planId;
    if (plan.milestones.length > 0) {
      this.currentMilestoneId = plan.milestones[0]!.milestoneId;
      this.mission.currentMilestoneId = this.currentMilestoneId;
    }

    this.appendRecord("plan.accepted", {
      planId: plan.planId,
      version: plan.version,
      milestoneCount: totalMilestones,
      taskCount: totalTasks,
    });
  }

  /**
   * Updates task state within active plan.
   */
  updateTaskState(
    taskId: string,
    updater: (task: Task) => void,
  ): Task | null {
    const plan = this.getActivePlan();
    if (!plan) return null;

    for (const milestone of plan.milestones) {
      const task = milestone.tasks.find((t) => t.taskId === taskId);
      if (task) {
        updater(task);
        if (task.status === "running") {
          this.activeTaskId = taskId;
        } else if (this.activeTaskId === taskId) {
          this.activeTaskId = null;
        }
        return task;
      }
    }
    return null;
  }

  /**
   * Updates milestone state.
   */
  updateMilestoneState(
    milestoneId: string,
    updater: (milestone: Milestone) => void,
  ): Milestone | null {
    const plan = this.getActivePlan();
    if (!plan) return null;

    const milestone = plan.milestones.find((m) => m.milestoneId === milestoneId);
    if (milestone) {
      updater(milestone);
      return milestone;
    }
    return null;
  }

  setCurrentMilestoneId(milestoneId: string | null): void {
    this.currentMilestoneId = milestoneId;
    this.mission.currentMilestoneId = milestoneId;
  }

  /**
   * Creates and persists a checkpoint.
   */
  createCheckpoint(checkpointId: string): CheckpointSummary {
    const plan = this.getActivePlan();
    let completedTasks = 0;
    let totalTasks = 0;
    if (plan) {
      for (const m of plan.milestones) {
        totalTasks += m.tasks.length;
        for (const t of m.tasks) {
          if (t.status === "succeeded" || t.status === "skipped") {
            completedTasks++;
          }
        }
      }
    }

    const planId = this.activePlanId ?? "pln_default";
    const tip = this.ledgerStore.ledger.current()?.hash;
    const summary: CheckpointSummary = {
      checkpointId,
      planId,
      milestoneId: this.currentMilestoneId,
      activeTaskId: this.activeTaskId,
      completedTasksCount: completedTasks,
      timestamp: nowIso(),
      chainTip: tip,
    };

    this.checkpoints.push(summary);
    this.mission.checkpoint = summary;

    this.appendRecord("checkpoint.created", {
      checkpointId,
      state: this.mission.status,
      planId,
      completedTasks,
      totalTasks,
    });

    return summary;
  }

  /**
   * Resumes execution from an existing checkpoint without mutating historical ledger.
   */
  resumeFromCheckpoint(checkpointId: string): CheckpointSummary {
    const cp = this.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!cp) {
      throw new Error(`checkpoint ${checkpointId} not found in mission history`);
    }
    if (this.activePlanId && cp.planId !== this.activePlanId) {
      throw new Error(`checkpoint ${checkpointId} plan mismatch: references ${cp.planId}, active is ${this.activePlanId}`);
    }
    if (cp.chainTip) {
      const allHashes = new Set(this.ledgerStore.read().map((r) => r.hash));
      if (!allHashes.has(cp.chainTip)) {
        throw new Error(`checkpoint ${checkpointId} chain tip mismatch: tip ${cp.chainTip} not found in verified ledger history`);
      }
    }
    this.appendRecord("mission.resumed", {
      fromCheckpointId: checkpointId,
      resumedAt: nowIso(),
    });
    this.mission.checkpoint = cp;
    return cp;
  }

  /**
   * Rebuilds in-memory projections by scanning existing records in the ledger.
   */
  private rebuildFromLedger(): void {
    const records = this.ledgerStore.read();
    for (const r of records) {
      if (r.kind === "mission.state_changed") {
        const body = r.body as { from: string; to: string };
        this.mission.status = body.to as MissionState;
      } else if (r.kind === "checkpoint.created") {
        const body = r.body as {
          checkpointId: string;
          state: string;
          planId: string;
          completedTasks: number;
        };
        this.checkpoints.push({
          checkpointId: body.checkpointId,
          planId: body.planId,
          milestoneId: this.currentMilestoneId,
          activeTaskId: null,
          completedTasksCount: body.completedTasks,
          timestamp: r.ts,
          chainTip: r.prevHash,
        });
      }
    }
  }
}
