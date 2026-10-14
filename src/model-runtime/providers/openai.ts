// FORGE Model Runtime — OpenAI-Compatible Provider Implementation (Step 5)
// Connects to any OpenAI-compatible API endpoint (OpenAI, Ollama, Groq, Together, DeepSeek, vLLM).
// Enforces that API keys are never stored in ledger records or mission state.

import type { ModelEvent, ModelRequest } from "../../contracts/model.js";
import type { ModelProvider, ModelCapabilities } from "../types.js";
import { resolveModelFn, type ProviderDescriptor } from "../../model-router/router.js";

export interface OpenAICompatibleOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  model?: string;
  contextWindow?: number;
  capabilities?: Partial<ModelCapabilities>;
}

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;
  public readonly name: string;
  private readonly descriptor: ProviderDescriptor;
  private readonly capabilities: ModelCapabilities;

  constructor(opts: OpenAICompatibleOptions = {}) {
    this.id = opts.id ?? "openai-default";
    this.name = opts.name ?? "OpenAI-Compatible Provider";

    this.descriptor = {
      id: this.id,
      kind: "openai-compatible",
      baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
      apiKeyEnvVar: opts.apiKeyEnvVar ?? "OPENAI_API_KEY",
      model: opts.model ?? "gpt-4o",
      contextWindow: opts.contextWindow ?? 128_000,
    };

    this.capabilities = {
      contextWindow: this.descriptor.contextWindow,
      toolSupport: true,
      visionSupport: true,
      reasoningCapability: true,
      streaming: true,
      maxOutputTokens: 4096,
      ...opts.capabilities,
    };
  }

  getCapabilities(): ModelCapabilities {
    return this.capabilities;
  }

  async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const fn = resolveModelFn(this.descriptor);
    for await (const event of fn.complete(req)) {
      yield event;
    }
  }
}
