// FORGE Multi-Agent Attribution Binding (Step 8 Phase 2B.5: Attribution Binding)
// Enforces cryptographic and metadata attribution for all multi-agent execution frames.
// Guarantees: A child agent cannot masquerade as its parent, cannot impersonate siblings,
//             and cannot emit un-attributed records or side effects.

import type { MissionId, AgentId, DelegationId, IncarnationEpoch } from "../contracts/index.js";
import type { GateCallerContext } from "../gate/gate.js";

export class AttributionViolationError extends Error {
  constructor(public readonly violationType: string, message: string) {
    super(`AttributionViolationError [${violationType}]: ${message}`);
    this.name = "AttributionViolationError";
  }
}

export interface ExpectedAttributionContext {
  childMissionId: MissionId;
  childAgentId: AgentId;
  delegationId: DelegationId;
  incarnationEpoch: IncarnationEpoch;
}

export class AttributionBindingValidator {
  /**
   * Validates that an incoming execution request or proposal carries valid attribution.
   */
  static validateCallerContext(
    caller: GateCallerContext | undefined,
    expected: ExpectedAttributionContext,
  ): void {
    if (!caller) {
      throw new AttributionViolationError("missing_caller_context", "Child execution proposal lacks callerContext");
    }

    if (caller.delegationId !== expected.delegationId) {
      throw new AttributionViolationError(
        "delegation_mismatch",
        `Caller delegationId "${caller.delegationId}" does not match expected "${expected.delegationId}"`,
      );
    }

    if (caller.agentId !== expected.childAgentId) {
      throw new AttributionViolationError(
        "agent_mismatch",
        `Caller agentId "${caller.agentId}" does not match expected childAgentId "${expected.childAgentId}"`,
      );
    }

    if (caller.incarnationEpoch !== expected.incarnationEpoch) {
      throw new AttributionViolationError(
        "epoch_mismatch",
        `Caller incarnationEpoch ${caller.incarnationEpoch} does not match authoritative epoch ${expected.incarnationEpoch}`,
      );
    }
  }

  /**
   * Validates that a ledger record is strictly attributed to the child mission.
   */
  static validateRecordAttribution(
    recordMissionId: string,
    expectedMissionId: string,
  ): void {
    if (recordMissionId !== expectedMissionId) {
      throw new AttributionViolationError(
        "mission_masquerade",
        `Child record attempted to cite missionId "${recordMissionId}" instead of bound missionId "${expectedMissionId}"`,
      );
    }
  }
}
