// FORGE Model Runtime — Governed Model Router (Step 5)
// Routes model requests, handles transparent provider failover on transient errors,
// tracks token consumption, and appends durable ledger events without leaking secrets.

import type {
  ModelEvent,
  ModelRequest,
  ModelError,
  ModelErrorCode,
} from "../contracts/model.js";
import type { Task } from "../contracts/plan.js";
import type { AutonomousMissionStore } from "../mission-engine/store.js";
import type { ProviderRegistry, ModelRegistry } from "./registry.js";
import type { ModelResponse, ModelDescriptor } from "./types.js";

export interface ModelRouterOptions {
  providerRegistry: ProviderRegistry;
  modelRegistry: ModelRegistry;
  timeoutMs?: number;
  fallbackProviderId?: string;
}

export class ModelRouter {
  constructor(private readonly opts: ModelRouterOptions) {}

  /**
   * Invokes the chosen or default model for the current task context,
   * tracking token usage and recording model events to the cryptographic ledger.
   */
  async invokeModel(
    req: ModelRequest,
    task?: Task,
    store?: AutonomousMissionStore,
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const modelDesc = this.opts.modelRegistry.resolveModelForTask(task);
    const provider = this.opts.providerRegistry.getProvider(modelDesc.providerId);

    if (!provider) {
      throw new Error(
        `Provider "${modelDesc.providerId}" not found in ProviderRegistry for model "${modelDesc.modelId}"`,
      );
    }

    const taskId = task ? task.taskId : null;
    const promptTokensEstimate = Math.ceil(
      req.messages.reduce((acc, m) => acc + m.content.length, 0) / 4,
    );

    // Append model.requested to ledger
    if (store) {
      store.appendRecord("model.requested", {
        taskId,
        modelId: modelDesc.modelId,
        providerId: provider.id,
        promptTokensEstimate,
        messageCount: req.messages.length,
      });
    }

    const events: ModelEvent[] = [];
    let fullText = "";
    let tokensIn = promptTokensEstimate;
    let tokensOut = 0;
    let stopReason = "complete";
    let failureError: ModelError | null = null;

    try {
      for await (const event of provider.complete(req)) {
        events.push(event);

        if (event.type === "text-delta") {
          fullText += event.text;
        } else if (event.type === "usage") {
          tokensIn = event.tokensIn;
          tokensOut = event.tokensOut;
        } else if (event.type === "error") {
          failureError = event.error;
          break;
        }
      }
    } catch (err) {
      failureError = {
        code: "Transport",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let effectiveProviderId = provider.id;

    // Check if fallback failover is needed
    if (failureError && (failureError.code === "RateLimited" || failureError.code === "Transport")) {
      const fallbackId = this.opts.fallbackProviderId;
      if (fallbackId && fallbackId !== provider.id && this.opts.providerRegistry.hasProvider(fallbackId)) {
        const fallbackProvider = this.opts.providerRegistry.getProvider(fallbackId)!;

        // Record failure of primary in ledger
        if (store) {
          store.appendRecord("model.failed", {
            taskId,
            modelId: modelDesc.modelId,
            providerId: provider.id,
            errorCode: failureError.code,
            errorMessage: `${failureError.message} (Triggering failover to ${fallbackId})`,
            retryable: true,
          });
          store.getMission().budgetConsumed.modelCalls++;
        }

        // Attempt fallback invocation
        try {
          events.length = 0;
          fullText = "";
          failureError = null;

          let fbTokensIn = promptTokensEstimate;
          let fbTokensOut = 0;

          for await (const fbEvent of fallbackProvider.complete(req)) {
            events.push(fbEvent);
            if (fbEvent.type === "text-delta") {
              fullText += fbEvent.text;
            } else if (fbEvent.type === "usage") {
              fbTokensIn = fbEvent.tokensIn;
              fbTokensOut = fbEvent.tokensOut;
            } else if (fbEvent.type === "error") {
              failureError = fbEvent.error;
              break;
            }
          }

          tokensIn += fbTokensIn;
          tokensOut += fbTokensOut;

          if (!failureError) {
            effectiveProviderId = fallbackId;
          }
        } catch (fbErr) {
          failureError = {
            code: "Transport",
            message: `Fallback failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
          };
        }
      }
    }

    const durationMs = Date.now() - startTime;

    if (failureError) {
      if (store) {
        store.appendRecord("model.failed", {
          taskId,
          modelId: modelDesc.modelId,
          providerId: effectiveProviderId,
          errorCode: failureError.code,
          errorMessage: failureError.message,
          retryable: failureError.code === "RateLimited" || failureError.code === "Transport",
        });
      }

      throw new Error(`Model invocation failed [${failureError.code}]: ${failureError.message}`);
    }

    // Append model.completed to ledger
    if (store) {
      store.appendRecord("model.completed", {
        taskId,
        modelId: modelDesc.modelId,
        providerId: effectiveProviderId,
        tokensIn,
        tokensOut,
        durationMs,
        stopReason,
      });

      // Update budget consumed
      const mission = store.getMission();
      mission.budgetConsumed.modelCalls++;
      mission.budgetConsumed.tokensIn += tokensIn;
      mission.budgetConsumed.tokensOut += tokensOut;

      store.appendRecord("budget.updated", {
        modelCalls: mission.budgetConsumed.modelCalls,
        tokensUsed: mission.budgetConsumed.tokensIn + mission.budgetConsumed.tokensOut,
        wallClockMs: mission.budgetConsumed.executionTimeMs,
        remainingTurns: Math.max(0, mission.budget.maxPlannerTurns - mission.budgetConsumed.plannerTurns),
        remainingTokens: Math.max(0, mission.budget.maxTokens - (mission.budgetConsumed.tokensIn + mission.budgetConsumed.tokensOut)),
      });
    }

    return {
      modelId: modelDesc.modelId,
      providerId: effectiveProviderId,
      text: fullText,
      events,
      tokensIn,
      tokensOut,
      durationMs,
      stopReason,
    };
  }
}
