// FORGE Model Runtime — Provider & Model Registries (Step 5)
// Manages registration of model providers and models with rich capabilities metadata.
// Supports global default selection and task-level model routing.

import type { ModelProvider, ModelDescriptor } from "./types.js";
import type { Task } from "../contracts/plan.js";

export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  clear(): void {
    this.providers.clear();
  }
}

export class ModelRegistry {
  private models = new Map<string, ModelDescriptor>();
  private defaultModelId: string | null = null;

  registerModel(descriptor: ModelDescriptor): void {
    this.models.set(descriptor.modelId, descriptor);
    if (descriptor.isDefault || !this.defaultModelId) {
      this.defaultModelId = descriptor.modelId;
    }
  }

  getModel(modelId: string): ModelDescriptor | undefined {
    return this.models.get(modelId);
  }

  hasModel(modelId: string): boolean {
    return this.models.has(modelId);
  }

  setDefaultModel(modelId: string): void {
    if (!this.models.has(modelId)) {
      throw new Error(`Cannot set unknown model ${modelId} as default`);
    }
    this.defaultModelId = modelId;
  }

  getDefaultModel(): ModelDescriptor | undefined {
    if (!this.defaultModelId) return undefined;
    return this.models.get(this.defaultModelId);
  }

  /**
   * Resolves the model to use for a specific task.
   * Checks task metadata / args first, falling back to global default.
   */
  resolveModelForTask(task?: Task): ModelDescriptor {
    if (task && task.args && typeof task.args["model"] === "string") {
      const taskModel = this.models.get(task.args["model"]);
      if (taskModel) return taskModel;
    }

    const defaultModel = this.getDefaultModel();
    if (defaultModel) return defaultModel;

    // Fallback: first registered model
    const first = Array.from(this.models.values())[0];
    if (first) return first;

    throw new Error("No models registered in ModelRegistry");
  }

  listModels(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }

  clear(): void {
    this.models.clear();
    this.defaultModelId = null;
  }
}
