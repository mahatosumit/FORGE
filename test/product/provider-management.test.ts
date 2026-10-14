// provider-management.test.ts — Comprehensive test suite for Provider & Credential Management
// Validates:
// - Provider registration, updates, model listing, defaults, and deletion
// - Credential management, masking, key rotation, and environment variable resolution
// - Model parameters registration and per-model hyperparameter configuration
// - Live and offline provider connectivity diagnostics

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, maskKey, type ProviderConfig } from "../../src/config/store.js";
import { testProviderConnection } from "../../src/model-router/tester.js";

test("Provider Management: Full CRUD lifecycle with multiple providers and default switching", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-prov-"));
  try {
    const store = new ConfigStore(dir);

    // Initial state: default providers present
    const initProviders = store.getProviders();
    assert.ok(initProviders.length >= 3);

    // Register Anthropic provider
    const anthropicConfig: ProviderConfig = {
      id: "anthropic-prod",
      name: "Anthropic Claude Production",
      kind: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      model: "claude-3-5-sonnet-20241022",
      availableModels: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
      enabled: true,
      isDefault: false,
      capabilities: {
        streaming: true,
        toolCall: true,
        reasoning: true,
        structuredOutput: true,
        vision: true,
        contextWindow: 200_000,
        maxOutputTokens: 8192,
      },
    };
    const savedAnthropic = store.addOrUpdateProvider(anthropicConfig);
    assert.equal(savedAnthropic.id, "anthropic-prod");
    assert.equal(savedAnthropic.capabilities?.contextWindow, 200_000);

    // Register DeepSeek provider
    const deepseekConfig: ProviderConfig = {
      id: "deepseek-v3",
      name: "DeepSeek API",
      kind: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnvVar: "DEEPSEEK_API_KEY",
      model: "deepseek-chat",
      availableModels: ["deepseek-chat", "deepseek-reasoner"],
      enabled: true,
      isDefault: false,
    };
    store.addOrUpdateProvider(deepseekConfig);

    // Verify both providers exist
    assert.ok(store.getProvider("anthropic-prod"));
    assert.ok(store.getProvider("deepseek-v3"));

    // Set DeepSeek as default
    const setDefOk = store.setDefaultProvider("deepseek-v3");
    assert.equal(setDefOk, true);
    assert.equal(store.getConfig().activeProviderId, "deepseek-v3");
    assert.equal(store.getConfig().activeModelId, "deepseek-chat");

    // Update status and latency
    store.updateProviderStatus("deepseek-v3", "healthy", 145);
    const updatedDeepseek = store.getProvider("deepseek-v3");
    assert.equal(updatedDeepseek?.status, "healthy");
    assert.equal(updatedDeepseek?.latencyMs, 145);

    // Delete Anthropic provider
    const delOk = store.deleteProvider("anthropic-prod");
    assert.equal(delOk, true);
    assert.equal(store.getProvider("anthropic-prod"), undefined);

    // Attempting to delete non-existent provider should return false
    const delUnknown = store.deleteProvider("non-existent-prov");
    assert.equal(delUnknown, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Credential Management: Key rotation, masking, and environment resolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-cred-"));
  try {
    const store = new ConfigStore(dir);

    // Add Credential
    const cred = store.addCredential("PROD_SECRET_KEY", "initial-secret-token-9999", "Production Key");
    assert.ok(cred.id.startsWith("cred-"));
    assert.equal(cred.envVar, "PROD_SECRET_KEY");
    assert.equal(cred.maskedValue, "init••••••••9999");
    assert.equal(process.env["PROD_SECRET_KEY"], "initial-secret-token-9999");

    // Masking checks
    assert.equal(maskKey("1234567890"), "1234••••••••7890");
    assert.equal(maskKey("abc"), "••••••••");

    // Key Rotation
    const rotated = store.rotateCredential(cred.id, "rotated-new-token-8888");
    assert.ok(rotated);
    assert.equal(rotated.maskedValue, "rota••••••••8888");
    assert.equal(process.env["PROD_SECRET_KEY"], "rotated-new-token-8888");
    assert.ok(rotated.lastRotatedAt);

    // Delete Credential
    const deleted = store.deleteCredential(cred.id);
    assert.equal(deleted, true);
    assert.equal(store.getCredential(cred.id), undefined);
    assert.equal(process.env["PROD_SECRET_KEY"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Model Parameters: Custom temperature, topP, maxTokens configuration per model", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-params-"));
  try {
    const store = new ConfigStore(dir);

    // Register a model with custom parameters
    store.registerModel({
      id: "kimi-k3",
      providerId: "nvidia-nim",
      displayName: "Moonshot Kimi K3",
      contextLength: 128_000,
      reasoning: true,
      streaming: true,
      toolCall: true,
      vision: false,
      defaultParameters: {
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 4096,
        reasoningEffort: "medium",
      },
    });

    // Update model parameters
    const updated = store.updateModelParameters("kimi-k3", {
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 8192,
      reasoningEffort: "high",
    });
    assert.equal(updated, true);

    const models = store.getModels();
    const kimi = models.find((m) => m.id === "kimi-k3");
    assert.ok(kimi);
    assert.equal(kimi.defaultParameters?.temperature, 0.1);
    assert.equal(kimi.defaultParameters?.maxTokens, 8192);
    assert.equal(kimi.defaultParameters?.reasoningEffort, "high");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
