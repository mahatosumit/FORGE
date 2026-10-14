// FORGE Intent Gate (Step 8 Phase 2C.1: Intent Kernel & Semantic Anchoring)
// Tier 1 Mechanical Arbiter: Validates proposal intent against immutable IntentEnvelope
// and machine-addressable Criterion state machines before Tier 2 Authority Gate evaluation.
// Prevents goal drift, unauthorized autonomous goal revision, and prompt-injected capability misuse.

import type { Proposal } from "../contracts/proposals.js";
import type { GateCallerContext } from "../gate/gate.js";
import type {
  IntentEnvelope,
  MachineCriterion,
  CriterionStatus,
  ContributionType,
} from "../contracts/intent.js";
import type { CriterionId, Sha256Hex } from "../contracts/base.js";
import { wrapUntrustedObservation } from "../contracts/intent.js";

export interface IntentGateResult {
  ok: boolean;
  reasonCode?: string;
  detail?: string;
}

export class CriterionStore {
  private readonly criteria = new Map<CriterionId, MachineCriterion>();

  register(criterion: MachineCriterion): void {
    this.criteria.set(criterion.criterionId, criterion);
  }

  get(criterionId: CriterionId): MachineCriterion | undefined {
    return this.criteria.get(criterionId);
  }

  updateStatus(criterionId: CriterionId, status: CriterionStatus): void {
    const crit = this.criteria.get(criterionId);
    if (!crit) throw new Error(`Criterion "${criterionId}" not found`);
    this.criteria.set(criterionId, { ...crit, status });
  }

  list(): MachineCriterion[] {
    return Array.from(this.criteria.values());
  }
}

export interface IntentGateOptions {
  criterionStore?: CriterionStore;
  intentEnvelope?: IntentEnvelope;
  expectedIntentHash?: Sha256Hex;
}

export class IntentGate {
  /**
   * Tier 1 Intent Evaluation (DR-01, DR-02, DR-05):
   * Mechanically enforces:
   * 1. Child agent cannot propose goal revisions or mutate its own inception criteria (P2C-007).
   * 2. Delegation proposals must target an active, unfulfilled parent criterion (P2C-008).
   * 3. Intent hash must strictly match root IntentEnvelope (P2C-009).
   * 4. Capability actions must align with declared contribution types for active criterion.
   */
  static evaluate(
    proposal: Proposal,
    caller?: GateCallerContext,
    opts?: IntentGateOptions,
  ): IntentGateResult {
    const isChildAgent = caller && (caller.delegationId !== undefined || (caller.agentId !== undefined && caller.agentId !== "root"));

    // 1. Child Goal Drift Prohibition (P2C-007)
    // Child agents are strictly forbidden from proposing goal revisions or inception criteria changes.
    if (isChildAgent) {
      if ((proposal.capability as string) === "mission.goal-revised" || (proposal.capability as string) === "goal-revised") {
        return {
          ok: false,
          reasonCode: "autonomous-goal-revision-forbidden",
          detail: "Child agent cannot propose mission.goal-revised or mutate inception criteria (P2C-007)",
        };
      }
    }

    // 2. Delegation Proposal Criterion & Intent Verification (P2C-008, P2C-009)
    if (proposal.capability === "delegate") {
      const args = proposal.args;

      // Intent hash matching
      if (opts?.expectedIntentHash) {
        if (args.intentHash && args.intentHash !== opts.expectedIntentHash) {
          return {
            ok: false,
            reasonCode: "intent-hash-mismatch",
            detail: `Delegation intentHash "${args.intentHash}" does not match root intentHash "${opts.expectedIntentHash}" (P2C-009)`,
          };
        }
      }

      // Criterion verification
      if (opts?.criterionStore) {
        if (!args.targetCriterionId) {
          return {
            ok: false,
            reasonCode: "target-criterion-missing",
            detail: "Delegation proposal must target an explicit machine-addressable criterion (P2C-008)",
          };
        }

        const criterion = opts.criterionStore.get(args.targetCriterionId as CriterionId);
        if (!criterion) {
          return {
            ok: false,
            reasonCode: "criterion-not-found",
            detail: `Delegation proposal targets non-existent criterion "${args.targetCriterionId}" (P2C-008)`,
          };
        }

        if (criterion.status === "satisfied" || criterion.status === "failed" || criterion.status === "invalidated") {
          return {
            ok: false,
            reasonCode: "criterion-terminal",
            detail: `Delegation proposal targets terminal criterion "${args.targetCriterionId}" with status "${criterion.status}" (P2C-008)`,
          };
        }

        if (args.criterionVersion !== undefined && args.criterionVersion !== criterion.immutableVersion) {
          return {
            ok: false,
            reasonCode: "criterion-version-mismatch",
            detail: `Criterion version mismatch: proposal specifies version ${args.criterionVersion}, active is ${criterion.immutableVersion}`,
          };
        }

        if (args.contributionType && !criterion.allowedContributionTypes.includes(args.contributionType as ContributionType)) {
          return {
            ok: false,
            reasonCode: "unauthorized-contribution-type",
            detail: `Contribution type "${args.contributionType}" not permitted by criterion "${args.targetCriterionId}"`,
          };
        }
      }
    }

    return { ok: true };
  }

  /**
   * Ingestion defense: wraps child output in inert tags and strips dangerous control sequences (P2C-019).
   */
  static sanitizeAndWrapObservation(rawOutput: string): string {
    return wrapUntrustedObservation(rawOutput);
  }
}
