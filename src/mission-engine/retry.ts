// FORGE Autonomous Mission Retry Policy & Failure Classification (Step 4)
// Classifies errors, isolates security violations (non-retryable),
// calculates exponential backoff, and advises retry/replan/escalate/abort.

import type { Task, FailureCategory } from "../contracts/plan.js";
import type { MissionBudget } from "../contracts/mission.js";

export interface RetryEvaluation {
  retryable: boolean;
  delayMs: number;
  recommendation: "retry" | "replan" | "escalate" | "abort";
  errorCategory: FailureCategory;
  reason: string;
}

export class FailureAnalyzer {
  /**
   * Classifies an error into a standard FailureCategory.
   * Security violations and budget exhaustions are strictly isolated.
   */
  static classifyError(
    err: unknown,
    capability: string,
    isGateRejection: boolean = false,
  ): FailureCategory {
    if (isGateRejection) {
      return "security_violation";
    }

    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

    // 1. Security & authorization
    if (
      msg.includes("out-of-grant") ||
      msg.includes("rejected-gate") ||
      msg.includes("unauthorized") ||
      msg.includes("security") ||
      msg.includes("traversal") ||
      msg.includes("forbidden") ||
      msg.includes("escaped")
    ) {
      return "security_violation";
    }

    // 2. Resource exhaustion & budgets
    if (
      msg.includes("budget exceeded") ||
      msg.includes("max capability calls") ||
      msg.includes("max planner turns") ||
      msg.includes("out of memory") ||
      msg.includes("timeout") && msg.includes("stage budget")
    ) {
      return "resource_exhaustion";
    }

    // 3. Transient / network / rate limits
    if (
      msg.includes("429") ||
      msg.includes("ratelimit") ||
      msg.includes("rate limit") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("etimedout") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("network") ||
      msg.includes("temporary")
    ) {
      return "transient";
    }

    // 4. Schema / validation
    if (
      msg.includes("validation") ||
      msg.includes("rejected-schema") ||
      msg.includes("zoderror") ||
      msg.includes("invalid argument")
    ) {
      return "validation_error";
    }

    // 5. Verification failure
    if (msg.includes("verification") || msg.includes("criterion failed")) {
      return "verification_failure";
    }

    // 6. Capability error (command exit != 0, doc parse failure, etc.)
    if (
      msg.includes("exit code") ||
      msg.includes("parse error") ||
      msg.includes("failed to execute")
    ) {
      return "capability_error";
    }

    return "unknown";
  }

  /**
   * Evaluates retry eligibility under governance rules:
   * - Security violations are NEVER silently retried.
   * - Resource exhaustions are NEVER retried.
   * - Max attempts and budget limits are strictly enforced.
   */
  static evaluateRetry(
    task: Task,
    category: FailureCategory,
    budgetRemaining: MissionBudget,
    errorMessage: string,
  ): RetryEvaluation {
    // Rule 1: Security violations cannot be retried silently
    if (category === "security_violation") {
      return {
        retryable: false,
        delayMs: 0,
        recommendation: "escalate",
        errorCategory: category,
        reason: `Security violation in capability ${task.capability}: ${errorMessage}. Silent retry prohibited.`,
      };
    }

    // Rule 2: Resource exhaustion stops execution
    if (category === "resource_exhaustion") {
      return {
        retryable: false,
        delayMs: 0,
        recommendation: "abort",
        errorCategory: category,
        reason: `Resource exhaustion: ${errorMessage}. Mission halting.`,
      };
    }

    // Rule 3: Check task-level attempt limits
    const currentAttempt = task.attempt;
    if (currentAttempt >= task.maxAttempts) {
      return {
        retryable: false,
        delayMs: 0,
        recommendation: "replan",
        errorCategory: category,
        reason: `Task ${task.taskId} exceeded maximum attempts (${task.maxAttempts}). Triggering replan.`,
      };
    }

    // Rule 4: Check remaining retry budget
    if (budgetRemaining.maxRetries <= 0) {
      return {
        retryable: false,
        delayMs: 0,
        recommendation: "replan",
        errorCategory: category,
        reason: "Mission retry budget exhausted. Triggering replan.",
      };
    }

    // Rule 5: Transient failures use exponential backoff
    if (category === "transient") {
      const baseDelay = 200;
      const delayMs = Math.min(baseDelay * Math.pow(2, currentAttempt), 10_000);
      return {
        retryable: true,
        delayMs,
        recommendation: "retry",
        errorCategory: category,
        reason: `Transient error: ${errorMessage}. Retrying in ${delayMs}ms (attempt ${currentAttempt + 1}/${task.maxAttempts}).`,
      };
    }

    // Rule 6: Capability errors and verification failures allow limited immediate retries
    if (category === "capability_error" || category === "verification_failure") {
      return {
        retryable: true,
        delayMs: 50,
        recommendation: "retry",
        errorCategory: category,
        reason: `Recoverable error: ${errorMessage}. Retrying (attempt ${currentAttempt + 1}/${task.maxAttempts}).`,
      };
    }

    // Validation errors require replan rather than repeating the same invalid parameters
    if (category === "validation_error") {
      return {
        retryable: false,
        delayMs: 0,
        recommendation: "replan",
        errorCategory: category,
        reason: `Validation error: ${errorMessage}. Replan required.`,
      };
    }

    return {
      retryable: false,
      delayMs: 0,
      recommendation: "abort",
      errorCategory: category,
      reason: `Unclassified failure: ${errorMessage}`,
    };
  }
}
