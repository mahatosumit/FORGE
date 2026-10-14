// FORGE Governed Planner Runtime & Anti-Runaway Controls (Step 8 Phase 2C.3)
// Enforces:
// 1. TurnBudget: Prevents runaway circular self-reflection loops (P2C-001).
// 2. ActionBudget & ProgressTracker: Detects and stops repeated identical failing actions (P2C-002).
// 3. MechanicalTaskVerifier: Rejects completion claims based solely on natural language text (P2C-003).

import { createHash } from "node:crypto";
import type { Proposal } from "../contracts/proposals.js";
import type { Sha256Hex } from "../contracts/base.js";
import { canonicalize, type JsonLike } from "../codec/canonicalJson.js";

export class PlannerLoopError extends Error {
  constructor(message: string) {
    super(`PlannerLoopError: ${message}`);
    this.name = "PlannerLoopError";
  }
}

export class TurnBudgetExhaustedError extends PlannerLoopError {
  constructor(public readonly turnsUsed: number, public readonly maxTurns: number) {
    super(`Planner turn budget exhausted: used ${turnsUsed} turns of ${maxTurns} maximum (P2C-001)`);
    this.name = "TurnBudgetExhaustedError";
  }
}

export class ActionRepeatExhaustionError extends PlannerLoopError {
  constructor(public readonly capability: string, public readonly repeatCount: number) {
    super(`Repeated identical failing action "${capability}" ${repeatCount} times without progress; runaway loop aborted (P2C-002)`);
    this.name = "ActionRepeatExhaustionError";
  }
}

export class EvidenceRequiredError extends PlannerLoopError {
  constructor(public readonly taskId: string, message = "Task completion rejected: zero verified evidence artifacts or observations provided (P2C-003)") {
    super(message);
    this.name = "EvidenceRequiredError";
  }
}

export interface PlannerLoopBudgetConfig {
  maxPlannerTurns: number;
  maxActionRepeats?: number;
  maxReplans?: number;
}

export class ProgressTracker {
  private consecutiveFailures = new Map<string, number>();
  private readonly maxRepeats: number;

  constructor(maxRepeats = 3) {
    this.maxRepeats = maxRepeats;
  }

  /**
   * Computes deterministic fingerprint of an action proposal.
   */
  static actionFingerprint(proposal: Proposal): Sha256Hex {
    const raw = { capability: proposal.capability, args: proposal.args };
    const canon = canonicalize(raw as unknown as JsonLike);
    return createHash("sha256").update(canon).digest("hex") as Sha256Hex;
  }

  recordActionOutcome(proposal: Proposal, success: boolean): void {
    const fp = ProgressTracker.actionFingerprint(proposal);
    if (success) {
      this.consecutiveFailures.delete(fp);
    } else {
      const current = (this.consecutiveFailures.get(fp) ?? 0) + 1;
      this.consecutiveFailures.set(fp, current);
      if (current >= this.maxRepeats) {
        throw new ActionRepeatExhaustionError(proposal.capability, current);
      }
    }
  }

  getFailureCount(proposal: Proposal): number {
    const fp = ProgressTracker.actionFingerprint(proposal);
    return this.consecutiveFailures.get(fp) ?? 0;
  }

  reset(): void {
    this.consecutiveFailures.clear();
  }
}

export class MechanicalTaskVerifier {
  /**
   * Evaluates task completion claim mechanically (INV-39.3 / P2C-003).
   * Inadmissible: Natural language prose claiming success without verified evidence artifacts or observations.
   */
  static verifyCompletionClaim(claim: {
    taskId: string;
    hasModelClaim: boolean;
    evidenceRefs?: Sha256Hex[];
    observationCount?: number;
    requiredArtifacts?: string[];
  }): { passed: boolean; error?: EvidenceRequiredError } {
    const evidenceCount = (claim.evidenceRefs?.length ?? 0) + (claim.observationCount ?? 0);
    if (claim.hasModelClaim && evidenceCount === 0) {
      return {
        passed: false,
        error: new EvidenceRequiredError(
          claim.taskId,
          `Child planner claimed success in text without evidence artifacts or observations for task "${claim.taskId}" (P2C-003)`,
        ),
      };
    }
    return { passed: true };
  }
}

export class GovernedPlannerLoop {
  private currentTurn = 0;
  private readonly progressTracker: ProgressTracker;

  constructor(public readonly config: PlannerLoopBudgetConfig) {
    this.progressTracker = new ProgressTracker(config.maxActionRepeats ?? 3);
  }

  get turn(): number {
    return this.currentTurn;
  }

  /**
   * Advances the turn budget. Throws TurnBudgetExhaustedError if ceiling reached.
   */
  stepTurn(): void {
    this.currentTurn++;
    if (this.currentTurn > this.config.maxPlannerTurns) {
      throw new TurnBudgetExhaustedError(this.currentTurn, this.config.maxPlannerTurns);
    }
  }

  /**
   * Records execution of an action and checks for repeating failures.
   */
  recordAction(proposal: Proposal, success: boolean): void {
    this.progressTracker.recordActionOutcome(proposal, success);
  }

  /**
   * Verifies a completion claim mechanically.
   */
  verifyCompletion(claim: {
    taskId: string;
    hasModelClaim: boolean;
    evidenceRefs?: Sha256Hex[];
    observationCount?: number;
  }): void {
    const res = MechanicalTaskVerifier.verifyCompletionClaim(claim);
    if (!res.passed && res.error) {
      throw res.error;
    }
  }
}
