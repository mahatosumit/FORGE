// FORGE Model Runtime — Mock Provider for Deterministic Testing (Step 5)

import type {
  ModelEvent,
  ModelRequest,
  ModelError,
  ModelErrorCode,
} from "../../contracts/model.js";
import type { ModelProvider, ModelCapabilities } from "../types.js";
import type { ModelDecision } from "../decision.js";

export type MockResponseItem =
  | { type: "decision"; decision: ModelDecision; delayMs?: number }
  | { type: "raw"; text: string; delayMs?: number }
  | { type: "events"; events: ModelEvent[]; delayMs?: number }
  | { type: "error"; code: ModelErrorCode; message: string; delayMs?: number };

export class MockModelProvider implements ModelProvider {
  public readonly id: string;
  public readonly name: string;
  private queue: MockResponseItem[] = [];
  public callHistory: ModelRequest[] = [];

  constructor(
    id: string = "mock-provider",
    name: string = "Mock Model Provider",
    private capabilities: ModelCapabilities = {
      contextWindow: 128_000,
      toolSupport: true,
      visionSupport: true,
      reasoningCapability: true,
      streaming: true,
      maxOutputTokens: 4096,
    },
  ) {
    this.id = id;
    this.name = name;
  }

  getCapabilities(): ModelCapabilities {
    return this.capabilities;
  }

  enqueue(item: MockResponseItem): void {
    this.queue.push(item);
  }

  enqueueDecision(decision: ModelDecision, delayMs?: number): void {
    this.queue.push({ type: "decision", decision, delayMs });
  }

  enqueueError(code: ModelErrorCode, message: string, delayMs?: number): void {
    this.queue.push({ type: "error", code, message, delayMs });
  }

  enqueueText(text: string, delayMs?: number): void {
    this.queue.push({ type: "raw", text, delayMs });
  }

  async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
    this.callHistory.push(req);

    if (this.queue.length === 0) {
      // Default fallback response: complete task
      yield {
        type: "text-delta",
        text: JSON.stringify({
          analysis: "Task completed based on mock default evaluation",
          decisionType: "complete_task",
        }),
      };
      yield { type: "usage", tokensIn: 50, tokensOut: 20 };
      return;
    }

    const item = this.queue.shift()!;

    if (item.delayMs && item.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, item.delayMs));
    }

    // Check if request signal was already aborted during delay
    if (req.signal.aborted) {
      yield {
        type: "error",
        error: { code: "Transport", message: "Request aborted" },
      };
      return;
    }

    switch (item.type) {
      case "decision": {
        yield {
          type: "text-delta",
          text: JSON.stringify(item.decision),
        };
        yield { type: "usage", tokensIn: 100, tokensOut: 50 };
        break;
      }
      case "raw": {
        yield {
          type: "text-delta",
          text: item.text,
        };
        yield { type: "usage", tokensIn: 80, tokensOut: 40 };
        break;
      }
      case "events": {
        for (const ev of item.events) {
          yield ev;
        }
        break;
      }
      case "error": {
        yield {
          type: "error",
          error: { code: item.code, message: item.message },
        };
        break;
      }
    }
  }

  clear(): void {
    this.queue = [];
    this.callHistory = [];
  }
}
