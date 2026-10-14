import type { ProviderConfig } from "../config/store.js";

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  modelsFound?: string[];
  error?: string;
}

export async function testProviderConnection(
  provider: ProviderConfig,
  apiKeyOverride?: string
): Promise<ProviderTestResult> {
  const start = Date.now();
  const apiKey = apiKeyOverride || process.env[provider.apiKeyEnvVar] || "";

  if (!apiKey && provider.kind !== "openai-compatible") {
    return {
      ok: false,
      latencyMs: 0,
      error: `Missing API key in environment or configuration (${provider.apiKeyEnvVar})`,
    };
  }

  // Handle Anthropic Messages protocol
  if (provider.kind === "anthropic-messages") {
    try {
      const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/v1/messages`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: provider.model || "claude-3-5-haiku-20241022",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      const latencyMs = Date.now() - start;
      if (res.ok) {
        return { ok: true, latencyMs, statusCode: res.status };
      }
      // If 400 with invalid model or prompt, but authenticated, it proves credentials work
      if (res.status === 400) {
        return { ok: true, latencyMs, statusCode: res.status };
      }
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        latencyMs,
        statusCode: res.status,
        error: `HTTP ${res.status}: ${errText.slice(0, 160)}`,
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: String((e as Error).message || e),
      };
    }
  }

  // OpenAI-compatible / NVIDIA NIM protocol
  try {
    const base = provider.baseUrl.replace(/\/+$/, "");
    const modelsEndpoint = `${base}/models`;
    const res = await fetch(modelsEndpoint, {
      method: "GET",
      headers: {
        authorization: apiKey ? `Bearer ${apiKey}` : "",
      },
    });

    const latencyMs = Date.now() - start;
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const modelsFound = Array.isArray(data.data) ? data.data.map((m) => m.id) : [];
      return {
        ok: true,
        latencyMs,
        statusCode: res.status,
        modelsFound: modelsFound.length > 0 ? modelsFound : undefined,
      };
    }

    // Some OpenAI-compatible gateways don't implement GET /models, test a tiny completion
    const chatEndpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
    const chatRes = await fetch(chatEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: apiKey ? `Bearer ${apiKey}` : "",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });

    const chatLatency = Date.now() - start;
    if (chatRes.ok || chatRes.status === 400) {
      return { ok: true, latencyMs: chatLatency, statusCode: chatRes.status };
    }

    const err = await chatRes.text().catch(() => "");
    return {
      ok: false,
      latencyMs: chatLatency,
      statusCode: chatRes.status,
      error: `HTTP ${chatRes.status}: ${err.slice(0, 160)}`,
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: String((e as Error).message || e),
    };
  }
}
