// FORGE api — HTTP + SSE surface over the runtime (MODULES tier 5).
// Loopback bind + per-install bearer token; frontends are stateless clients.
// Full product platform: providers, models, credentials, workspaces, git,
// missions, authority escalation, tiered verification, and cryptographic receipts.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openMission, openMissionReadOnly, missionExists } from "../ledger/index.js";
import { webConsoleHtml } from "./webui.js";
import { Engine, type MissionConfigOptions, cleanModelNarrative } from "../engine/engine.js";
import type { ModelFn } from "../contracts/model.js";
import type { Grant } from "../contracts/index.js";
import { ConfigStore, type ProviderConfig, maskKey, type WorkspaceConfig } from "../config/store.js";
import { testProviderConnection } from "../model-router/tester.js";
import { getGitStatus, getGitDiff, createGitCommit } from "../environments/git.js";
import { resolveModelFn, resolveRoutingModelFn, type ProviderDescriptor } from "../model-router/router.js";
import { verifyChain, genesisHash } from "../codec/hashChain.js";
import { MarketplaceRegistry } from "../marketplace/registry.js";
import { MemoryStore } from "../memory/store.js";
import { scanRepository } from "../archify/archify.js";

export interface ApiOptions {
  dataDir: string;
  workspaceRoot: string;
  modelFn: ModelFn;
  port?: number;
  host?: string;
  configStore?: ConfigStore;
  /** how long an escalation waits for a decision before deny-on-timeout */
  escalationTimeoutMs?: number;
}

type Stream = (ev: string, data: unknown) => void;

interface EscalationWaiter {
  resolve: (d: { decision: "extend" | "deny"; expiresAt: string | null }) => void;
}

export interface MissionRecoveryInfo {
  missionId: string;
  status: "verified" | "failed" | "blocked" | "running" | "interrupted" | "pending_escalation" | "post_effect_unknown";
  closure: string | null;
  resumable: boolean;
  lastSeq: number;
  recordCount: number;
  goal: string;
  createdAt: string;
  updatedAt: string;
  lastProposal?: unknown;
  lastDispatch?: unknown;
  lastObservation?: unknown;
  pendingEscalation?: unknown;
  effectsMayHaveOccurred: boolean;
  reason: string;
}

export function classifyMissionRecovery(dataDir: string, missionId: string): MissionRecoveryInfo | null {
  if (!missionExists(dataDir, missionId)) return null;
  const s = openMissionReadOnly(dataDir, missionId);
  const status = s.status();
  const records = s.read();
  const lastRec = records[records.length - 1];
  const isClosed = status?.status === "closed";

  const dispatches = records.filter((r) => r.kind === "proposal.dispatched");
  const observations = records.filter((r) => r.kind.startsWith("observation."));
  const proposals = records.filter((r) => r.kind === "proposal.received");
  const escalations = records.filter((r) => r.kind === "grant.requested");
  const decisions = new Set(records.filter((r) => r.kind === "grant.decided").map((r) => (r.body as { requestId: string }).requestId));
  const pendingEscalation = escalations.find((e) => !decisions.has(e.id));

  const hasUnobservedDispatch = dispatches.length > observations.length;
  const effectsMayHaveOccurred = hasUnobservedDispatch;

  let state: MissionRecoveryInfo["status"];
  if (isClosed) {
    state = (status?.closure as any) || "blocked";
  } else if (pendingEscalation) {
    state = "pending_escalation";
  } else if (hasUnobservedDispatch) {
    state = "post_effect_unknown";
  } else {
    state = "interrupted";
  }

  const lastProposal = proposals.length > 0 ? proposals[proposals.length - 1] : undefined;
  const lastDispatch = dispatches.length > 0 ? dispatches[dispatches.length - 1] : undefined;
  const lastObservation = observations.length > 0 ? observations[observations.length - 1] : undefined;

  return {
    missionId,
    status: state,
    closure: status?.closure ?? null,
    resumable: !isClosed && state === "interrupted",
    lastSeq: records.length,
    recordCount: records.length,
    goal: status?.goal_summary ?? "",
    createdAt: records[0]?.ts ?? new Date().toISOString(),
    updatedAt: lastRec?.ts ?? new Date().toISOString(),
    lastProposal: lastProposal && lastProposal.kind === "proposal.received" ? lastProposal.body.proposal : undefined,
    lastDispatch: lastDispatch && lastDispatch.kind === "proposal.dispatched" ? lastDispatch.body : undefined,
    lastObservation: lastObservation ? { kind: lastObservation.kind, body: lastObservation.body } : undefined,
    pendingEscalation: pendingEscalation && pendingEscalation.kind === "grant.requested" ? { requestId: pendingEscalation.id, ...pendingEscalation.body } : undefined,
    effectsMayHaveOccurred,
    reason: isClosed ? `Closed with closure ${status?.closure}` : (hasUnobservedDispatch ? "Dispatched without recorded observation" : "Mission interrupted or awaiting turn"),
  };
}

export class ForgeApi {
  readonly token: string;
  private readonly server: Server;
  private readonly streams = new Set<Stream>();
  private readonly escalationWaiters = new Map<string, EscalationWaiter>();
  private readonly configStore: ConfigStore;
  private readonly marketplace: MarketplaceRegistry;
  private readonly memory: MemoryStore;
  private readonly activeTasks = new Map<string, { missionId: string; abortController: AbortController; startedAt: string }>();
  private actualPort = 0;

  constructor(private readonly opts: ApiOptions) {
    this.token = randomBytes(24).toString("hex");
    const forgeDir = ConfigStore.findForgeDir(opts.workspaceRoot);
    this.configStore = opts.configStore || new ConfigStore(forgeDir);
    this.marketplace = new MarketplaceRegistry(forgeDir);
    this.memory = new MemoryStore(forgeDir);
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  get port(): number {
    return this.actualPort;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") this.actualPort = addr.port;
        resolve();
      });
    });
  }

  close(): void {
    for (const w of this.escalationWaiters.values()) w.resolve({ decision: "deny", expiresAt: null });
    this.server.close();
  }

  private broadcast(ev: string, data: unknown): void {
    for (const s of this.streams) {
      try { s(ev, data); } catch { /* dead stream cleaned on close */ }
    }
  }

  /** RR-06: constant-time comparison for bearer material (header + SSE query). */
  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }

  private authed(req: IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (typeof header === "string" && this.safeEqual(header, `Bearer ${this.token}`)) return true;
    // EventSource cannot set headers — allow the token via query param,
    // restricted to the SSE endpoint only.
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const q = url.searchParams.get("token");
    return req.method === "GET" && parts[0] === "events" && typeof q === "string" && this.safeEqual(q, this.token);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).byteLength;
      if (size > 1024 * 1024) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  private resolveModelForMission(providerId?: string, modelId?: string, fallbackModelId?: string): ModelFn {
    if (!providerId && !modelId && this.opts.modelFn) {
      return this.opts.modelFn;
    }
    const cfg = this.configStore.getConfig();
    let pid = providerId || cfg.activeProviderId;
    let provider = this.configStore.getProvider(pid);

    if (!provider || (!process.env[provider.apiKeyEnvVar] && !provider.baseUrl.includes("localhost") && !provider.baseUrl.includes("127.0.0.1"))) {
      const configured = cfg.providers.find((p) => Boolean(process.env[p.apiKeyEnvVar]));
      if (configured) {
        pid = configured.id;
        provider = configured;
      }
    }

    if (!provider && this.opts.modelFn) return this.opts.modelFn;
    if (!provider) return this.opts.modelFn;

    const mid = modelId || (pid === cfg.activeProviderId ? cfg.activeModelId : provider.model);
    const d: ProviderDescriptor = {
      id: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      apiKeyEnvVar: provider.apiKeyEnvVar,
      model: mid,
      contextWindow: provider.capabilities?.contextWindow || 200_000,
    };

    const fallbackModel = fallbackModelId || cfg.activeFallbackModelId;
    // Credential pool for the primary provider (Hermes pattern): rotate keys
    // on rate-limit/auth failure before falling back to another provider.
    const pool = this.configStore
      .getCredentials()
      .filter((c) => c.providerId === provider.id && c.enabled !== false)
      .map((c) => c.envVar)
      .filter((k) => k !== provider.apiKeyEnvVar);
    if (fallbackModel && cfg.settings.routingStrategy === "fallback") {
      const fbProvider = cfg.providers.find((p) => p.availableModels.includes(fallbackModel)) || provider;
      const fbDesc: ProviderDescriptor = {
        id: fbProvider.id,
        kind: fbProvider.kind,
        baseUrl: fbProvider.baseUrl,
        apiKeyEnvVar: fbProvider.apiKeyEnvVar,
        model: fallbackModel,
        contextWindow: fbProvider.capabilities?.contextWindow || 200_000,
      };
      return resolveRoutingModelFn({
        primary: d,
        fallback: fbDesc,
        strategy: cfg.settings.routingStrategy,
        credentialPool: pool,
        onTransition: (from, to, reason) => {
          this.broadcast("model.fallback_activated", { from: from.model, to: to.model, reason });
        },
      });
    }

    if (pool.length > 0) {
      return resolveRoutingModelFn({ primary: d, credentialPool: pool });
    }
    return resolveModelFn(d);
  }

  private getActiveWorkspaceRoot(): string {
    return this.opts.workspaceRoot || this.configStore.getCurrentWorkspace()?.path || process.cwd();
  }

  private engine(workspaceRoot?: string, modelFn?: ModelFn): Engine {
    const ws = workspaceRoot ? resolve(workspaceRoot) : this.getActiveWorkspaceRoot();
    return new Engine({
      dataDir: this.opts.dataDir,
      workspaceRoot: ws,
      modelFn: modelFn || this.opts.modelFn,
      onEscalation: async (request: { missionId: string; requestId: string; capability: string; requested: Grant["constraints"]; rationale: string; citations: string[] }) => {
        this.broadcast("escalation.requested", request);
        const timeoutMs = this.opts.escalationTimeoutMs ?? 180_000;
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.escalationWaiters.delete(request.requestId);
            resolve({ decision: "deny", expiresAt: null });
          }, timeoutMs);
          this.escalationWaiters.set(request.requestId, {
            resolve: (d) => {
              clearTimeout(timer);
              this.escalationWaiters.delete(request.requestId);
              resolve(d);
            },
          });
        });
      },
      onModelDelta: (event) => {
        this.broadcast("model.delta", event);
      },
      onEvent: (event) => {
        this.broadcast(event.kind, { missionId: event.missionId, body: event.body });
      },
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // F-01 (audit fix): loopback trust boundary. Without Host/Origin
      // validation a malicious page can DNS-rebind to 127.0.0.1, read the
      // token embedded in the console, and drive the full API same-origin.
      const hostHeader = String(req.headers.host ?? "").toLowerCase();
      const allowedHosts = new Set(
        [`127.0.0.1:${this.actualPort}`, `localhost:${this.actualPort}`, `[::1]:${this.actualPort}`, "127.0.0.1", "localhost", "[::1]"].map((h) => h.toLowerCase()),
      );
      if (this.opts.host) allowedHosts.add(`${this.opts.host.toLowerCase()}:${this.actualPort}`);
      if (!allowedHosts.has(hostHeader)) {
        this.json(res, 403, { error: "forbidden host header" });
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin !== "null") {
        const allowedOrigins = new Set([
          `http://127.0.0.1:${this.actualPort}`,
          `http://localhost:${this.actualPort}`,
          `http://[::1]:${this.actualPort}`,
        ].map((o) => o.toLowerCase()));
        if (!allowedOrigins.has(origin.toLowerCase())) {
          this.json(res, 403, { error: "forbidden origin" });
          return;
        }
      }

      const parts = url.pathname.split("/").filter(Boolean);

      // GET / — web console (embeds bearer token; loopback only)
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "cache-control": "no-store",
          // F-02 (audit fix): no external scripts; framing denied (approval UI).
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        res.end(webConsoleHtml(this.token, this.actualPort));
        return;
      }

      if (!this.authed(req)) {
        this.json(res, 401, { error: "unauthorized" });
        return;
      }

      // GET /events — SSE stream
      if (req.method === "GET" && parts[0] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const s: Stream = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        this.streams.add(s);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => { clearInterval(ping); this.streams.delete(s); });
        return;
      }

      // =====================================================================
      // 1. PROVIDERS & MODELS API
      // =====================================================================

      if (parts[0] === "providers") {
        // GET /providers
        if (req.method === "GET" && parts.length === 1) {
          const providers = this.configStore.getProviders();
          const cfg = this.configStore.getConfig();
          this.json(res, 200, {
            providers,
            activeProviderId: cfg.activeProviderId,
            activeModelId: cfg.activeModelId,
            activeFallbackModelId: cfg.activeFallbackModelId,
          });
          return;
        }

        // POST /providers
        if (req.method === "POST" && parts.length === 1) {
          const body = (await this.readBody(req)) as Partial<ProviderConfig> & { apiKey?: string };
          if (!body.name || !body.kind || !body.baseUrl || !body.model) {
            this.json(res, 400, { error: "name, kind, baseUrl, model are required" });
            return;
          }
          const apiKeyEnvVar = body.apiKeyEnvVar || `API_KEY_${body.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
          if (body.apiKey) {
            this.configStore.addCredential(apiKeyEnvVar, body.apiKey, `${body.name} Key`);
          }
          const p = this.configStore.addOrUpdateProvider({
            id: body.id,
            name: body.name,
            kind: body.kind,
            baseUrl: body.baseUrl,
            apiKeyEnvVar,
            model: body.model,
            availableModels: body.availableModels || [body.model],
            fallbackModels: body.fallbackModels || [],
            enabled: body.enabled !== false,
            isDefault: Boolean(body.isDefault),
          });
          this.broadcast("provider.updated", { providerId: p.id });
          this.json(res, 201, { provider: p });
          return;
        }

        // POST /providers/:id/test
        if (req.method === "POST" && parts.length === 3 && parts[2] === "test") {
          const p = this.configStore.getProvider(parts[1]!);
          if (!p) { this.json(res, 404, { error: "provider not found" }); return; }
          const body = (await this.readBody(req)) as { apiKey?: string };
          const result = await testProviderConnection(p, body.apiKey);
          this.configStore.updateProviderStatus(p.id, result.ok ? "healthy" : "error", result.latencyMs, result.error);
          if (result.modelsFound && result.modelsFound.length > 0) {
            p.availableModels = Array.from(new Set([...p.availableModels, ...result.modelsFound]));
            this.configStore.addOrUpdateProvider(p);
          }
          this.broadcast("provider.tested", { providerId: p.id, result });
          this.json(res, 200, result);
          return;
        }

        // POST /providers/:id/set-default
        if (req.method === "POST" && parts.length === 3 && parts[2] === "set-default") {
          const ok = this.configStore.setDefaultProvider(parts[1]!);
          if (!ok) { this.json(res, 404, { error: "provider not found" }); return; }
          this.broadcast("provider.default_changed", { providerId: parts[1]! });
          this.json(res, 200, { ok: true });
          return;
        }

        // PUT /providers/:id
        if (req.method === "PUT" && parts.length === 2) {
          const existing = this.configStore.getProvider(parts[1]!);
          if (!existing) { this.json(res, 404, { error: "provider not found" }); return; }
          const body = (await this.readBody(req)) as Partial<ProviderConfig> & { apiKey?: string };
          if (body.apiKey) {
            this.configStore.addCredential(existing.apiKeyEnvVar, body.apiKey, `${existing.name} Key`);
          }
          const updated = this.configStore.addOrUpdateProvider({
            ...existing,
            ...body,
            id: parts[1]!,
          });
          this.broadcast("provider.updated", { providerId: updated.id });
          this.json(res, 200, { provider: updated });
          return;
        }

        // DELETE /providers/:id
        if (req.method === "DELETE" && parts.length === 2) {
          const ok = this.configStore.deleteProvider(parts[1]!);
          if (!ok) { this.json(res, 404, { error: "provider not found" }); return; }
          this.broadcast("provider.deleted", { providerId: parts[1]! });
          this.json(res, 200, { ok: true });
          return;
        }

        // POST /providers/:id/refresh-models or POST /providers/:id/models
        if (req.method === "POST" && parts.length === 3 && (parts[2] === "refresh-models" || parts[2] === "models")) {
          const p = this.configStore.getProvider(parts[1]!);
          if (!p) { this.json(res, 404, { error: "provider not found" }); return; }
          const result = await testProviderConnection(p);
          if (result.modelsFound && result.modelsFound.length > 0) {
            p.availableModels = Array.from(new Set([...p.availableModels, ...result.modelsFound]));
            this.configStore.addOrUpdateProvider(p);
          }
          this.broadcast("provider.updated", { providerId: p.id });
          this.json(res, 200, { ok: true, models: p.availableModels, count: p.availableModels.length });
          return;
        }
      }

      // GET /models & POST /models/select & PUT /models/:id
      if (parts[0] === "models") {
        if (req.method === "GET" && parts.length === 1) {
          const cfg = this.configStore.getConfig();
          const registered = this.configStore.getModels();
          const models: Array<{
            id: string;
            providerId: string;
            providerName: string;
            displayName?: string;
            isDefault: boolean;
            isFallback: boolean;
            capabilities?: unknown;
            cost?: unknown;
            defaultParameters?: unknown;
          }> = [];

          for (const prov of cfg.providers) {
            for (const m of prov.availableModels) {
              const reg = registered.find((r) => r.id === m && r.providerId === prov.id);
              models.push({
                id: m,
                providerId: prov.id,
                providerName: prov.name,
                displayName: reg?.displayName || m,
                isDefault: prov.id === cfg.activeProviderId && m === cfg.activeModelId,
                isFallback: m === cfg.activeFallbackModelId,
                capabilities: reg ? { reasoning: reg.reasoning, streaming: reg.streaming, toolCall: reg.toolCall, vision: reg.vision, contextLength: reg.contextLength } : prov.capabilities,
                cost: reg?.cost,
                defaultParameters: reg?.defaultParameters,
              });
            }
          }
          this.json(res, 200, {
            models,
            activeProviderId: cfg.activeProviderId,
            activeModelId: cfg.activeModelId,
            activeFallbackModelId: cfg.activeFallbackModelId,
            routingStrategy: cfg.settings.routingStrategy,
          });
          return;
        }

        if (req.method === "POST" && parts.length === 2 && parts[1] === "select") {
          const body = (await this.readBody(req)) as { providerId?: string; modelId?: string; fallbackModelId?: string };
          if (!body.providerId || !body.modelId) {
            this.json(res, 400, { error: "providerId and modelId are required" });
            return;
          }
          const ok = this.configStore.setActiveModel(body.providerId, body.modelId, body.fallbackModelId);
          if (!ok) { this.json(res, 404, { error: "provider not found" }); return; }
          this.broadcast("model.selected", { providerId: body.providerId, modelId: body.modelId });
          this.json(res, 200, { ok: true });
          return;
        }

        if (req.method === "PUT" && parts.length === 2) {
          const body = (await this.readBody(req)) as { parameters?: Record<string, unknown>; providerId?: string };
          const ok = this.configStore.updateModelParameters(parts[1]!, body.parameters as any, body.providerId);
          this.json(res, ok ? 200 : 404, { ok });
          return;
        }
      }

      // =====================================================================
      // 2. CREDENTIALS API
      // =====================================================================

      if (parts[0] === "credentials") {
        if (req.method === "GET" && parts.length === 1) {
          this.json(res, 200, { credentials: this.configStore.getCredentials() });
          return;
        }

        if (req.method === "POST" && parts.length === 1) {
          const body = (await this.readBody(req)) as { envVar?: string; value?: string; rawValue?: string; name?: string; providerId?: string };
          const secretVal = body.value || body.rawValue;
          if (!body.envVar || !secretVal) {
            this.json(res, 400, { error: "envVar and value are required" });
            return;
          }
          const cred = this.configStore.addCredential(body.envVar, secretVal, body.name, body.providerId);
          this.broadcast("credential.updated", { id: cred.id, envVar: cred.envVar });
          this.json(res, 201, { credential: cred });
          return;
        }

        if (req.method === "POST" && parts.length === 3 && parts[2] === "rotate") {
          const body = (await this.readBody(req)) as { value?: string; rawValue?: string };
          const secretVal = body.value || body.rawValue;
          if (!secretVal) { this.json(res, 400, { error: "value or rawValue required" }); return; }
          const rotated = this.configStore.rotateCredential(parts[1]!, secretVal);
          if (!rotated) { this.json(res, 404, { error: "credential not found" }); return; }
          this.broadcast("credential.updated", { id: rotated.id });
          this.json(res, 200, { credential: rotated });
          return;
        }

        if (req.method === "POST" && parts.length === 3 && parts[2] === "test") {
          const cred = this.configStore.getCredential(parts[1]!);
          if (!cred) { this.json(res, 404, { error: "credential not found" }); return; }
          const val = process.env[cred.envVar];
          const ok = Boolean(val && val.length > 0);
          this.json(res, 200, { ok, envVar: cred.envVar, maskedValue: cred.maskedValue });
          return;
        }

        if (req.method === "DELETE" && parts.length === 2) {
          const ok = this.configStore.deleteCredential(parts[1]!);
          if (!ok) { this.json(res, 404, { error: "credential not found" }); return; }
          this.broadcast("credential.deleted", { id: parts[1]! });
          this.json(res, 200, { ok: true });
          return;
        }
      }

      // =====================================================================
      // 3. WORKSPACES API
      // =====================================================================

      if (parts[0] === "workspaces") {
        if (req.method === "GET" && parts.length === 1) {
          const workspaces = this.configStore.getWorkspaces();
          const current = this.configStore.getCurrentWorkspace();
          this.json(res, 200, { workspaces, currentWorkspaceId: current.id });
          return;
        }

        if (req.method === "GET" && parts.length === 2 && parts[1] === "current") {
          const current = this.configStore.getCurrentWorkspace();
          const git = await getGitStatus(current.path);
          this.json(res, 200, { workspace: current, git });
          return;
        }

        if (req.method === "GET" && parts.length === 3 && parts[1] === "current" && parts[2] === "git") {
          const current = this.configStore.getCurrentWorkspace();
          const status = await getGitStatus(current.path);
          const diff = await getGitDiff(current.path);
          this.json(res, 200, { status, diff });
          return;
        }

        if (req.method === "POST" && parts.length === 1) {
          const body = (await this.readBody(req)) as { name?: string; path?: string };
          if (!body.name || !body.path) {
            this.json(res, 400, { error: "name and path are required" });
            return;
          }
          const ws = this.configStore.addWorkspace(body.name, body.path);
          this.broadcast("workspace.added", { workspaceId: ws.id });
          this.json(res, 201, { workspace: ws });
          return;
        }

        if (req.method === "POST" && parts.length === 2 && parts[1] === "switch") {
          const body = (await this.readBody(req)) as { workspaceId?: string };
          if (!body.workspaceId) { this.json(res, 400, { error: "workspaceId is required" }); return; }
          const ws = this.configStore.switchWorkspace(body.workspaceId);
          if (!ws) { this.json(res, 404, { error: "workspace not found" }); return; }
          this.broadcast("workspace.switched", { workspaceId: ws.id });
          this.json(res, 200, { workspace: ws });
          return;
        }

        if (req.method === "DELETE" && parts.length === 2) {
          const ok = this.configStore.deleteWorkspace(parts[1]!);
          if (!ok) { this.json(res, 400, { error: "cannot delete active or only workspace" }); return; }
          this.broadcast("workspace.deleted", { workspaceId: parts[1]! });
          this.json(res, 200, { ok: true, deleted: parts[1]! });
          return;
        }

        if (req.method === "PUT" && parts.length === 2) {
          const body = (await this.readBody(req)) as Partial<WorkspaceConfig>;
          const updated = this.configStore.updateWorkspace(parts[1]!, body);
          if (!updated) { this.json(res, 404, { error: "workspace not found" }); return; }
          this.broadcast("workspace.updated", { workspaceId: updated.id });
          this.json(res, 200, { workspace: updated });
          return;
        }
      }

      // =====================================================================
      // 4. GIT INTEGRATION API
      // =====================================================================

      if (parts[0] === "git") {
        const wsRoot = this.getActiveWorkspaceRoot();
        if (req.method === "GET" && parts.length === 2 && parts[1] === "status") {
          const status = await getGitStatus(wsRoot);
          this.json(res, 200, status);
          return;
        }
        if (req.method === "GET" && parts.length === 2 && parts[1] === "diff") {
          const diff = await getGitDiff(wsRoot);
          this.json(res, 200, diff);
          return;
        }
        if (req.method === "POST" && parts.length === 2 && parts[1] === "commit") {
          const body = (await this.readBody(req)) as { message?: string };
          if (!body.message) { this.json(res, 400, { error: "message is required" }); return; }
          const result = await createGitCommit(wsRoot, body.message);
          this.json(res, result.ok ? 200 : 400, result);
          return;
        }
      }

      // =====================================================================
      // 5. MISSIONS API (Configurable)
      // =====================================================================

      // POST /missions
      if (req.method === "POST" && parts[0] === "missions" && parts.length === 1) {
        const body = (await this.readBody(req)) as {
          intent?: unknown;
          workspaceRoot?: string;
          providerId?: string;
          modelId?: string;
          fallbackModelId?: string;
          authorityLevel?: "read-only" | "safe-dev" | "full-dev" | "custom";
          customGrants?: any[];
          verificationLevel?: "basic" | "standard" | "strict" | "custom";
          customCriteria?: any[];
          limits?: { steps?: number; tokens?: number; wallClockMs?: number };
        };

        if (typeof body.intent !== "string" || body.intent.length === 0 || body.intent.length > 8000) {
          this.json(res, 400, { error: "intent (string ≤ 8000 chars) required" });
          return;
        }

        const modelFn = this.resolveModelForMission(body.providerId, body.modelId, body.fallbackModelId);
        const wsRoot = body.workspaceRoot || this.getActiveWorkspaceRoot();
        const eng = this.engine(wsRoot, modelFn);

        const missionConfig: MissionConfigOptions = {
          intent: body.intent,
          authorityLevel: body.authorityLevel || "safe-dev",
          customGrants: body.customGrants,
          verificationLevel: body.verificationLevel || "standard",
          customCriteria: body.customCriteria,
          limits: body.limits,
        };

        const h = await eng.openConfiguredMission(missionConfig);
        this.broadcast("mission.opened", { missionId: h.missionId, model: body.modelId, workspace: wsRoot });

        const ac = new AbortController();
        this.activeTasks.set(h.missionId, { missionId: h.missionId, abortController: ac, startedAt: new Date().toISOString() });

        void eng.executeMission(h, ac.signal)
          .then((r) => {
            this.broadcast("mission.closed", { missionId: h.missionId, closure: r.closure });
            h.store.close();
          })
          .catch((e) => {
            this.broadcast("mission.error", { missionId: h.missionId, error: String(e).slice(0, 300) });
            try { h.store.close(); } catch { /* closed */ }
          })
          .finally(() => {
            this.activeTasks.delete(h.missionId);
          });

        this.json(res, 201, { missionId: h.missionId });
        return;
      }

      // GET /missions
      if (req.method === "GET" && parts[0] === "missions" && parts.length === 1) {
        const dir = join(this.opts.dataDir, "missions");
        const ids = existsSync(dir) ? readdirSync(dir) : [];
        const missions = ids.filter((id) => missionExists(this.opts.dataDir, id)).map((id) => {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const status = s.status();
          const records = s.read();
          const firstRec = records[0];
          const lastRec = records[records.length - 1];
          return {
            missionId: id,
            status: status?.status ?? "open",
            closure: status?.closure ?? null,
            goal: status?.goal_summary ?? "",
            recordCount: records.length,
            createdAt: firstRec?.ts || new Date().toISOString(),
            updatedAt: lastRec?.ts || new Date().toISOString(),
          };
        });
        missions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        this.json(res, 200, { missions });
        return;
      }

      const id = parts[1];
      if (parts[0] === "missions" && typeof id === "string" && missionExists(this.opts.dataDir, id)) {
        if (req.method === "GET" && parts.length === 2) {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const status = s.status();
          const records = s.read();
          const isRunning = this.activeTasks.has(id);
          this.json(res, 200, {
            missionId: id, status: status?.status ?? "open", goal: status?.goal_summary ?? "",
            recordCount: records.length, lastSeq: records.length, isRunning,
          });
          return;
        }

        // POST /missions/:id/abort — terminate actively running background turn
        if (req.method === "POST" && parts.length === 3 && parts[2] === "abort") {
          const task = this.activeTasks.get(id);
          if (task) {
            task.abortController.abort();
            this.activeTasks.delete(id);
            this.broadcast("mission.aborted", { missionId: id });
            this.json(res, 200, { ok: true, aborted: true });
          } else {
            this.json(res, 200, { ok: true, aborted: false, message: "not actively running" });
          }
          return;
        }

        // DELETE /missions/:id — cleanly delete mission session & dialogue
        if (req.method === "DELETE" && parts.length === 2) {
          const mDir = join(this.opts.dataDir, "missions", id);
          try {
            rmSync(mDir, { recursive: true, force: true });
            this.broadcast("mission.deleted", { missionId: id });
            this.json(res, 200, { ok: true, deleted: id });
          } catch (err) {
            this.json(res, 500, { error: "failed to delete mission: " + String(err) });
          }
          return;
        }

        if (req.method === "GET" && parts[2] === "records") {
          const since = parseInt(url.searchParams.get("since") ?? "0", 10);
          const s = openMissionReadOnly(this.opts.dataDir, id);
          this.json(res, 200, { records: s.read().filter((r) => r.seq > since) });
          return;
        }

        if (req.method === "GET" && parts[2] === "receipt") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const closed = s.read().find((r) => r.kind === "mission.closed");
          this.json(res, closed ? 200 : 404, closed ? (closed.body as unknown) : { error: "mission not closed" });
          return;
        }

        // POST /missions/:id/receipt/verify — cryptographic integrity verification
        if (req.method === "POST" && parts[2] === "receipt" && parts[3] === "verify") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const records = s.read();
          const chainCheck = verifyChain(records);
          const closed = records.find((r) => r.kind === "mission.closed");
          const receipt = closed ? (closed.body as unknown as Record<string, unknown>) : null;
          const lastHash = records.length > 0 ? records[records.length - 1]!.hash : null;
          this.json(res, 200, {
            verified: chainCheck.ok,
            chainTip: lastHash,
            error: !chainCheck.ok ? `${chainCheck.reason}: ${chainCheck.detail}` : undefined,
            recordsVerified: records.length,
            receiptClosure: receipt ? receipt["closure"] : null,
          });
          return;
        }

        // GET /missions/:id/evidence — structured evidence graph
        if (req.method === "GET" && parts[2] === "evidence") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const records = s.read();
          const observations = records.filter((r) => r.kind.startsWith("observation."));
          const claims = records.filter((r) => r.kind === "claim.asserted");
          const rejectedClaims = records.filter((r) => r.kind === "claim.rejected");
          const criteria = records.filter((r) => r.kind === "criterion.defined");
          const verdicts = records.filter((r) => r.kind === "verdict.recorded");
          this.json(res, 200, {
            observations,
            claims,
            rejectedClaims,
            criteria,
            verdicts,
          });
          return;
        }

        if (req.method === "GET" && parts[2] === "log") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const lines = s.read().map((r) => {
            const b = r.body as unknown as Record<string, unknown>;
            switch (r.kind) {
              case "observation.shell": return `ran ${(b["argv"] as string[]).join(" ")} → exit ${b["exit"]}`;
              case "observation.fs": return `fs ${b["op"]} ${b["path"]}`;
              case "observation.git": return `git ${b["op"]} → exit ${b["exit"]}`;
              case "observation.verify": return `verify ${(b["command"] as string[] | null)?.join(" ") ?? "(structural)"} → ${b["matched"] ? "matched" : "not matched"}`;
              case "verdict.recorded": return `criterion ${b["criterionId"]} → ${b["result"]} (${b["tier"]})`;
              case "claim.asserted": return `claim: ${b["statement"]}`;
              case "claim.rejected": return `claim REJECTED (${b["reason"]})`;
              case "grant.issued": return `grant issued: ${(b["grant"] as { capability: string }).capability}`;
              case "grant.requested": return `escalation: ${b["capability"]}`;
              case "mission.closed": return `closed: ${b["closure"]}`;
              default: return r.kind;
            }
          });
          this.json(res, 200, { lines });
          return;
        }

        if (req.method === "GET" && parts[2] === "escalations") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const decided = new Set(s.read().filter((r) => r.kind === "grant.decided").map((r) => (r.body as { requestId: string }).requestId));
          const pending = s.read().filter((r) => r.kind === "grant.requested" && !decided.has(r.id))
            .map((r) => ({ requestId: r.id, ...(r.body as unknown as Record<string, unknown>) }));
          this.json(res, 200, { pending });
          return;
        }

        if (req.method === "POST" && parts[2] === "escalations" && parts.length === 4) {
          const body = (await this.readBody(req)) as { decision?: "extend" | "deny"; expiresAt?: string | null };
          if (body.decision !== "extend" && body.decision !== "deny") {
            this.json(res, 400, { error: "decision must be extend|deny" });
            return;
          }
          const waiter = this.escalationWaiters.get(parts[3]!);
          if (!waiter) {
            this.json(res, 409, { error: "no escalation waiting under this id" });
            return;
          }
          waiter.resolve({ decision: body.decision, expiresAt: body.expiresAt ?? null });
          this.broadcast("escalation.decided", { missionId: id, requestId: parts[3]!, decision: body.decision });
          this.json(res, 200, { ok: true });
          return;
        }

        if (req.method === "GET" && parts[2] === "artifacts" && parts.length === 3) {
          const artDir = join(this.opts.dataDir, "missions", id, "artifacts");
          const artifacts = existsSync(artDir) ? readdirSync(artDir) : [];
          this.json(res, 200, { artifacts });
          return;
        }

        if (req.method === "GET" && parts[2] === "artifacts" && parts.length === 4) {
          const artFile = join(this.opts.dataDir, "missions", id, "artifacts", parts[3]!);
          if (existsSync(artFile)) {
            const content = readFileSync(artFile, "utf8");
            this.json(res, 200, { hash: parts[3], content });
          } else {
            this.json(res, 404, { error: "artifact not found" });
          }
          return;
        }

        // POST /missions/:id/directive or /missions/:id/prompt — follow-up interactive turns
        if (req.method === "POST" && (parts[2] === "directive" || parts[2] === "prompt")) {
          const body = (await this.readBody(req)) as { content?: string; prompt?: string; delivery?: "steer" | "queue" | "revise" };
          const content = body.content || body.prompt;
          if (!content || typeof content !== "string") {
            this.json(res, 400, { error: "prompt or content string required" });
            return;
          }
          const modelFn = this.resolveModelForMission();
          const wsRoot = this.getActiveWorkspaceRoot();
          const eng = this.engine(wsRoot, modelFn);
          const h = eng.openHandle(id);

          const directiveRec = h.store.append({
            kind: "mission.directive",
            author: "user",
            ts: new Date().toISOString(),
            body: { delivery: body.delivery || "steer", content: content.slice(0, 8192) },
          });
          this.broadcast("mission.directive", { missionId: id, directiveId: directiveRec.id, content });

          const ac = new AbortController();
          this.activeTasks.set(id, { missionId: id, abortController: ac, startedAt: new Date().toISOString() });

          void eng.executeMissionTurn(h, content, ac.signal)
            .then((r) => {
              this.broadcast("mission.turn.completed", { missionId: id, outcome: r });
              h.store.close();
            })
            .catch((e) => {
              this.broadcast("mission.error", { missionId: id, error: String(e).slice(0, 300) });
              try { h.store.close(); } catch { /* ignore */ }
            })
            .finally(() => {
              this.activeTasks.delete(id);
            });

          this.json(res, 200, { ok: true, directiveId: directiveRec.id });
          return;
        }

        // GET /missions/:id/dialogue — structured interactive chat feed (Cursor/Antigravity/Hermes style)
        if (req.method === "GET" && parts[2] === "dialogue") {
          const s = openMissionReadOnly(this.opts.dataDir, id);
          const records = s.read();
          const dialogue: Array<{
            id: string;
            type: "user" | "assistant" | "tool" | "escalation" | "verdict" | "closed";
            text?: string;
            tool?: string;
            args?: unknown;
            observation?: unknown;
            ts: string;
            seq: number;
          }> = [];

          for (const r of records) {
            if (r.kind === "mission.opened") {
              const b = r.body as { intent?: unknown; goalSpec?: { summary?: string } };
              const userText = typeof b.intent === "string" ? b.intent : b.goalSpec?.summary || "Initial Mission";
              dialogue.push({ id: r.id, type: "user", text: userText, ts: r.ts, seq: r.seq });
            } else if (r.kind === "mission.directive") {
              const b = r.body as { content: string };
              dialogue.push({ id: r.id, type: "user", text: b.content, ts: r.ts, seq: r.seq });
            } else if (r.kind === "mission.stage-summary") {
              const b = r.body as { summary: string };
              dialogue.push({ id: r.id, type: "assistant", text: cleanModelNarrative(b.summary), ts: r.ts, seq: r.seq });
            } else if (r.kind === "proposal.received") {
              const b = r.body as { proposal: { capability: string; args: unknown }; meta?: { rationale?: string } };
              dialogue.push({ id: r.id, type: "tool", tool: b.proposal.capability, args: b.proposal.args, text: b.meta?.rationale, ts: r.ts, seq: r.seq });
            } else if (r.kind.startsWith("observation.")) {
              const b = r.body as unknown;
              const lastTool = [...dialogue].reverse().find((d) => d.type === "tool" && !d.observation);
              if (lastTool) {
                lastTool.observation = b;
              } else {
                dialogue.push({ id: r.id, type: "tool", tool: r.kind.replace("observation.", ""), observation: b, ts: r.ts, seq: r.seq });
              }
            } else if (r.kind === "grant.requested") {
              const b = r.body as { capability: string; requested: unknown; rationale: string };
              dialogue.push({ id: r.id, type: "escalation", tool: b.capability, args: b.requested, text: b.rationale, ts: r.ts, seq: r.seq });
            } else if (r.kind === "verdict.recorded") {
              const b = r.body as { result: string; criterionId: string; tier: string };
              dialogue.push({ id: r.id, type: "verdict", text: `Criterion: ${b.criterionId} → ${b.result} (${b.tier})`, ts: r.ts, seq: r.seq });
            } else if (r.kind === "mission.closed") {
              const b = r.body as { closure: string };
              dialogue.push({ id: r.id, type: "closed", text: `Mission closed: ${b.closure.toUpperCase()}`, ts: r.ts, seq: r.seq });
            }
          }
          const dlgFile = join(this.opts.dataDir, "missions", id, "dialogue.jsonl");
          if (existsSync(dlgFile)) {
            try {
              const lines = readFileSync(dlgFile, "utf8").trim().split("\n").filter(Boolean);
              for (const l of lines) {
                try {
                  const entry = JSON.parse(l) as { id?: string; type?: "user" | "assistant"; text?: string; ts?: string };
                  if (entry.type === "assistant" && entry.text) {
                    const cleaned = cleanModelNarrative(entry.text);
                    if (cleaned) {
                      const already = dialogue.some((d) => d.type === "assistant" && (d.text === cleaned || d.text === entry.text));
                      if (!already) {
                        dialogue.push({
                          id: entry.id || `dlg_${Date.now()}`,
                          type: "assistant",
                          text: cleaned,
                          ts: entry.ts || new Date().toISOString(),
                          seq: 0,
                        });
                      }
                    }
                  }
                } catch { /* skip */ }
              }
            } catch { /* skip */ }
          }
          for (const d of dialogue) {
            if (d.type === "assistant" && d.text) {
              d.text = cleanModelNarrative(d.text);
            }
          }
          dialogue.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
          this.json(res, 200, { missionId: id, dialogue });
          return;
        }

        if (req.method === "POST" && parts[2] === "resume") {
          const eng = this.engine();
          const h = eng.openHandle(id);
          try {
            const result = await eng.resume(h);
            this.json(res, 200, result);
          } catch (e) {
            if ((e as Error).name === "MissionClosedError") {
              this.json(res, 409, { error: (e as Error).message });
            } else throw e;
          } finally {
            h.store.close();
          }
          return;
        }

        if (req.method === "POST" && parts[2] === "stop") {
          const s = openMission({ dataDir: this.opts.dataDir, missionId: id });
          const isClosed = s.read().some((r) => r.kind === "mission.closed");
          if (isClosed) {
            s.close();
            this.json(res, 409, { error: "mission is already closed" });
            return;
          }
          const prevRec = s.ledger.current();
          s.append({
            kind: "mission.closed",
            author: "runtime",
            ts: new Date().toISOString(),
            body: {
              closure: "blocked",
              receipt: {
                closure: "blocked",
                weakestTier: "none",
                criteria: [],
                authorityManifest: [],
                changeManifest: [],
                costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
                chainTip: prevRec ? prevRec.hash : genesisHash(),
              },
            },
          });
          s.close();
          this.broadcast("mission.closed", { missionId: id, closure: "blocked" });
          this.json(res, 200, { ok: true, status: "closed", closure: "blocked" });
          return;
        }
      }

      // =====================================================================
      // 6. MARKETPLACE & PLUGINS API
      // =====================================================================

      if (parts[0] === "marketplace") {
        if (req.method === "GET" && parts.length === 2 && parts[1] === "plugins") {
          this.json(res, 200, {
            plugins: this.marketplace.getAll(),
            installed: this.marketplace.getInstalled(),
          });
          return;
        }

        if (req.method === "POST" && parts.length === 4 && parts[1] === "plugins" && parts[3] === "toggle") {
          const pluginId = parts[2]!;
          const ok = this.marketplace.toggle(pluginId);
          if (!ok) {
            this.json(res, 404, { error: "plugin not found" });
            return;
          }
          const installed = this.marketplace.isInstalled(pluginId);
          this.broadcast("marketplace.plugin_toggled", { pluginId, installed });
          this.json(res, 200, { ok: true, pluginId, installed });
          return;
        }
      }

      // =====================================================================
      // 7. CONTINUOUS MEMORY & LEARNING API
      // =====================================================================

      if (parts[0] === "memory") {
        if (req.method === "GET" && parts.length === 1) {
          this.json(res, 200, { memories: this.memory.getAll() });
          return;
        }

        if (req.method === "POST" && parts.length === 1) {
          const body = (await this.readBody(req)) as {
            category?: "preference" | "lesson" | "architecture" | "rule";
            title?: string;
            content?: string;
          };
          if (!body.title || !body.content) {
            this.json(res, 400, { error: "title and content are required" });
            return;
          }
          const mem = this.memory.add({
            category: body.category || "preference",
            title: body.title,
            content: body.content,
            source: "user",
          });
          this.broadcast("memory.added", { memory: mem });
          this.json(res, 201, { memory: mem });
          return;
        }

        if (req.method === "DELETE" && parts.length === 2) {
          const ok = this.memory.delete(parts[1]!);
          if (!ok) {
            this.json(res, 404, { error: "memory not found" });
            return;
          }
          this.broadcast("memory.deleted", { id: parts[1]! });
          this.json(res, 200, { ok: true, id: parts[1]! });
          return;
        }
      }

      // =====================================================================
      // 8. ARCHIFY CODEBASE INTELLIGENCE API
      // =====================================================================

      if (parts[0] === "archify") {
        if (req.method === "GET") {
          try {
            const wsRoot = this.getActiveWorkspaceRoot();
            const report = scanRepository(wsRoot);
            this.json(res, 200, { report });
          } catch (err) {
            this.json(res, 500, { error: "archify failed: " + String(err) });
          }
          return;
        }
      }

      // =====================================================================
      // 9. RECOVERY, DIRECT INSPECTION & AUDIT API
      // =====================================================================

      if (parts[0] === "recovery") {
        if (req.method === "GET" && (parts.length === 1 || (parts.length === 2 && parts[1] === "missions"))) {
          const dir = join(this.opts.dataDir, "missions");
          const ids = existsSync(dir) ? readdirSync(dir) : [];
          const missions = ids.map((mid) => classifyMissionRecovery(this.opts.dataDir, mid)).filter(Boolean);
          this.json(res, 200, { missions });
          return;
        }
        if (req.method === "GET" && parts.length === 2 && missionExists(this.opts.dataDir, parts[1]!)) {
          const info = classifyMissionRecovery(this.opts.dataDir, parts[1]!);
          this.json(res, 200, info);
          return;
        }
        if (req.method === "POST" && parts.length === 3 && parts[2] === "resume") {
          const classification = classifyMissionRecovery(this.opts.dataDir, parts[1]!);
          if (classification && !classification.resumable) {
            this.json(res, 409, { error: `mission ${parts[1]} not resumable: ${classification.reason}`, classification });
            return;
          }
          const eng = this.engine();
          const h = eng.openHandle(parts[1]!);
          try {
            const result = await eng.resume(h);
            this.broadcast("mission.resumed", { missionId: parts[1]!, outcome: result });
            this.json(res, 200, result);
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            const domain = /closed|not resumable/i.test(msg);
            this.json(res, domain ? 409 : 500, { error: msg.slice(0, 500) });
          } finally {
            h.store.close();
          }
          return;
        }
        if (req.method === "POST" && parts.length === 3 && parts[2] === "abort") {
          const s = openMission({ dataDir: this.opts.dataDir, missionId: parts[1]! });
          const isClosed = s.read().some((r) => r.kind === "mission.closed");
          if (isClosed) {
            s.close();
            this.json(res, 409, { error: "mission is already closed" });
            return;
          }
          const prevRec = s.ledger.current();
          s.append({
            kind: "mission.closed",
            author: "runtime",
            ts: new Date().toISOString(),
            body: {
              closure: "blocked",
              receipt: {
                closure: "blocked",
                weakestTier: "none",
                criteria: [],
                authorityManifest: [],
                changeManifest: [],
                costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
                chainTip: prevRec ? prevRec.hash : genesisHash(),
              },
            },
          });
          s.close();
          this.broadcast("mission.closed", { missionId: parts[1]!, closure: "blocked" });
          this.json(res, 200, { ok: true, aborted: parts[1]! });
          return;
        }
      }

      if (parts[0] === "grants" && parts.length === 2 && missionExists(this.opts.dataDir, parts[1]!)) {
        const s = openMissionReadOnly(this.opts.dataDir, parts[1]!);
        const grants = s.read().filter((r) => r.kind.startsWith("grant."));
        this.json(res, 200, { missionId: parts[1]!, grants });
        return;
      }

      if (parts[0] === "proposals" && parts.length === 2 && missionExists(this.opts.dataDir, parts[1]!)) {
        const s = openMissionReadOnly(this.opts.dataDir, parts[1]!);
        const proposals = s.read().filter((r) => r.kind.startsWith("proposal."));
        this.json(res, 200, { missionId: parts[1]!, proposals });
        return;
      }

      if (parts[0] === "observations" && parts.length === 2 && missionExists(this.opts.dataDir, parts[1]!)) {
        const s = openMissionReadOnly(this.opts.dataDir, parts[1]!);
        const observations = s.read().filter((r) => r.kind.startsWith("observation."));
        this.json(res, 200, { missionId: parts[1]!, observations });
        return;
      }

      if (parts[0] === "verification" && parts.length === 2 && missionExists(this.opts.dataDir, parts[1]!)) {
        const s = openMissionReadOnly(this.opts.dataDir, parts[1]!);
        const records = s.read();
        const criteria = records.filter((r) => r.kind === "criterion.defined");
        const verdicts = records.filter((r) => r.kind === "verdict.recorded");
        const claims = records.filter((r) => r.kind.startsWith("claim."));
        this.json(res, 200, { missionId: parts[1]!, criteria, verdicts, claims });
        return;
      }

      if (parts[0] === "receipts" && parts.length >= 2 && missionExists(this.opts.dataDir, parts[1]!)) {
        const s = openMissionReadOnly(this.opts.dataDir, parts[1]!);
        const records = s.read();
        const closed = records.find((r) => r.kind === "mission.closed");
        if (parts[2] === "verify") {
          const chainCheck = verifyChain(records);
          const lastHash = records.length > 0 ? records[records.length - 1]!.hash : null;
          this.json(res, 200, {
            verified: chainCheck.ok,
            chainTip: lastHash,
            error: !chainCheck.ok ? `${chainCheck.reason}: ${chainCheck.detail}` : undefined,
            recordsVerified: records.length,
            receiptClosure: closed ? (closed.body as any)["closure"] : null,
          });
          return;
        }
        this.json(res, closed ? 200 : 404, closed ? closed.body : { error: "mission not closed" });
        return;
      }

      // =====================================================================
      // 10. HEALTH, CAPABILITIES, SETTINGS & USAGE API
      // =====================================================================

      // GET /capabilities
      if (req.method === "GET" && parts[0] === "capabilities") {
        this.json(res, 200, {
          capabilities: [
            { id: "fs", name: "File System", desc: "Read, write, patch, mkdir in workspace", risk: "write" },
            { id: "shell", name: "Process Exec", desc: "Argv-bounded execution (no shell interpolation)", risk: "execute" },
            { id: "git", name: "Git VCS", desc: "status, diff, add, commit, rev-parse", risk: "write" },
            { id: "http", name: "HTTP Client", desc: "Gated SSRF-safe HTTP fetching", risk: "read" },
            { id: "search", name: "Workspace Search", desc: "Glob and grep over workspace files", risk: "read" },
            { id: "verify", name: "Criterion Verify", desc: "Mechanical criteria execution & validation", risk: "execute" },
            { id: "artifact", name: "Artifact Store", desc: "Content-addressed blob registration", risk: "write" },
          ]
        });
        return;
      }

      // GET /health
      if (req.method === "GET" && parts[0] === "health") {
        const cfg = this.configStore.getConfig();
        const providersHealth = cfg.providers.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status || "untested",
          lastTestedAt: p.lastTestedAt,
          latencyMs: p.lastLatencyMs,
          error: p.lastError,
          configured: Boolean(process.env[p.apiKeyEnvVar] || p.maskedApiKey),
        }));
        this.json(res, 200, {
          runtime: "healthy",
          activeProvider: cfg.activeProviderId,
          activeModel: cfg.activeModelId,
          providers: providersHealth,
        });
        return;
      }

      // GET /settings & POST /settings
      if (parts[0] === "settings") {
        if (req.method === "GET") {
          this.json(res, 200, { settings: this.configStore.getConfig().settings });
          return;
        }
        if (req.method === "POST") {
          const body = (await this.readBody(req)) as Partial<Record<string, unknown>>;
          const updated = this.configStore.updateSettings(body as never);
          this.json(res, 200, { settings: updated });
          return;
        }
      }

      // GET /usage
      if (req.method === "GET" && parts[0] === "usage") {
        const dir = join(this.opts.dataDir, "missions");
        const ids = existsSync(dir) ? readdirSync(dir) : [];
        let totalMissions = 0;
        let closedVerified = 0;
        let totalRecords = 0;
        for (const mid of ids) {
          if (!missionExists(this.opts.dataDir, mid)) continue;
          totalMissions++;
          const s = openMissionReadOnly(this.opts.dataDir, mid);
          const st = s.status();
          if (st?.closure === "verified") closedVerified++;
          totalRecords += s.read().length;
        }
        this.json(res, 200, {
          totalMissions,
          closedVerified,
          totalRecords,
          costEstimate: "COST UNKNOWN (local tracking)",
        });
        return;
      }

      this.json(res, 404, { error: "not found" });
    } catch (e) {
      this.json(res, 500, { error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }
}
