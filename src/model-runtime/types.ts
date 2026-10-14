// FORGE Model Runtime — Core Types & Abstractions (Step 5)

import type {
  ModelEvent,
  ModelRequest,
  ModelError,
  ModelErrorCode,
  ModelMessage,
} from "../contracts/model.js";
import type { Proposal, ProposalMeta } from "../contracts/proposals.js";
import type { Grant } from "../contracts/grants.js";
import type { AutonomyLevel } from "../contracts/mission.js";
import type { Task } from "../contracts/plan.js";

export { type AutonomyLevel } from "../contracts/mission.js";

export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly toolSupport: boolean;
  readonly visionSupport: boolean;
  readonly reasoningCapability: boolean;
  readonly streaming: boolean;
  readonly maxOutputTokens: number;
  readonly configurableLimits?: {
    readonly maxTokens?: number;
    readonly temperature?: number;
  };
}

export interface ModelDescriptor {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
  readonly isDefault?: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly name: string;
  getCapabilities(): ModelCapabilities;
  complete(req: ModelRequest): AsyncGenerator<ModelEvent>;
}

export interface ModelResponse {
  readonly modelId?: string;
  readonly providerId?: string;
  readonly text: string;
  readonly events: readonly ModelEvent[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
  readonly stopReason: string;
}

export interface AutonomyDecision {
  readonly level: AutonomyLevel;
  readonly capability: string;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly reason: string;
}

export interface ModelInvocationContext {
  readonly taskId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly promptTokensEstimate: number;
  readonly messageCount: number;
}
