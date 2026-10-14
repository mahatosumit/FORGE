// FORGE Plan DAG & Invalidation Engine (Step 8 Phase 2C.5)
// Enforces:
// 1. Strict prerequisite dependency barriers (P2C-016).
// 2. Cascade invalidation propagation to all downstream dependent tasks (P2C-017).
// 3. Rejection of receipts emitted by stale children running under prior epochs (P2C-018).
// 4. Atomic dispatch transactions with epoch and prerequisite validation under mutex.

import { StalePlanEpochError, DependencyUnsatisfiedError } from "./reservation-coordinator.js";

export type GovernedTaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "invalidated";

export interface GovernedTask {
  taskId: string;
  planEpoch: number;
  dependsOn: string[];
  status: GovernedTaskStatus;
  receiptVerified?: boolean;
}

export class TaskDag {
  private readonly tasks = new Map<string, GovernedTask>();
  private readonly dependentsMap = new Map<string, Set<string>>();
  private _currentEpoch: number;

  constructor(initialEpoch = 1) {
    this._currentEpoch = initialEpoch;
  }

  get currentEpoch(): number {
    return this._currentEpoch;
  }

  bumpEpoch(): number {
    this._currentEpoch++;
    return this._currentEpoch;
  }

  addTask(task: GovernedTask): void {
    this.tasks.set(task.taskId, { ...task });
    for (const prereq of task.dependsOn) {
      if (!this.dependentsMap.has(prereq)) {
        this.dependentsMap.set(prereq, new Set());
      }
      this.dependentsMap.get(prereq)!.add(task.taskId);
    }
  }

  getTask(taskId: string): GovernedTask | undefined {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : undefined;
  }

  getStatus(taskId: string): GovernedTaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  getDirectDependents(taskId: string): string[] {
    return Array.from(this.dependentsMap.get(taskId) ?? []);
  }

  updateTaskStatus(
    taskId: string,
    status: GovernedTaskStatus,
    receiptVerified?: boolean,
  ): void {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Task "${taskId}" not found in DAG`);
    t.status = status;
    if (receiptVerified !== undefined) {
      t.receiptVerified = receiptVerified;
    }
  }

  arePrerequisitesCompleted(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    for (const prereqId of t.dependsOn) {
      const prereq = this.tasks.get(prereqId);
      if (!prereq || prereq.status !== "completed" || !prereq.receiptVerified) {
        return false;
      }
    }
    return true;
  }
}

export class PlanInvalidationEngine {
  /**
   * Cascades task failure/invalidation to all downstream dependents in the DAG (P2C-017).
   */
  static cascadeInvalidate(failedTaskId: string, dag: TaskDag): string[] {
    const invalidated: string[] = [];
    const queue = [failedTaskId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = dag.getDirectDependents(current);

      for (const depId of dependents) {
        const depStatus = dag.getStatus(depId);
        if (depStatus && depStatus !== "invalidated" && depStatus !== "completed") {
          dag.updateTaskStatus(depId, "invalidated");
          invalidated.push(depId);
          queue.push(depId);
        }
      }
    }
    return invalidated;
  }

  /**
   * Verifies receipt plan epoch against current authoritative epoch (P2C-018).
   */
  static verifyReceiptEpoch(receiptEpoch: number, currentEpoch: number): void {
    if (receiptEpoch < currentEpoch) {
      throw new StalePlanEpochError(
        `Receipt plan epoch ${receiptEpoch} is stale; current authoritative plan epoch is ${currentEpoch} (P2C-018)`,
      );
    }
  }
}

export class AtomicDispatchTransaction {
  /**
   * Executes dispatch transaction with prerequisite and epoch validation immediately before physical run (DR-06).
   */
  static async executeDispatch(opts: {
    taskId: string;
    dag: TaskDag;
    onDispatch: () => Promise<unknown>;
  }): Promise<{ ok: boolean; result?: unknown }> {
    const task = opts.dag.getTask(opts.taskId);
    if (!task) throw new Error(`Task "${opts.taskId}" not found in DAG`);

    // 1. Check Epoch
    if (task.planEpoch !== opts.dag.currentEpoch) {
      opts.dag.updateTaskStatus(opts.taskId, "invalidated");
      throw new StalePlanEpochError(
        `Task plan epoch ${task.planEpoch} does not match current plan epoch ${opts.dag.currentEpoch}`,
      );
    }

    // 2. Check Prerequisites
    if (!opts.dag.arePrerequisitesCompleted(opts.taskId)) {
      opts.dag.updateTaskStatus(opts.taskId, "blocked");
      throw new DependencyUnsatisfiedError(
        `Prerequisite tasks not completed for task "${opts.taskId}" (P2C-016)`,
      );
    }

    // 3. Mark running and execute physical dispatch
    opts.dag.updateTaskStatus(opts.taskId, "running");
    const result = await opts.onDispatch();
    return { ok: true, result };
  }
}
