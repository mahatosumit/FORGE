// FORGE Autonomous Mission Scoped Delegation (Step 4)
// Governed subagent delegation with strict grant attenuation (A_child ⊆ A_parent),
// budget bounding, and depth limits.

import { ulidBody, type MissionId } from "../contracts/base.js";
import type { Grant } from "../contracts/grants.js";
import type { MissionModel, MissionBudgetConsumed } from "../contracts/mission.js";
import type { DelegationSpec } from "../contracts/plan.js";
import { constraintsSubsetOf } from "../grants/grants.js";

export class DelegationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationError";
  }
}

export class DelegationManager {
  constructor(public readonly maxDepth: number = 2) {}

  /**
   * Validates and provisions a scoped delegation.
   * Enforces:
   * 1. Max delegation depth.
   * 2. Strict grant attenuation: child grants cannot widen active parent grants.
   * 3. Budget limits: child budget cannot exceed remaining parent budget.
   */
  createDelegation(
    parentMission: MissionModel,
    spec: DelegationSpec,
    parentActiveGrants: Grant[],
    currentDepth: number = 0,
  ): { childMissionId: MissionId; delegation: DelegationSpec } {
    if (currentDepth >= this.maxDepth) {
      throw new DelegationError(
        `Max delegation depth (${this.maxDepth}) reached. Cannot delegate further.`,
      );
    }

    // 1. Validate grant attenuation
    for (const childGrant of spec.scopedGrants) {
      const matchingParent = parentActiveGrants.find(
        (p) =>
          p.capability === childGrant.capability &&
          constraintsSubsetOf(p.constraints, childGrant.constraints),
      );

      if (!matchingParent) {
        throw new DelegationError(
          `INV-9 violation: child grant for "${childGrant.capability}" is not covered by parent active grants.`,
        );
      }

      if (matchingParent.expiresAt !== null) {
        if (
          childGrant.expiresAt === null ||
          new Date(childGrant.expiresAt).getTime() > new Date(matchingParent.expiresAt).getTime()
        ) {
          throw new DelegationError(
            `INV-9 violation: child grant for "${childGrant.capability}" outlives parent grant.`,
          );
        }
      }
    }

    // 2. Validate budget bounding
    const parentBudget = parentMission.budget;
    const parentConsumed = parentMission.budgetConsumed;

    const remainingTurns = parentBudget.maxPlannerTurns - parentConsumed.plannerTurns;
    const remainingCalls = parentBudget.maxCapabilityCalls - parentConsumed.capabilityCalls;
    const remainingRetries = parentBudget.maxRetries - parentConsumed.retries;

    if (spec.budget.maxPlannerTurns > remainingTurns) {
      throw new DelegationError(
        `Child budget maxPlannerTurns (${spec.budget.maxPlannerTurns}) exceeds parent remaining (${remainingTurns})`,
      );
    }

    if (spec.budget.maxCapabilityCalls > remainingCalls) {
      throw new DelegationError(
        `Child budget maxCapabilityCalls (${spec.budget.maxCapabilityCalls}) exceeds parent remaining (${remainingCalls})`,
      );
    }

    if (spec.budget.maxRetries > remainingRetries) {
      throw new DelegationError(
        `Child budget maxRetries (${spec.budget.maxRetries}) exceeds parent remaining (${remainingRetries})`,
      );
    }

    if (spec.budget.maxModelCalls !== undefined) {
      const remainingModelCalls = parentBudget.maxModelCalls - parentConsumed.modelCalls;
      if (spec.budget.maxModelCalls > remainingModelCalls) {
        throw new DelegationError(
          `Child budget maxModelCalls (${spec.budget.maxModelCalls}) exceeds parent remaining (${remainingModelCalls})`,
        );
      }
    }

    if (spec.budget.maxTokens !== undefined) {
      const remainingTokens = parentBudget.maxTokens - (parentConsumed.tokensIn + parentConsumed.tokensOut);
      if (spec.budget.maxTokens > remainingTokens) {
        throw new DelegationError(
          `Child budget maxTokens (${spec.budget.maxTokens}) exceeds parent remaining (${remainingTokens})`,
        );
      }
    }

    if (spec.budget.maxArtifactBytes !== undefined) {
      const remainingArtifactBytes = parentBudget.maxArtifactBytes - parentConsumed.artifactBytes;
      if (spec.budget.maxArtifactBytes > remainingArtifactBytes) {
        throw new DelegationError(
          `Child budget maxArtifactBytes (${spec.budget.maxArtifactBytes}) exceeds parent remaining (${remainingArtifactBytes})`,
        );
      }
    }

    const childMissionId = `mis_${ulidBody()}` as MissionId;
    return {
      childMissionId,
      delegation: spec,
    };
  }

  /**
   * Reconciles child mission consumption back into parent mission's budget.
   */
  reconcileChildBudget(
    parentMission: MissionModel,
    childConsumed: MissionBudgetConsumed,
  ): void {
    parentMission.budgetConsumed.plannerTurns += childConsumed.plannerTurns;
    parentMission.budgetConsumed.modelCalls += childConsumed.modelCalls;
    parentMission.budgetConsumed.tokensIn += childConsumed.tokensIn;
    parentMission.budgetConsumed.tokensOut += childConsumed.tokensOut;
    parentMission.budgetConsumed.capabilityCalls += childConsumed.capabilityCalls;
    parentMission.budgetConsumed.retries += childConsumed.retries;
    parentMission.budgetConsumed.executionTimeMs += childConsumed.executionTimeMs;
    parentMission.budgetConsumed.artifactBytes += childConsumed.artifactBytes;
  }
}
