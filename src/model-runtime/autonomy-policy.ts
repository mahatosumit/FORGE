// FORGE Model Runtime — Autonomy Policy Engine (Step 5)
// Evaluates explicit autonomy levels (L0_ASK to L4_FULL_MISSION_AUTONOMY).
// CORE INVARIANT: Autonomy level NEVER bypasses the Authority Gate or weakens security.

import type { Proposal } from "../contracts/proposals.js";
import type { Grant } from "../contracts/grants.js";
import type { AutonomyLevel } from "../contracts/mission.js";
import type { AutonomyDecision } from "./types.js";

const READ_ONLY_CAPABILITIES = new Set([
  "search",
  "doc_parse",
  "verify",
  "web_search",
  "web_fetch",
  "artifact",
]);

export class AutonomyPolicyEngine {
  /**
   * Evaluates whether a proposed action may execute automatically under the given autonomy policy.
   *
   * Levels:
   * - L0_ASK: Requires manual user approval for every proposal.
   * - L1_SUGGEST: Proposals are recommendations; manual approval required.
   * - L2_SAFE_AUTONOMOUS: Read-only capabilities auto-approved; state-modifying calls require approval.
   * - L3_GOVERNED_AUTONOMOUS: Auto-approved if within active grants; out-of-grant triggers escalation.
   * - L4_FULL_MISSION_AUTONOMY: Autonomous replanning and full execution within active grants.
   *   STRICT INVARIANT: L4 STILL passes through Authority Gate!
   */
  static evaluatePolicy(
    level: AutonomyLevel,
    proposal: Proposal,
    activeGrants: readonly Grant[],
  ): AutonomyDecision {
    const capability = proposal.capability;
    const hasMatchingGrant = activeGrants.some((g) => g.capability === capability);

    switch (level) {
      case "L0_ASK":
        return {
          level,
          capability,
          requiresApproval: true,
          approved: false,
          reason: "L0_ASK requires explicit user approval for all capability execution",
        };

      case "L1_SUGGEST":
        return {
          level,
          capability,
          requiresApproval: true,
          approved: false,
          reason: "L1_SUGGEST treats proposals as suggestions awaiting operator confirmation",
        };

      case "L2_SAFE_AUTONOMOUS": {
        const isReadOnly = READ_ONLY_CAPABILITIES.has(capability);
        if (isReadOnly && hasMatchingGrant) {
          return {
            level,
            capability,
            requiresApproval: false,
            approved: true,
            reason: `L2_SAFE_AUTONOMOUS allows read-only capability "${capability}" automatically`,
          };
        }
        return {
          level,
          capability,
          requiresApproval: true,
          approved: false,
          reason: `L2_SAFE_AUTONOMOUS requires operator approval for state-modifying capability "${capability}"`,
        };
      }

      case "L3_GOVERNED_AUTONOMOUS": {
        if (hasMatchingGrant) {
          return {
            level,
            capability,
            requiresApproval: false,
            approved: true,
            reason: `L3_GOVERNED_AUTONOMOUS authorizes granted capability "${capability}" within policy envelope`,
          };
        }
        return {
          level,
          capability,
          requiresApproval: true,
          approved: false,
          reason: `L3_GOVERNED_AUTONOMOUS requires escalation approval for ungranted capability "${capability}"`,
        };
      }

      case "L4_FULL_MISSION_AUTONOMY": {
        // L4 permits full autonomous loop progression, BUT does not bypass gate grants.
        if (hasMatchingGrant) {
          return {
            level,
            capability,
            requiresApproval: false,
            approved: true,
            reason: `L4_FULL_MISSION_AUTONOMY authorizes execution of granted capability "${capability}"`,
          };
        }
        // Out-of-grant still requires escalation receipt or replan
        return {
          level,
          capability,
          requiresApproval: true,
          approved: false,
          reason: `L4_FULL_MISSION_AUTONOMY cannot bypass missing grant for "${capability}" — escalation required`,
        };
      }

      default:
        return {
          level: "L0_ASK",
          capability,
          requiresApproval: true,
          approved: false,
          reason: "Defaulting to safe L0_ASK approval requirement",
        };
    }
  }
}
