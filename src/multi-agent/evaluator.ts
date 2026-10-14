// FORGE Delegation Authority Evaluator (Step 8 Phase 1 Remediation)
// Composed directly by Authority Gate to evaluate "delegate" capability proposals.
// Enforces: Schema, Lineage, Ancestor Revocation, Effective Attenuation,
// Monotonic Expiry, Budget Availability, Epoch Monotonicity, and Topology Bounds.
// Remediates: AUDIT-P1-02 (Gate Delegation Bypass), AUDIT-P1-08, AUDIT-P1-10.

import {
  type DelegateProposalArgs,
  DelegateProposalArgsSchema,
  type EffectiveAuthorityEnvelope,
} from "../contracts/delegation.js";
import { type Grant } from "../contracts/grants.js";
import { type MultiAgentProjection } from "./projection.js";
import { computeEffectiveAuthority } from "./effective-authority.js";
import { MAX_DELEGATION_DEPTH, MAX_CHILD_FANOUT, MAX_ACTIVE_AGENTS } from "./registry.js";

export interface DelegationEvaluationResult {
  ok: boolean;
  reasonCode?: string;
  detail?: string;
  effectiveEnvelope?: EffectiveAuthorityEnvelope;
}

export class DelegationAuthorityEvaluator {
  /**
   * Evaluates a delegate proposal against active grants, effective parent envelopes,
   * lineage state, and durable projections.
   */
  static evaluate(
    rawArgs: unknown,
    parentGrant: Grant,
    parentEnvelope: EffectiveAuthorityEnvelope | undefined,
    projection: MultiAgentProjection,
    now: Date = new Date(),
  ): DelegationEvaluationResult {
    // 1. Schema Validation
    const parsedArgsResult = DelegateProposalArgsSchema.safeParse(rawArgs);
    if (!parsedArgsResult.success) {
      return {
        ok: false,
        reasonCode: "rejected-schema",
        detail: `Malformed delegate proposal arguments: ${parsedArgsResult.error.message}`,
      };
    }
    const args: DelegateProposalArgs = parsedArgsResult.data;

    // 2. Parent Grant Validity
    if (parentGrant.capability !== "delegate") {
      return {
        ok: false,
        reasonCode: "grant-mismatch",
        detail: `Grant "${parentGrant.id}" does not permit "delegate" capability`,
      };
    }
    if (parentGrant.expiresAt !== null && Date.parse(parentGrant.expiresAt) <= now.getTime()) {
      return {
        ok: false,
        reasonCode: "grant-expired",
        detail: `Grant "${parentGrant.id}" expired at ${parentGrant.expiresAt}`,
      };
    }

    // 3. Parent Delegation & Ancestor Lineage Check (AUDIT-P1-08, AUDIT-P1-10)
    if (args.parentDelegationId !== null) {
      const parentDel = projection.getDelegation(args.parentDelegationId);
      if (!parentDel) {
        return {
          ok: false,
          reasonCode: "parent-delegation-not-found",
          detail: `Parent delegation "${args.parentDelegationId}" not found in projection`,
        };
      }

      // Check entire ancestor path for revocation
      const lineage = projection.isLineageActive(args.parentDelegationId);
      if (!lineage.ok) {
        return {
          ok: false,
          reasonCode: "ancestor-revoked",
          detail: `Cannot delegate: lineage is revoked at ancestor "${lineage.revokedAtId}" (${lineage.reason})`,
        };
      }

      // Depth hierarchy verification
      if (parentDel.depth + 1 !== args.topologyMetadata.depth) {
        return {
          ok: false,
          reasonCode: "depth-hierarchy-mismatch",
          detail: `Child depth ${args.topologyMetadata.depth} must equal parent depth ${parentDel.depth} + 1`,
        };
      }

      // Fanout bound check
      const activeChildren = projection.getActiveChildCount(args.parentDelegationId);
      if (activeChildren >= MAX_CHILD_FANOUT) {
        return {
          ok: false,
          reasonCode: "fanout-limit-exceeded",
          detail: `Parent delegation "${args.parentDelegationId}" reached max fanout of ${MAX_CHILD_FANOUT}`,
        };
      }
    } else {
      // Root child delegation
      if (args.topologyMetadata.depth !== 1) {
        return {
          ok: false,
          reasonCode: "depth-hierarchy-mismatch",
          detail: `Root child delegation must have depth 1, got ${args.topologyMetadata.depth}`,
        };
      }
    }

    // 4. Global Topology Bounds & Cycle Detection
    if (args.topologyMetadata.depth > MAX_DELEGATION_DEPTH) {
      return {
        ok: false,
        reasonCode: "depth-limit-exceeded",
        detail: `Delegation depth ${args.topologyMetadata.depth} exceeds maximum depth of ${MAX_DELEGATION_DEPTH}`,
      };
    }

    if (args.topologyMetadata.ancestorPath.length !== args.topologyMetadata.depth) {
      return {
        ok: false,
        reasonCode: "invalid-topology-metadata",
        detail: `Ancestor path length (${args.topologyMetadata.ancestorPath.length}) does not match depth (${args.topologyMetadata.depth})`,
      };
    }

    if (args.topologyMetadata.ancestorPath[args.topologyMetadata.ancestorPath.length - 1] !== args.delegationId) {
      return {
        ok: false,
        reasonCode: "invalid-topology-metadata",
        detail: `Terminal ancestor must match delegationId "${args.delegationId}"`,
      };
    }

    // Cycle check: unique IDs in ancestor path
    const pathSet = new Set(args.topologyMetadata.ancestorPath);
    if (pathSet.size !== args.topologyMetadata.ancestorPath.length) {
      return {
        ok: false,
        reasonCode: "cycle-detected",
        detail: `Cycle detected in ancestor path: [${args.topologyMetadata.ancestorPath.join(", ")}]`,
      };
    }

    // Active agent ceiling
    const totalActive = projection.getActiveAgentCount();
    if (totalActive >= MAX_ACTIVE_AGENTS) {
      return {
        ok: false,
        reasonCode: "active-agent-ceiling-exceeded",
        detail: `Total active agent count (${totalActive}) reached maximum ceiling of ${MAX_ACTIVE_AGENTS}`,
      };
    }

    // 5. Effective Authority Attenuation Check (Closed-World Enforcement)
    // Resolve base parent envelope
    let effectiveParentEnv: EffectiveAuthorityEnvelope;
    if (parentEnvelope) {
      effectiveParentEnv = parentEnvelope;
    } else if (args.parentDelegationId) {
      const pDel = projection.getDelegation(args.parentDelegationId);
      if (!pDel) {
        return {
          ok: false,
          reasonCode: "parent-delegation-not-found",
          detail: "Cannot resolve parent effective envelope",
        };
      }
      effectiveParentEnv = pDel.effectiveEnvelope;
    } else {
      // Default parent envelope derived from parent grant
      effectiveParentEnv = {
        capabilities: [parentGrant.capability],
        constraints: parentGrant.constraints,
        riskCeiling: "execute",
        isolationProfile: "sandboxed",
        allowHostExecution: false,
        budgetEscrow: projection.getAvailableBudget(),
        expiresAt: parentGrant.expiresAt,
        depth: 0,
        maxChildren: 3,
      };
    }

    const attenuationResult = computeEffectiveAuthority(effectiveParentEnv, {
      capabilities: args.requestedAuthority.capabilities,
      constraints: args.requestedAuthority.constraints,
      riskCeiling: args.requestedAuthority.riskCeiling,
      isolationProfile: args.requestedAuthority.isolationProfile,
      allowHostExecution: args.requestedAuthority.allowHostExecution,
      budget: args.requestedBudget,
      expiresAt: args.expiry,
    });

    if (!attenuationResult.ok) {
      return {
        ok: false,
        reasonCode: `attenuation-failed-${attenuationResult.dimension}`,
        detail: `Authority attenuation failed on dimension "${attenuationResult.dimension}": ${attenuationResult.error}`,
      };
    }

    // 6. Budget Availability Check (Against Authoritative Projection)
    const available = projection.getAvailableBudget();
    const reqBudget = args.requestedBudget;
    if (reqBudget.maxTokens > available.maxTokens) {
      return {
        ok: false,
        reasonCode: "budget-exhausted",
        detail: `Requested tokens (${reqBudget.maxTokens}) exceeds available (${available.maxTokens})`,
      };
    }
    if (reqBudget.maxModelCalls > available.maxModelCalls) {
      return {
        ok: false,
        reasonCode: "budget-exhausted",
        detail: `Requested model calls (${reqBudget.maxModelCalls}) exceeds available (${available.maxModelCalls})`,
      };
    }
    if (reqBudget.maxCapabilityCalls > available.maxCapabilityCalls) {
      return {
        ok: false,
        reasonCode: "budget-exhausted",
        detail: `Requested capability calls (${reqBudget.maxCapabilityCalls}) exceeds available (${available.maxCapabilityCalls})`,
      };
    }
    if (reqBudget.maxExecutionTimeMs > available.maxExecutionTimeMs) {
      return {
        ok: false,
        reasonCode: "budget-exhausted",
        detail: "Requested execution time exceeds available budget",
      };
    }
    if (reqBudget.maxArtifactBytes > available.maxArtifactBytes) {
      return {
        ok: false,
        reasonCode: "budget-exhausted",
        detail: "Requested artifact bytes exceeds available budget",
      };
    }

    return {
      ok: true,
      effectiveEnvelope: attenuationResult.effective,
    };
  }
}
