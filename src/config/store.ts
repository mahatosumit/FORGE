import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface ProviderCapabilityMetadata {
  streaming: boolean;
  toolCall: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  vision: boolean;
  contextWindow: number;
  maxOutputTokens?: number;
}

export interface ProviderConfig {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic-messages" | "nvidia-nim" | "custom";
  protocol?: "openai-v1" | "anthropic-v1" | "nvidia-nim-v1";
  baseUrl: string;
  apiKeyEnvVar: string;
  maskedApiKey?: string;
  authMethod?: "bearer" | "x-api-key" | "none";
  model: string;
  availableModels: string[];
  fallbackModels?: string[];
  enabled: boolean;
  isDefault: boolean;
  status?: "healthy" | "untested" | "error" | "unconfigured";
  lastTestedAt?: string;
  lastLatencyMs?: number;
  latencyMs?: number;
  lastError?: string;
  capabilities?: ProviderCapabilityMetadata;
  timeoutMs?: number;
  retryCount?: number;
  concurrency?: number;
}

export interface ModelMetadata {
  id: string;
  providerId: string;
  displayName: string;
  contextLength: number;
  inputCapabilities: string[];
  outputCapabilities: string[];
  reasoning: boolean;
  toolCall: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  cost?: {
    inputCostPer1M: number;
    outputCostPer1M: number;
  };
  status: "available" | "unavailable" | "unknown";
  latencyHistory?: number[];
  usage?: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
  };
  defaultParameters?: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    reasoningEffort?: "low" | "medium" | "high";
    systemPrompt?: string;
  };
}

export interface CredentialConfig {
  id: string;
  name: string;
  envVar: string;
  maskedValue: string;
  providerId?: string;
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt?: string;
  lastTestedAt?: string;
  lastStatus?: "valid" | "invalid" | "unset";
}

export interface WorkspaceConfig {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  createdAt: string;
  runtimeEnvironment?: "local" | "container";
  allowedPaths?: string[];
  preferredProviderId?: string;
  preferredModelId?: string;
  verificationPolicy?: "basic" | "standard" | "strict" | "custom";
  gitStatusSummary?: string;
}

export interface ForgeSettings {
  defaultAuthority: "read-only" | "safe-dev" | "full-dev" | "custom";
  defaultVerification: "basic" | "standard" | "strict" | "custom";
  theme: "dark";
  routingStrategy: "single" | "fallback" | "best-available" | "cost-optimized" | "capability-match";
  maxRetries: number;
  executionEnvironment?: "local" | "container";
  concurrency?: number;
  approvalPolicy?: "on-escalation" | "always-prompt" | "never-prompt";
  gitPolicy?: {
    branchAllowed: boolean;
    commitAllowed: boolean;
    pushAllowed: boolean;
  };
  networkPolicy?: {
    disabled: boolean;
    allowedHosts: string[];
  };
}

export interface FullForgeConfig {
  version: "1.1.0";
  dataDir: string;
  activeWorkspaceId: string;
  activeProviderId: string;
  activeModelId: string;
  activeFallbackModelId?: string;
  providers: ProviderConfig[];
  models?: ModelMetadata[];
  credentials: CredentialConfig[];
  workspaces: WorkspaceConfig[];
  settings: ForgeSettings;
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly forgeDir: string;
  private state: FullForgeConfig;

  constructor(forgeDir: string) {
    this.forgeDir = forgeDir;
    this.configPath = join(forgeDir, "forge-config.json");
    mkdirSync(forgeDir, { recursive: true });
    this.state = this.loadOrCreate();
  }

  static findForgeDir(startDir: string = process.cwd()): string {
    return join(resolve(startDir), ".forge");
  }

  private loadEnv(): void {
    const envPaths = [
      join(process.cwd(), ".env"),
      join(this.forgeDir, ".env"),
    ];
    for (const p of envPaths) {
      if (!existsSync(p)) continue;
      try {
        const lines = readFileSync(p, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx > 0) {
            const key = trimmed.slice(0, idx).trim();
            let val = trimmed.slice(idx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            if (process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  private loadOrCreate(): FullForgeConfig {
    this.loadEnv();
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<FullForgeConfig>;
        return this.normalizeConfig(parsed);
      } catch {
        // fall through to default if corrupt
      }
    }

    // Default configuration with pre-configured provider templates
    const defaultWorkspaceId = "ws-default";
    const defaultProviderId = process.env["NVIDIA_API_KEY"] ? "nvidia-nim" : "openai";

    const defaultProviders: ProviderConfig[] = [
      {
        id: "nvidia-nim",
        name: "NVIDIA NIM",
        kind: "openai-compatible",
        protocol: "nvidia-nim-v1",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnvVar: "NVIDIA_API_KEY",
        maskedApiKey: process.env["NVIDIA_API_KEY"] ? maskKey(process.env["NVIDIA_API_KEY"]) : undefined,
        authMethod: "bearer",
        model: "moonshotai/kimi-k3",
        availableModels: [
          "moonshotai/kimi-k3",
          "meta/llama-3.2-11b-vision-instruct",
          "meta/llama-3.2-90b-vision-instruct",
          "deepseek-ai/deepseek-r1",
          "mistralai/codestral-22b-instruct-v0.1",
        ],
        fallbackModels: ["meta/llama-3.2-11b-vision-instruct"],
        enabled: true,
        isDefault: Boolean(process.env["NVIDIA_API_KEY"]),
        status: process.env["NVIDIA_API_KEY"] ? "untested" : "unconfigured",
        capabilities: {
          streaming: true,
          toolCall: true,
          reasoning: true,
          structuredOutput: true,
          vision: true,
          contextWindow: 131_072,
          maxOutputTokens: 16_384,
        },
        timeoutMs: 60_000,
        retryCount: 3,
        concurrency: 5,
      },
      {
        id: "openai",
        name: "OpenAI",
        kind: "openai-compatible",
        protocol: "openai-v1",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "OPENAI_API_KEY",
        maskedApiKey: process.env["OPENAI_API_KEY"] ? maskKey(process.env["OPENAI_API_KEY"]) : undefined,
        authMethod: "bearer",
        model: "gpt-4o-mini",
        availableModels: ["gpt-4o-mini", "gpt-4o", "o1", "o3-mini"],
        fallbackModels: ["gpt-4o-mini"],
        enabled: true,
        isDefault: !process.env["NVIDIA_API_KEY"],
        status: process.env["OPENAI_API_KEY"] ? "untested" : "unconfigured",
        capabilities: {
          streaming: true,
          toolCall: true,
          reasoning: true,
          structuredOutput: true,
          vision: true,
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
        },
        timeoutMs: 45_000,
        retryCount: 3,
        concurrency: 5,
      },
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic-messages",
        protocol: "anthropic-v1",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnvVar: "ANTHROPIC_API_KEY",
        maskedApiKey: process.env["ANTHROPIC_API_KEY"] ? maskKey(process.env["ANTHROPIC_API_KEY"]) : undefined,
        authMethod: "x-api-key",
        model: "claude-3-5-sonnet-20241022",
        availableModels: [
          "claude-3-5-sonnet-20241022",
          "claude-3-5-haiku-20241022",
          "claude-3-7-sonnet-20250219",
        ],
        fallbackModels: ["claude-3-5-haiku-20241022"],
        enabled: true,
        isDefault: false,
        status: process.env["ANTHROPIC_API_KEY"] ? "untested" : "unconfigured",
        capabilities: {
          streaming: true,
          toolCall: true,
          reasoning: true,
          structuredOutput: true,
          vision: true,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
        timeoutMs: 60_000,
        retryCount: 3,
        concurrency: 4,
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        kind: "openai-compatible",
        protocol: "openai-v1",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnvVar: "DEEPSEEK_API_KEY",
        maskedApiKey: process.env["DEEPSEEK_API_KEY"] ? maskKey(process.env["DEEPSEEK_API_KEY"]) : undefined,
        authMethod: "bearer",
        model: "deepseek-chat",
        availableModels: ["deepseek-chat", "deepseek-reasoner"],
        enabled: false,
        isDefault: false,
        status: process.env["DEEPSEEK_API_KEY"] ? "untested" : "unconfigured",
        capabilities: {
          streaming: true,
          toolCall: true,
          reasoning: true,
          structuredOutput: true,
          vision: false,
          contextWindow: 64_000,
        },
      },
      {
        id: "ollama-local",
        name: "Ollama (Local)",
        kind: "openai-compatible",
        protocol: "openai-v1",
        baseUrl: "http://localhost:11434/v1",
        apiKeyEnvVar: "OLLAMA_API_KEY",
        maskedApiKey: "none (local)",
        authMethod: "none",
        model: "qwen2.5-coder",
        availableModels: ["qwen2.5-coder", "deepseek-r1:14b", "llama3.1"],
        enabled: false,
        isDefault: false,
        status: "untested",
        capabilities: {
          streaming: true,
          toolCall: true,
          reasoning: false,
          structuredOutput: true,
          vision: false,
          contextWindow: 32_768,
        },
      },
    ];

    const defaultModels: ModelMetadata[] = [
      {
        id: "moonshotai/kimi-k3",
        providerId: "nvidia-nim",
        displayName: "Moonshot Kimi K3 (NVIDIA NIM)",
        contextLength: 131_072,
        inputCapabilities: ["text", "code"],
        outputCapabilities: ["text", "code", "structured-json"],
        reasoning: true,
        toolCall: true,
        streaming: true,
        structuredOutput: true,
        vision: false,
        cost: { inputCostPer1M: 0, outputCostPer1M: 0 },
        status: "available",
        defaultParameters: { temperature: 0.2, topP: 0.95, maxTokens: 8192 },
      },
      {
        id: "gpt-4o-mini",
        providerId: "openai",
        displayName: "GPT-4o Mini (OpenAI)",
        contextLength: 128_000,
        inputCapabilities: ["text", "code", "vision"],
        outputCapabilities: ["text", "code", "structured-json"],
        reasoning: false,
        toolCall: true,
        streaming: true,
        structuredOutput: true,
        vision: true,
        cost: { inputCostPer1M: 0.15, outputCostPer1M: 0.6 },
        status: "available",
        defaultParameters: { temperature: 0.2, topP: 1.0, maxTokens: 4096 },
      },
      {
        id: "claude-3-5-sonnet-20241022",
        providerId: "anthropic",
        displayName: "Claude 3.5 Sonnet (Anthropic)",
        contextLength: 200_000,
        inputCapabilities: ["text", "code", "vision"],
        outputCapabilities: ["text", "code", "structured-json"],
        reasoning: false,
        toolCall: true,
        streaming: true,
        structuredOutput: true,
        vision: true,
        cost: { inputCostPer1M: 3.0, outputCostPer1M: 15.0 },
        status: "available",
        defaultParameters: { temperature: 0.2, topP: 1.0, maxTokens: 8192 },
      },
    ];

    const cfg: FullForgeConfig = {
      version: "1.1.0",
      dataDir: join(this.forgeDir, "data"),
      activeWorkspaceId: defaultWorkspaceId,
      activeProviderId: defaultProviderId,
      activeModelId: process.env["NVIDIA_API_KEY"] ? "moonshotai/kimi-k3" : "gpt-4o-mini",
      activeFallbackModelId: "gpt-4o-mini",
      providers: defaultProviders,
      models: defaultModels,
      credentials: this.collectEnvCredentials(),
      workspaces: [
        {
          id: defaultWorkspaceId,
          name: "Default Workspace",
          path: process.cwd(),
          isDefault: true,
          createdAt: new Date().toISOString(),
          runtimeEnvironment: "local",
          verificationPolicy: "standard",
        },
      ],
      settings: {
        defaultAuthority: "safe-dev",
        defaultVerification: "standard",
        theme: "dark",
        routingStrategy: "fallback",
        maxRetries: 3,
        executionEnvironment: "local",
        concurrency: 1,
        approvalPolicy: "on-escalation",
        gitPolicy: {
          branchAllowed: true,
          commitAllowed: true,
          pushAllowed: false,
        },
        networkPolicy: {
          disabled: false,
          allowedHosts: ["integrate.api.nvidia.com", "api.openai.com", "api.anthropic.com"],
        },
      },
    };

    this.save(cfg);
    return cfg;
  }

  private collectEnvCredentials(): CredentialConfig[] {
    const creds: CredentialConfig[] = [];
    const checkVars = ["NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OLLAMA_API_KEY"];
    for (const v of checkVars) {
      const val = process.env[v];
      if (val) {
        creds.push({
          id: `cred-${v.toLowerCase().replace(/_/g, "-")}`,
          name: v,
          envVar: v,
          maskedValue: maskKey(val),
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastStatus: "valid",
        });
      }
    }
    return creds;
  }

  private normalizeConfig(partial: Partial<FullForgeConfig>): FullForgeConfig {
    const base = this.state || {};
    return {
      version: "1.1.0",
      dataDir: partial.dataDir || base.dataDir || join(this.forgeDir, "data"),
      activeWorkspaceId: partial.activeWorkspaceId || base.activeWorkspaceId || "ws-default",
      activeProviderId: partial.activeProviderId || base.activeProviderId || "openai",
      activeModelId: partial.activeModelId || base.activeModelId || "gpt-4o-mini",
      activeFallbackModelId: partial.activeFallbackModelId || base.activeFallbackModelId,
      providers: partial.providers || base.providers || [],
      models: partial.models || base.models || [],
      credentials: partial.credentials || base.credentials || [],
      workspaces: partial.workspaces || base.workspaces || [
        {
          id: "ws-default",
          name: "Default Workspace",
          path: process.cwd(),
          isDefault: true,
          createdAt: new Date().toISOString(),
          runtimeEnvironment: "local",
        },
      ],
      settings: partial.settings || base.settings || {
        defaultAuthority: "safe-dev",
        defaultVerification: "standard",
        theme: "dark",
        routingStrategy: "fallback",
        maxRetries: 3,
        executionEnvironment: "local",
        concurrency: 1,
        approvalPolicy: "on-escalation",
      },
    };
  }

  private save(cfg: FullForgeConfig): void {
    this.state = cfg;
    try {
      writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), "utf8");
    } catch {
      /* handle write error */
    }
  }

  getConfig(): FullForgeConfig {
    return { ...this.state };
  }

  // --- Provider Operations ---
  getProviders(): ProviderConfig[] {
    return this.state.providers;
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.state.providers.find((p) => p.id === id);
  }

  addOrUpdateProvider(p: Omit<ProviderConfig, "id"> & { id?: string }): ProviderConfig {
    const id = p.id || `provider-${randomBytes(4).toString("hex")}`;
    const existingIdx = this.state.providers.findIndex((item) => item.id === id);
    const existing = existingIdx >= 0 ? this.state.providers[existingIdx] : undefined;

    const updated: ProviderConfig = {
      ...existing,
      ...p,
      id,
      availableModels: p.availableModels && p.availableModels.length > 0
        ? p.availableModels
        : (existing?.availableModels || [p.model]),
      enabled: p.enabled !== undefined ? p.enabled : (existing?.enabled ?? true),
      isDefault: p.isDefault !== undefined ? p.isDefault : (existing?.isDefault ?? false),
      status: p.status || existing?.status || "untested",
    };

    if (updated.isDefault) {
      for (const prov of this.state.providers) {
        prov.isDefault = false;
      }
      this.state.activeProviderId = id;
      this.state.activeModelId = updated.model;
    }

    if (existingIdx >= 0) {
      this.state.providers[existingIdx] = updated;
    } else {
      this.state.providers.push(updated);
    }

    this.save(this.state);
    return updated;
  }

  deleteProvider(id: string): boolean {
    const idx = this.state.providers.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.state.providers.splice(idx, 1);
    if (this.state.activeProviderId === id && this.state.providers.length > 0) {
      this.state.activeProviderId = this.state.providers[0]!.id;
      this.state.activeModelId = this.state.providers[0]!.model;
      this.state.providers[0]!.isDefault = true;
    }
    this.save(this.state);
    return true;
  }

  setDefaultProvider(id: string): boolean {
    const p = this.getProvider(id);
    if (!p) return false;
    for (const prov of this.state.providers) {
      prov.isDefault = prov.id === id;
    }
    this.state.activeProviderId = id;
    this.state.activeModelId = p.model;
    this.save(this.state);
    return true;
  }

  updateProviderStatus(id: string, status: ProviderConfig["status"], latencyMs?: number, err?: string): void {
    const p = this.getProvider(id);
    if (!p) return;
    p.status = status;
    p.lastTestedAt = new Date().toISOString();
    if (latencyMs !== undefined) {
      p.lastLatencyMs = latencyMs;
      p.latencyMs = latencyMs;
    }
    if (err !== undefined) p.lastError = err;
    this.save(this.state);
  }

  // --- Model Operations ---
  getModels(providerId?: string): ModelMetadata[] {
    const list = this.state.models || [];
    if (!providerId) return list;
    return list.filter((m) => m.providerId === providerId);
  }

  getModel(id: string, providerId?: string): ModelMetadata | undefined {
    const list = this.state.models || [];
    if (providerId) {
      return list.find((m) => m.id === id && m.providerId === providerId);
    }
    return list.find((m) => m.id === id);
  }

  registerModel(m: ModelMetadata): ModelMetadata {
    return this.addOrUpdateModel(m);
  }

  addOrUpdateModel(m: ModelMetadata): ModelMetadata {
    if (!this.state.models) this.state.models = [];
    const idx = this.state.models.findIndex((x) => x.id === m.id && x.providerId === m.providerId);
    if (idx >= 0) {
      this.state.models[idx] = { ...this.state.models[idx], ...m };
    } else {
      this.state.models.push(m);
    }
    this.save(this.state);
    return m;
  }

  updateModelParameters(id: string, params: ModelMetadata["defaultParameters"], providerId?: string): boolean {
    const m = this.getModel(id, providerId);
    if (!m) return false;
    m.defaultParameters = { ...m.defaultParameters, ...params };
    this.save(this.state);
    return true;
  }

  setActiveModel(providerId: string, modelId: string, fallbackModelId?: string): boolean {
    const p = this.getProvider(providerId);
    if (!p) return false;
    this.state.activeProviderId = providerId;
    this.state.activeModelId = modelId;
    if (fallbackModelId !== undefined) this.state.activeFallbackModelId = fallbackModelId;
    this.save(this.state);
    return true;
  }

  recordModelUsage(id: string, promptTokens: number, completionTokens: number, providerId?: string): void {
    const m = this.getModel(id, providerId);
    if (!m) return;
    if (!m.usage) {
      m.usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    }
    m.usage.requests++;
    m.usage.promptTokens += promptTokens;
    m.usage.completionTokens += completionTokens;
    this.save(this.state);
  }

  // --- Credential Operations ---
  getCredentials(): CredentialConfig[] {
    return this.state.credentials;
  }

  getCredential(idOrEnv: string): CredentialConfig | undefined {
    return this.state.credentials.find((c) => c.id === idOrEnv || c.envVar === idOrEnv);
  }

  addCredential(envVar: string, rawValue?: string, name?: string, providerId?: string): CredentialConfig {
    const id = `cred-${envVar.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
    if (rawValue) {
      process.env[envVar] = rawValue;
      // Also write to .forge/.env for persistent restarts
      try {
        const envPath = join(this.forgeDir, ".env");
        let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const lines = content.split("\n").filter((l) => !l.startsWith(`${envVar}=`));
        lines.push(`${envVar}=${rawValue}`);
        writeFileSync(envPath, lines.join("\n").trim() + "\n", "utf8");
      } catch {
        /* ignore */
      }
    }
    const val = rawValue || process.env[envVar] || "";
    const cred: CredentialConfig = {
      id,
      name: name || envVar,
      envVar,
      maskedValue: maskKey(val),
      providerId,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: val ? "valid" : "unset",
    };

    const idx = this.state.credentials.findIndex((c) => c.id === id);
    if (idx >= 0) this.state.credentials[idx] = cred;
    else this.state.credentials.push(cred);

    // Update corresponding provider's masked key if applicable
    for (const prov of this.state.providers) {
      if (prov.apiKeyEnvVar === envVar) {
        prov.maskedApiKey = cred.maskedValue;
        if (prov.status === "unconfigured") prov.status = "untested";
      }
    }

    this.save(this.state);
    return cred;
  }

  rotateCredential(id: string, newRawValue: string): CredentialConfig | undefined {
    const cred = this.state.credentials.find((c) => c.id === id || c.envVar === id);
    if (!cred) return undefined;
    const updated = this.addCredential(cred.envVar, newRawValue, cred.name, cred.providerId);
    updated.lastRotatedAt = new Date().toISOString();
    this.save(this.state);
    return updated;
  }

  deleteCredential(id: string): boolean {
    const idx = this.state.credentials.findIndex((c) => c.id === id || c.envVar === id);
    if (idx < 0) return false;
    const cred = this.state.credentials[idx]!;
    delete process.env[cred.envVar];
    this.state.credentials.splice(idx, 1);

    // Update providers referencing this key
    for (const prov of this.state.providers) {
      if (prov.apiKeyEnvVar === cred.envVar) {
        prov.maskedApiKey = undefined;
        prov.status = "unconfigured";
      }
    }

    this.save(this.state);
    return true;
  }

  // --- Workspace Operations ---
  getWorkspaces(): WorkspaceConfig[] {
    return this.state.workspaces;
  }

  getCurrentWorkspace(): WorkspaceConfig {
    const ws = this.state.workspaces.find((w) => w.id === this.state.activeWorkspaceId);
    return ws || this.state.workspaces[0]!;
  }

  addWorkspace(name: string, path: string, options?: Partial<WorkspaceConfig>): WorkspaceConfig {
    const id = `ws-${randomBytes(4).toString("hex")}`;
    const ws: WorkspaceConfig = {
      id,
      name,
      path: resolve(path),
      isDefault: false,
      createdAt: new Date().toISOString(),
      runtimeEnvironment: options?.runtimeEnvironment || "local",
      allowedPaths: options?.allowedPaths,
      preferredProviderId: options?.preferredProviderId,
      preferredModelId: options?.preferredModelId,
      verificationPolicy: options?.verificationPolicy || "standard",
    };
    this.state.workspaces.push(ws);
    this.save(this.state);
    return ws;
  }

  switchWorkspace(id: string): WorkspaceConfig | undefined {
    const ws = this.state.workspaces.find((w) => w.id === id);
    if (!ws) return undefined;
    this.state.activeWorkspaceId = id;
    this.save(this.state);
    return ws;
  }

  deleteWorkspace(id: string): boolean {
    const idx = this.state.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return false;
    // Don't delete if it's the only workspace
    if (this.state.workspaces.length <= 1) return false;
    this.state.workspaces.splice(idx, 1);
    if (this.state.activeWorkspaceId === id) {
      this.state.activeWorkspaceId = this.state.workspaces[0]!.id;
    }
    this.save(this.state);
    return true;
  }

  updateWorkspace(id: string, updates: Partial<WorkspaceConfig>): WorkspaceConfig | undefined {
    const ws = this.state.workspaces.find((w) => w.id === id);
    if (!ws) return undefined;
    Object.assign(ws, updates);
    this.save(this.state);
    return ws;
  }

  // --- Settings ---
  getSettings(): ForgeSettings {
    return { ...this.state.settings };
  }

  updateSettings(settings: Partial<ForgeSettings>): ForgeSettings {
    this.state.settings = { ...this.state.settings, ...settings };
    this.save(this.state);
    return this.state.settings;
  }
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  const start = key.slice(0, 4);
  const end = key.slice(-4);
  return `${start}••••••••${end}`;
}
