// FORGE Autonomous Mission Scheduler (Step 4)
// Task DAG dependency management, cycle detection, ready queue computation,
// and conservative concurrency control.

import type { Plan, Milestone, Task } from "../contracts/plan.js";

export interface CycleValidationResult {
  valid: boolean;
  cycle?: string[];
}

/**
 * Validates that the task dependency graph in a milestone has no cycles.
 * Uses Tarjan / DFS cycle detection.
 */
export function validateTaskGraph(milestone: Milestone): CycleValidationResult {
  const taskMap = new Map<string, Task>();
  for (const t of milestone.tasks) {
    taskMap.set(t.taskId, t);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cyclePath: string[] = [];

  function dfs(taskId: string): boolean {
    visited.add(taskId);
    inStack.add(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const depId of task.dependsOn) {
        if (!taskMap.has(depId)) {
          continue; // Dependency may refer to an earlier milestone or be missing
        }
        if (!visited.has(depId)) {
          if (dfs(depId)) {
            cyclePath.push(taskId);
            return true;
          }
        } else if (inStack.has(depId)) {
          cyclePath.push(depId);
          cyclePath.push(taskId);
          return true;
        }
      }
    }

    inStack.delete(taskId);
    return false;
  }

  for (const task of milestone.tasks) {
    if (!visited.has(task.taskId)) {
      if (dfs(task.taskId)) {
        return { valid: false, cycle: cyclePath.reverse() };
      }
    }
  }

  return { valid: true };
}

/**
 * Returns tasks in a milestone that are ready to run:
 * Status is "pending" or "ready", and all prerequisite dependencies have succeeded or been skipped.
 */
export function getReadyTasks(milestone: Milestone, allMilestones?: Milestone[]): Task[] {
  const taskMap = new Map<string, Task>();
  if (allMilestones) {
    for (const m of allMilestones) {
      for (const t of m.tasks) {
        taskMap.set(t.taskId, t);
      }
    }
  } else {
    for (const t of milestone.tasks) {
      taskMap.set(t.taskId, t);
    }
  }

  return milestone.tasks.filter((task) => {
    if (task.status !== "pending" && task.status !== "ready") {
      return false;
    }

    // Check all dependencies
    for (const depId of task.dependsOn) {
      const depTask = taskMap.get(depId);
      if (!depTask) {
        // If dependency is not found in milestone(s), cannot proceed
        return false;
      }
      if (depTask.status !== "succeeded" && depTask.status !== "skipped") {
        return false;
      }
    }

    return true;
  });
}

/**
 * Checks whether all tasks in a milestone have finished successfully (or skipped).
 */
export function isMilestoneComplete(milestone: Milestone): boolean {
  if (milestone.tasks.length === 0) return true;
  return milestone.tasks.every(
    (t) => t.status === "succeeded" || t.status === "skipped",
  );
}

/**
 * Checks whether any task in a milestone has permanently failed.
 */
export function isMilestoneFailed(milestone: Milestone): boolean {
  return milestone.tasks.some((t) => t.status === "failed");
}

/**
 * Finds the next milestone to execute in the plan.
 */
export function getNextActiveMilestone(plan: Plan): Milestone | null {
  const completedMilestoneIds = new Set<string>(
    plan.milestones
      .filter((m) => m.status === "succeeded" || m.status === "skipped")
      .map((m) => m.milestoneId),
  );

  for (const milestone of plan.milestones) {
    if (milestone.status === "succeeded" || milestone.status === "skipped") {
      continue;
    }

    // Check if prerequisite milestones have succeeded
    const depsMet = milestone.dependencies.every((d) => completedMilestoneIds.has(d));
    if (depsMet) {
      return milestone;
    }
  }

  return null;
}

const READ_ONLY_CAPABILITIES = new Set([
  "doc_parse",
  "web_search",
  "web_fetch",
  "search",
  "verify",
]);

/**
 * Conservative task concurrency check.
 * Two tasks may only run in parallel if both are explicitly read-only.
 * Any write / shell / state-modifying tasks must serialize.
 */
export function canRunInParallel(taskA: Task, taskB: Task): boolean {
  if (taskA.taskId === taskB.taskId) return false;
  const isA = READ_ONLY_CAPABILITIES.has(taskA.capability);
  const isB = READ_ONLY_CAPABILITIES.has(taskB.capability);
  return isA && isB;
}
