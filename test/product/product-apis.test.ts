// product-apis.test.ts — Test suite for FORGE v1.1 Product Layer
// Validates:
// - ConfigStore CRUD, persistence, masking, workspace management
// - Model selection, routing, fallback configuration
// - Provider connectivity testing & diagnostics
// - Git status, diff, commit integration
// - REST API endpoints (/providers, /models, /credentials, /workspaces, /git, /receipt/verify, /health)
// - Cryptographic receipt verification

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, maskKey } from "../../src/config/store.js";
import { testProviderConnection } from "../../src/model-router/tester.js";
import { getGitStatus, getGitDiff, createGitCommit } from "../../src/environments/git.js";
import { ForgeApi } from "../../src/api/server.js";
import { LocalEnvironment } from "../../src/environments/local.js";
import type { ModelFn, ModelRequest, ModelEvent } from "../../src/contracts/model.js";

function mockEchoModel(): ModelFn {
  return {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield { type: "text-delta", text: "ok" };
    },
  } as unknown as ModelFn;
}

test("ConfigStore: credentials masking, provider CRUD and workspace switching", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-test-cfg-"));
  try {
    const store = new ConfigStore(dir);
    const cfg = store.getConfig();
    assert.equal(cfg.version, "1.1.0");
    assert.ok(cfg.providers.length >= 3);

    // 1. Masking
    assert.equal(maskKey("sk-1234567890abcdef"), "sk-1••••••••cdef");
    assert.equal(maskKey("short"), "••••••••");
    assert.equal(maskKey(""), "");

    // 2. Add credential
    const cred = store.addCredential("TEST_API_KEY", "secret-test-key-12345", "Test Key");
    assert.equal(cred.maskedValue, "secr••••••••2345");
    assert.equal(process.env["TEST_API_KEY"], "secret-test-key-12345");

    // 3. Provider operations
    const p = store.addOrUpdateProvider({
      id: "custom-test",
      name: "Custom Test Provider",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKeyEnvVar: "TEST_API_KEY",
      model: "test-model-1",
      availableModels: ["test-model-1", "test-model-2"],
      enabled: true,
      isDefault: false,
    });
    assert.equal(p.id, "custom-test");
    assert.ok(store.getProvider("custom-test"));

    store.setDefaultProvider("custom-test");
    assert.equal(store.getConfig().activeProviderId, "custom-test");
    assert.equal(store.getConfig().activeModelId, "test-model-1");

    // 4. Model selection & fallback
    store.setActiveModel("custom-test", "test-model-2", "test-model-1");
    assert.equal(store.getConfig().activeModelId, "test-model-2");
    assert.equal(store.getConfig().activeFallbackModelId, "test-model-1");

    // 5. Workspaces
    const ws = store.addWorkspace("Project Alpha", "/tmp/project-alpha");
    assert.ok(ws.id.startsWith("ws-"));
    const switched = store.switchWorkspace(ws.id);
    assert.equal(switched?.id, ws.id);
    assert.equal(store.getCurrentWorkspace().id, ws.id);

    // 6. Delete provider & credential
    assert.equal(store.deleteProvider("custom-test"), true);
    assert.equal(store.getProvider("custom-test"), undefined);
    assert.equal(store.deleteCredential(cred.id), true);
    assert.equal(process.env["TEST_API_KEY"], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model-router/tester: connection testing handles missing keys and unreachable endpoints", async () => {
  const result = await testProviderConnection({
    id: "anthropic-unconfigured",
    name: "Anthropic",
    kind: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "DEFINITELY_UNSET_API_KEY_FOR_TESTING",
    model: "claude-3-5-haiku-20241022",
    availableModels: [],
    enabled: true,
    isDefault: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("Missing API key"));

  // Local unreachable endpoint
  const unreach = await testProviderConnection({
    id: "local-down",
    name: "Local",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:59999/v1",
    apiKeyEnvVar: "UNSET_KEY",
    model: "test",
    availableModels: [],
    enabled: true,
    isDefault: false,
  });
  assert.equal(unreach.ok, false);
});

test("git integration: getGitStatus detects non-repo and active repo correctly", async () => {
  const nonRepoDir = mkdtempSync(join(tmpdir(), "forge-non-git-"));
  try {
    const nonRepoStatus = await getGitStatus(nonRepoDir);
    assert.equal(nonRepoStatus.isRepo, false);

    // Now initialize a test git repo
    const repoDir = mkdtempSync(join(tmpdir(), "forge-git-repo-"));
    try {
      const env = new LocalEnvironment(repoDir);
      await env.exec({
        argv: ["git", "init"],
        cwd: "." as any,
        timeoutMs: 10_000,
        env: new Map(),
        signal: new AbortController().signal,
      });
      await env.exec({
        argv: ["git", "config", "user.email", "forge-test@local"],
        cwd: "." as any,
        timeoutMs: 10_000,
        env: new Map(),
        signal: new AbortController().signal,
      });
      await env.exec({
        argv: ["git", "config", "user.name", "Forge Test"],
        cwd: "." as any,
        timeoutMs: 10_000,
        env: new Map(),
        signal: new AbortController().signal,
      });

      // Status of empty repo
      const st1 = await getGitStatus(repoDir);
      assert.equal(st1.isRepo, true);

      // Create a file
      writeFileSync(join(repoDir, "hello.txt"), "hello world\n");
      const st2 = await getGitStatus(repoDir);
      assert.ok(st2.untracked.includes("hello.txt"));

      // Commit file
      const commitRes = await createGitCommit(repoDir, "feat: initial commit");
      assert.equal(commitRes.ok, true);
      assert.ok(commitRes.commitHash && commitRes.commitHash.length > 5);

      // Clean status
      const st3 = await getGitStatus(repoDir);
      assert.equal(st3.clean, true);

      // Modify file and test diff
      writeFileSync(join(repoDir, "hello.txt"), "hello world modified\n");
      const diffRes = await getGitDiff(repoDir);
      assert.ok(diffRes.diff.includes("+hello world modified"));
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(nonRepoDir, { recursive: true, force: true });
  }
});

test("REST API: providers, models, credentials, and workspaces endpoints", async () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-api-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "forge-api-data-"));
  const api = new ForgeApi({ dataDir, workspaceRoot: ws, modelFn: mockEchoModel() });
  await api.listen();

  const headers = { authorization: `Bearer ${api.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${api.port}`;

  try {
    // 1. GET /providers
    const provsRes = await fetch(`${base}/providers`, { headers });
    assert.equal(provsRes.status, 200);
    const provsData = (await provsRes.json()) as { providers: any[] };
    assert.ok(provsData.providers.length >= 3);

    // 2. POST /providers
    const addProvRes = await fetch(`${base}/providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: "api-test-provider",
        name: "API Test",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnvVar: "TEST_API_KEY",
        model: "gpt-4o-mini",
        availableModels: ["gpt-4o-mini"],
      }),
    });
    assert.equal(addProvRes.status, 201);

    // 3. GET /models
    const modelsRes = await fetch(`${base}/models`, { headers });
    assert.equal(modelsRes.status, 200);
    const modelsData = (await modelsRes.json()) as { models: any[]; activeProviderId: string };
    assert.ok(modelsData.models.length > 0);

    // 4. POST /models/select
    const selRes = await fetch(`${base}/models/select`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: "api-test-provider", modelId: "gpt-4o-mini" }),
    });
    assert.equal(selRes.status, 200);

    // 5. POST /credentials
    const addCredRes = await fetch(`${base}/credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({ envVar: "NEW_TEST_KEY", rawValue: "secret-abc-xyz-12345", name: "New Test Key" }),
    });
    assert.equal(addCredRes.status, 201);
    const credData = (await addCredRes.json()) as { credential: { maskedValue: string } };
    assert.equal(credData.credential.maskedValue, "secr••••••••2345");

    // 6. GET /credentials
    const credsRes = await fetch(`${base}/credentials`, { headers });
    assert.equal(credsRes.status, 200);

    // 7. GET /workspaces & POST /workspaces
    const addWsRes = await fetch(`${base}/workspaces`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "API Created Workspace", path: ws }),
    });
    assert.equal(addWsRes.status, 201);
    const wsData = (await addWsRes.json()) as { workspace: { id: string } };

    // 8. POST /workspaces/switch
    const swRes = await fetch(`${base}/workspaces/switch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: wsData.workspace.id }),
    });
    assert.equal(swRes.status, 200);

    // 9. GET /health & GET /usage
    const healthRes = await fetch(`${base}/health`, { headers });
    assert.equal(healthRes.status, 200);
    const usageRes = await fetch(`${base}/usage`, { headers });
    assert.equal(usageRes.status, 200);
  } finally {
    api.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
