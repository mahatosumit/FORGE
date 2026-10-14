import { createHash } from "node:crypto";
import type { ModelEvent, ModelFn, ModelRequest, ModelError, ModelErrorCode } from "../contracts/model.js";
import { ModelEventSchema } from "../contracts/model.js";

// ---------------------------------------------------------------------------
// Provider descriptors (data)
// ---------------------------------------------------------------------------

export interface ProviderDescriptor {
  id: string;
  kind: "openai-compatible" | "anthropic-messages" | "nvidia-nim" | "custom";
  baseUrl: string;
  apiKeyEnvVar: string; // secret resolved from the process environment at call time
  model: string;
  contextWindow: number;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ModelAttemptFailure {
  code: ModelErrorCode;
  message: string;
  retryAfterMs?: number;
}

export type ModelFnResult = AsyncIterable<ModelEvent>;

export interface RouterModelFn extends ModelFn {
  /** last classified failure, for engine accounting */
  lastFailure?: ModelAttemptFailure;
}

export class ModelTransportError extends Error {
  constructor(public readonly failure: ModelAttemptFailure) {
    super(`model failure [${failure.code}]: ${failure.message}`);
    this.name = "ModelTransportError";
  }
}

// ---------------------------------------------------------------------------
// Structured record extraction: models emit JSON objects on their own lines —
// {"proposal": {...}, "rationale": "..."} | {"claim": "...", "citations": [...]}
// Everything else is narration (text-delta). Fail-closed: unparsable structured
// blocks become InvalidOutput for the engine's reprompt accounting.
// ---------------------------------------------------------------------------

function tryParsedCandidate(str: string, events: ModelEvent[], invalid: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(str);
  } catch {
    // Fail-soft repair: models commonly emit pretty-printed JSON with literal
    // control characters (raw newlines/tabs) inside string values. Escape only
    // control characters inside string literals — never altering structure or
    // inventing content — then re-parse. If still unparseable and the block
    // looks structured, record it as invalid so the engine reprompts instead
    // of silently dropping the proposal.
    try {
      parsed = JSON.parse(sanitizeControlCharsInStrings(str));
    } catch {
      // Fail-loud only for candidates carrying structured markers; a lone "{"
      // (the opening line of a pretty-printed block) is handled by the
      // balanced-block scan instead.
      if ((str.startsWith("{") || str.startsWith("[")) && /"(?:proposal|claim|capability)"\s*:/.test(str)) {
        invalid.push("malformed structured block: invalid JSON");
        return true;
      }
      return false;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as { [k: string]: unknown };

  if (obj["type"] === "content" && typeof obj["sha256"] === "string" && typeof obj["base64"] === "string") {
    const v = ModelEventSchema.safeParse(obj);
    if (v.success) {
      events.push(v.data);
      return true;
    }
  }

  const candidate = obj["proposal"] !== undefined
    ? { type: "proposal" as const, proposal: obj["proposal"] as Record<string, unknown>, meta: { rationale: String(obj["rationale"] ?? ""), citations: Array.isArray(obj["citations"]) ? (obj["citations"] as unknown[]).map(String) : [] } }
    : (typeof obj["capability"] === "string" && obj["args"] !== undefined)
      ? { type: "proposal" as const, proposal: { capability: obj["capability"], args: obj["args"] as Record<string, unknown> }, meta: { rationale: String(obj["rationale"] ?? ""), citations: Array.isArray(obj["citations"]) ? (obj["citations"] as unknown[]).map(String) : [] } }
      : obj["claim"] !== undefined
        ? { type: "claim" as const, statement: String(obj["claim"]), citations: Array.isArray(obj["citations"]) ? (obj["citations"] as unknown[]).map(String) : [] }
        : null;
  if (candidate === null) return false;

  if (candidate.type === "proposal" && typeof candidate.proposal === "object" && candidate.proposal !== null) {
    const p = candidate.proposal as { capability?: unknown; args?: Record<string, unknown>; rationale?: unknown; citations?: unknown };
    // Models sometimes nest meta fields inside the proposal object; lift them
    // into meta (both are non-authority fields — authority fields stay strict).
    if (p.rationale !== undefined) {
      if (!candidate.meta.rationale) candidate.meta.rationale = String(p.rationale);
      delete p.rationale;
    }
    if (p.citations !== undefined) {
      if (candidate.meta.citations.length === 0 && Array.isArray(p.citations)) {
        candidate.meta.citations = (p.citations as unknown[]).map(String);
      }
      delete p.citations;
    }
    if (p.capability === "fs" && typeof p.args === "object" && p.args !== null) {
      const args = p.args;
      if (args["op"] === "read") {
        p.capability = "search";
        p.args = { query: "", mode: "grep", pathPrefix: typeof args["path"] === "string" ? args["path"] : undefined };
      } else if ((args["op"] === "write" || args["op"] === "append") && typeof args["content"] === "string" && !args["contentRef"]) {
        const contentBuf = Buffer.from(args["content"], "utf8");
        const hash = createHash("sha256").update(contentBuf).digest("hex");
        events.push({
          type: "content",
          sha256: hash,
          base64: contentBuf.toString("base64"),
        });
        args["contentRef"] = hash;
        delete args["content"];
      }
    } else if (p.capability === "shell" && typeof p.args === "object" && p.args !== null) {
      const args = p.args;
      if (typeof args["argv"] === "string") {
        args["argv"] = (args["argv"] as string).split(/\s+/).filter(Boolean);
      } else if (typeof args["command"] === "string" && !args["argv"]) {
        args["argv"] = (args["command"] as string).split(/\s+/).filter(Boolean);
        delete args["command"];
      } else if (typeof args["cmd"] === "string" && !args["argv"]) {
        args["argv"] = (args["cmd"] as string).split(/\s+/).filter(Boolean);
        delete args["cmd"];
      }
    }
  }

  const v = ModelEventSchema.safeParse(candidate);
  if (v.success) events.push(v.data);
  else invalid.push(v.error.issues[0]?.message ?? "invalid structured block");
  return true;
}

function sanitizeControlCharsInStrings(str: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i]!;
    if (inString) {
      if (escaped) {
        out += c;
        escaped = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        escaped = true;
        continue;
      }
      if (c === '"') {
        out += c;
        inString = false;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "\t") {
        out += "\\t";
        continue;
      }
      if (c < " ") {
        out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
      out += c;
    } else {
      if (c === '"') inString = true;
      out += c;
    }
  }
  return out;
}

export function extractStructuredEvents(text: string): { events: ModelEvent[]; invalid: string[] } {
  const events: ModelEvent[] = [];
  const invalid: string[] = [];
  const processed = new Set<string>();

  // 1. Code blocks (```json ... ``` or ``` ...)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const raw = fenceMatch[1]?.trim();
    if (raw && (raw.startsWith("{") || raw.startsWith("["))) {
      if (tryParsedCandidate(raw, events, invalid)) {
        processed.add(raw);
      }
    }
  }

  // 2. Single-line JSON objects
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || processed.has(trimmed)) continue;
    if (tryParsedCandidate(trimmed, events, invalid)) {
      processed.add(trimmed);
    }
  }

  // 3. Balanced multi-line JSON blocks — runs unconditionally. Models
  // routinely mix narration, several proposals, and pretty-printed JSON with
  // literal newlines; skipping this scan when any single-line candidate already
  // parsed would silently drop the remaining proposals (INV: never silent).
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidateStr = text.slice(start, i + 1).trim();
        if (!processed.has(candidateStr)) {
          tryParsedCandidate(candidateStr, events, invalid);
          processed.add(candidateStr);
        }
        start = -1;
      }
    }
  }

  return { events, invalid };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
}

export function openAICompatibleAdapter(d: ProviderDescriptor, apiKey: string): RouterModelFn {
  return {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const system = req.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const msgs = req.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role === "assistant" ? "assistant" as const : "user" as const, content: m.content }));
      const payloadMessages = system.trim().length > 0
        ? [{ role: "system" as const, content: system.trim() }, ...msgs]
        : msgs;
      let res: Response;
      const endpoint = d.baseUrl.endsWith("/chat/completions")
        ? d.baseUrl
        : `${d.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            accept: "text/event-stream, application/json",
          },
          body: JSON.stringify({
            model: d.model,
            messages: payloadMessages,
            stream: true,
            max_tokens: Math.max(req.maxOutputTokens ?? 4096, 8192),
          }),
          signal: req.signal,
        });
      } catch (e) {
        throw new ModelTransportError({ code: "Transport", message: String(e) });
      }
      if (!res.ok || !res.body) {
        throw new ModelTransportError(classifyHttpError(res.status, await res.text().catch(() => "")));
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
        const msg = json.choices?.[0]?.message;
        const delta = msg?.content ?? "";
        const reasoning = msg?.reasoning_content ?? "";
        if (reasoning) yield { type: "text-delta", text: reasoning };
        if (delta) yield { type: "text-delta", text: delta };
        const { events, invalid } = extractStructuredEvents(delta);
        for (const e of events) yield e;
        if (invalid.length > 0) {
          yield { type: "error", error: { code: "InvalidOutput", message: `malformed structured output: ${invalid[0]}` } };
        }
        return;
      }

      let text = "";
      for await (const line of sseLines(res)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        try {
          const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }> };
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          const reasoning = chunk.choices?.[0]?.delta?.reasoning_content ?? "";
          if (reasoning) {
            yield { type: "text-delta", text: reasoning };
          }
          if (delta) {
            text += delta;
            yield { type: "text-delta", text: delta };
          }
        } catch {
          continue; // malformed SSE chunk — skipped, final parse decides InvalidOutput
        }
      }
      const { events, invalid } = extractStructuredEvents(text);
      for (const e of events) yield e;
      if (invalid.length > 0) {
        yield { type: "error", error: { code: "InvalidOutput", message: `malformed structured output: ${invalid[0]}` } };
      }
    },
  };
}

export function anthropicMessagesAdapter(d: ProviderDescriptor, apiKey: string): RouterModelFn {
  return {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = req.messages.filter((m) => m.role !== "system").map((m) => ({ role: "user", content: m.content }));
      let res: Response;
      try {
        res = await fetch(`${d.baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: d.model, system, messages: msgs, stream: true, max_tokens: req.maxOutputTokens }),
          signal: req.signal,
        });
      } catch (e) {
        throw new ModelTransportError({ code: "Transport", message: String(e) });
      }
      if (!res.ok || !res.body) {
        throw new ModelTransportError(classifyHttpError(res.status, await res.text().catch(() => "")));
      }
      let text = "";
      for await (const line of sseLines(res)) {
        if (!line.startsWith("data:")) continue;
        try {
          const chunk = JSON.parse(line.slice(5).trim()) as { type?: string; delta?: { text?: string } };
          const delta = chunk.type === "content_block_delta" ? chunk.delta?.text ?? "" : "";
          if (delta) {
            text += delta;
            yield { type: "text-delta", text: delta };
          }
        } catch {
          continue;
        }
      }
      const { events, invalid } = extractStructuredEvents(text);
      for (const e of events) yield e;
      if (invalid.length > 0) {
        yield { type: "error", error: { code: "InvalidOutput", message: `malformed structured output: ${invalid[0]}` } };
      }
    },
  };
}

export function classifyHttpError(status: number, body: string): ModelAttemptFailure {
  if (status === 429) {
    return { code: "RateLimited", message: body.slice(0, 200), retryAfterMs: 2000 };
  }
  if (status === 401 || status === 403) return { code: "AuthFailed", message: body.slice(0, 200) };
  if (status === 402) return { code: "QuotaExceeded", message: body.slice(0, 200) };
  if (status === 400) return { code: "InvalidOutput", message: body.slice(0, 200) };
  if (status >= 500) return { code: "Transport", message: `HTTP ${status}: ${body.slice(0, 160)}`, retryAfterMs: 1000 };
  return { code: "Unknown", message: `HTTP ${status}: ${body.slice(0, 160)}` };
}

// ---------------------------------------------------------------------------
// Router: descriptor → ModelFn with bounded retry on retryable classes.
// ---------------------------------------------------------------------------

export const RETRYABLE: ReadonlySet<ModelErrorCode> = new Set(["RateLimited", "Transport"]);
const MAX_AUTO_RETRIES = 3;

export function resolveModelFn(d: ProviderDescriptor, env: Readonly<Record<string, string | undefined>> = process.env): RouterModelFn {
  let apiKey = env[d.apiKeyEnvVar];
  if (!apiKey && (d.apiKeyEnvVar.startsWith("nvapi-") || d.apiKeyEnvVar.startsWith("sk-") || d.apiKeyEnvVar.length > 30)) {
    apiKey = d.apiKeyEnvVar;
  }
  if (!apiKey && d.id === "ollama-local") {
    apiKey = "ollama-local-key";
  }

  if (!apiKey) {
    // fail-closed credential rule: no key ⇒ inert model fn that errors cleanly
    return {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "error", error: { code: "AuthFailed", message: `missing credential ${d.apiKeyEnvVar} for provider ${d.id}` } };
      },
      lastFailure: { code: "AuthFailed", message: `missing credential ${d.apiKeyEnvVar}` },
    };
  }
  const inner =
    d.kind === "anthropic-messages"
      ? anthropicMessagesAdapter(d, apiKey)
      : openAICompatibleAdapter(d, apiKey);

  async function* withRetry(req: ModelRequest): AsyncGenerator<ModelEvent> {
    let attempt = 0;
    while (true) {
      try {
        for await (const ev of inner.complete(req)) {
          if (ev.type === "error" && ev.error.code === "Transport") {
            throw new ModelTransportError({ code: "Transport", message: ev.error.message });
          }
          yield ev;
        }
        return;
      } catch (e) {
        const failure = e instanceof ModelTransportError ? e.failure : { code: "Unknown" as ModelErrorCode, message: String(e) };
        if (RETRYABLE.has(failure.code) && attempt < MAX_AUTO_RETRIES) {
          attempt++;
          await new Promise((r) => setTimeout(r, failure.retryAfterMs ?? 1000 * attempt));
          continue;
        }
        yield { type: "error", error: { code: failure.code, message: failure.message } as ModelError };
        return;
      }
    }
  }

  return { complete: withRetry };
}

export interface RoutingPolicy {
  primary: ProviderDescriptor;
  fallback?: ProviderDescriptor;
  strategy?: "single" | "fallback" | "best-available" | "cost-optimized" | "capability-match";
  /** Credential pool: additional env-var names holding keys for the primary
   * provider. Rotated (in order) on rate-limit/auth/quota failures BEFORE any
   * provider fallback is attempted. Runtime-owned: the model never sees keys. */
  credentialPool?: string[];
  /** Cooldown after a credential fails (ms). Default 60s. */
  credentialCooldownMs?: number;
  onTransition?: (from: ProviderDescriptor, to: ProviderDescriptor, reason: string) => void;
}

export function resolveRoutingModelFn(
  policy: RoutingPolicy,
  env: Readonly<Record<string, string | undefined>> = process.env
): RouterModelFn {
  const cooldownMs = policy.credentialCooldownMs ?? 60_000;
  const cooldownUntil = new Map<string, number>();
  let lastFailureVar: ModelAttemptFailure | undefined;
  const poolKeys = [policy.primary.apiKeyEnvVar, ...(policy.credentialPool ?? []).filter((k) => k !== policy.primary.apiKeyEnvVar)];

  const isRetriable = (code: string) => code === "RateLimited" || code === "QuotaExceeded" || code === "Transport" || code === "AuthFailed";

  // Preserve pre-pool behavior exactly when there is nothing to rotate onto.
  if (policy.strategy === "single" || (poolKeys.length === 1 && !policy.fallback)) {
    return resolveModelFn(policy.primary, env);
  }

  return {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      // attempt order: pool credentials (skipping cooling ones), then fallback
      const attempts: Array<{ desc: ProviderDescriptor; label: string }> = [];
      const now = Date.now();
      for (const key of poolKeys) {
        const until = cooldownUntil.get(key) ?? 0;
        if (until > now) continue;
        attempts.push({ desc: { ...policy.primary, apiKeyEnvVar: key }, label: `${policy.primary.id}#${key}` });
      }
      if (policy.fallback && policy.strategy !== "single") {
        attempts.push({ desc: policy.fallback, label: policy.fallback.id });
      }

      let lastMsg = "no attempts available";
      for (let i = 0; i < attempts.length; i++) {
        const cand = attempts[i]!;
        const fn = resolveModelFn(cand.desc, env);
        let failed = false;
        try {
          for await (const ev of fn.complete(req)) {
            if (ev.type === "error" && isRetriable(ev.error.code)) {
              failed = true;
              lastMsg = ev.error.message;
              lastFailureVar = { code: ev.error.code, message: ev.error.message };
              if (i < poolKeys.length) cooldownUntil.set(cand.desc.apiKeyEnvVar, Date.now() + cooldownMs);
              break;
            }
            yield ev;
          }
          if (!failed) return;
        } catch (err) {
          failed = true;
          lastMsg = String(err);
          if (i < poolKeys.length) cooldownUntil.set(cand.desc.apiKeyEnvVar, Date.now() + cooldownMs);
        }
        if (failed && i < attempts.length - 1) {
          const next = attempts[i + 1]!;
          policy.onTransition?.(cand.desc, next.desc, lastMsg);
          const sameProvider = next.desc.id === cand.desc.id;
          yield {
            type: "text-delta",
            text: sameProvider
              ? `[FORGE Router: credential rotation on ${cand.desc.id} (${cand.desc.apiKeyEnvVar} → ${next.desc.apiKeyEnvVar}): ${lastMsg.slice(0, 200)}]\n\n`
              : `[FORGE Router: failover from ${cand.desc.id} (${cand.desc.model}) to fallback ${next.desc.id} (${next.desc.model})]\n\n`,
          };
        }
      }
      yield { type: "error", error: { code: "Transport", message: `all credential/provider attempts failed: ${lastMsg}` } };
    },
    get lastFailure() {
      return lastFailureVar;
    },
  };
}
