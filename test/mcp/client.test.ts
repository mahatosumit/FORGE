import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProposalSchema } from "../../src/contracts/proposals.js";
import { evaluateProposal } from "../../src/gate/gate.js";
import { openMission } from "../../src/ledger/index.js";
import { GrantStore, newMissionId } from "../../src/grants/grants.js";
import { McpClient } from "../../src/mcp/client.js";
import { McpRegistry } from "../../src/mcp/registry.js";
import { mcpCallImpl, setMcpRegistry } from "../../src/capabilities/mcp.js";
import { McpError } from "../../src/mcp/types.js";
import type { DispatchContext } from "../../src/capability-host/types.js";
import { LocalEnvironment, sha256Hex } from "../../src/environments/local.js";

const mockServerScript = fileURLToPath(new URL("../helpers/mock-mcp-server.mjs", import.meta.url));

test("MCP Proposals: schema validates mcp_call proposals strictly", () => {
  const validProposal = {
    capability: "mcp_call",
    args: {
      serverId: "mock-srv",
      toolName: "echo",
      arguments: { message: "hello world" },
    },
  };
  const parsed = ProposalSchema.safeParse(validProposal);
  assert.equal(parsed.success, true);

  // Missing toolName rejected
  const missingTool = {
    capability: "mcp_call",
    args: {
      serverId: "mock-srv",
      arguments: {},
    },
  };
  assert.equal(ProposalSchema.safeParse(missingTool).success, false);

  // Non-object arguments rejected
  const invalidArgs = {
    capability: "mcp_call",
    args: {
      serverId: "mock-srv",
      toolName: "echo",
      arguments: "raw string not allowed",
    },
  };
  assert.equal(ProposalSchema.safeParse(invalidArgs).success, false);

  // Invalid capability name rejected
  const invalidCap = {
    capability: "mcp_execute_arbitrary",
    args: { serverId: "mock-srv", toolName: "echo" },
  };
  assert.equal(ProposalSchema.safeParse(invalidCap).success, false);
});

test("Authority Gate: governs mcp_call with granular mcpTools constraint patterns", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-gate-mcp-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const grants = new GrantStore(store);

  const echoProposal = {
    capability: "mcp_call",
    args: { serverId: "srv1", toolName: "echo", arguments: {} },
  };
  const addProposal = {
    capability: "mcp_call",
    args: { serverId: "srv1", toolName: "add", arguments: {} },
  };
  const otherServerProposal = {
    capability: "mcp_call",
    args: { serverId: "srv2", toolName: "echo", arguments: {} },
  };

  // 1. Without grants: escalates with requested tool constraint
  const v1 = evaluateProposal(echoProposal, { rationale: "run echo", citations: [] }, { grants: grants.active() });
  assert.equal(v1.type, "escalate");
  if (v1.type === "escalate") {
    assert.deepEqual(v1.request.requested.mcpTools, ["srv1.echo"]);
  }

  // 2. Grant exact tool "srv1.echo": allows echo, escalates add
  grants.issue({
    missionId,
    capability: "mcp_call",
    constraints: { mcpTools: ["srv1.echo"] },
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  });

  const v2 = evaluateProposal(echoProposal, { rationale: "run echo", citations: [] }, { grants: grants.active() });
  assert.equal(v2.type, "allow");

  const v3 = evaluateProposal(addProposal, { rationale: "run add", citations: [] }, { grants: grants.active() });
  assert.equal(v3.type, "escalate");

  // 3. Grant server wildcard "srv1.*": allows all tools on srv1, escalates srv2
  grants.issue({
    missionId,
    capability: "mcp_call",
    constraints: { mcpTools: ["srv1.*"] },
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  });

  const v4 = evaluateProposal(addProposal, { rationale: "run add", citations: [] }, { grants: grants.active() });
  assert.equal(v4.type, "allow");

  const v5 = evaluateProposal(otherServerProposal, { rationale: "run srv2", citations: [] }, { grants: grants.active() });
  assert.equal(v5.type, "escalate");

  // 4. Grant universal wildcard "*": allows all MCP tools across all servers
  grants.issue({
    missionId,
    capability: "mcp_call",
    constraints: { mcpTools: ["*"] },
    expiresAt: null,
    issuer: "base-policy",
    parentGrantId: null,
  });

  const v6 = evaluateProposal(otherServerProposal, { rationale: "run srv2", citations: [] }, { grants: grants.active() });
  assert.equal(v6.type, "allow");

  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("McpClient: stdio JSON-RPC handshake, tool discovery, and invocation lifecycle", async () => {
  const client = new McpClient({
    id: "test-mock",
    command: process.execPath,
    args: [mockServerScript],
    enabled: true,
  });

  assert.equal(client.state, "created");
  await client.connect();
  assert.equal(client.state, "starting");

  const init = await client.initialize();
  assert.equal(client.state, "ready");
  assert.equal(init.serverInfo.name, "mock-mcp-server");

  // Discovery
  const tools = await client.listTools();
  assert.ok(tools.length >= 5);
  const echoTool = tools.find((t) => t.toolName === "echo");
  assert.ok(echoTool);
  assert.equal(echoTool?.namespacedName, "mcp.test-mock.echo");

  // Call success tool
  const echoResult = await client.callTool("echo", { message: "FORGE stdio test" });
  assert.equal(echoResult.isError, false);
  assert.equal(echoResult.content[0]?.text, "FORGE stdio test");

  // Call computation tool
  const addResult = await client.callTool("add", { a: 40, b: 2 });
  assert.equal(addResult.isError, false);
  assert.equal(addResult.content[0]?.text, "42");

  // Call tool with tool-level error (isError: true)
  const failResult = await client.callTool("failing_tool", {});
  assert.equal(failResult.isError, true);
  assert.ok(failResult.content[0]?.text?.includes("Database connection failed"));

  // Call tool that hangs -> verifies timeout
  await assert.rejects(
    async () => {
      await client.callTool("hang", {}, { timeoutMs: 150 });
    },
    (err: unknown) => err instanceof McpError && err.code === "MCP_TIMEOUT",
  );

  await client.close();
  assert.equal(client.state, "closed");
});

test("McpClient: robust handling of server startup crashes", async () => {
  const crashClient = new McpClient({
    id: "crash-test",
    command: process.execPath,
    args: [mockServerScript, "--crash-on-start"],
    enabled: true,
  });

  await crashClient.connect();
  await assert.rejects(
    async () => {
      await crashClient.initialize();
    },
    (err: unknown) => err instanceof McpError,
  );
  await crashClient.close();
});

test("McpRegistry: manages server configurations and cached discovery", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-reg-mcp-"));
  const reg1 = new McpRegistry(dataDir, [
    {
      id: "srv1",
      command: process.execPath,
      args: [mockServerScript],
      enabled: true,
    },
  ]);

  reg1.saveConfig();
  assert.ok(existsSync(join(dataDir, "mcp_servers.json")));

  // Load from persisted file
  const reg2 = new McpRegistry(dataDir);
  assert.equal(reg2.listServers().length, 1);
  assert.equal(reg2.getServer("srv1")?.id, "srv1");

  // Verify unstarted client throws MCP_SERVER_NOT_RUNNING
  assert.throws(() => reg2.getClient("srv1"), /MCP_SERVER_NOT_RUNNING/);

  // Client acquisition after explicit startServer
  await reg2.startServer("srv1");
  const client = reg2.getClient("srv1");
  assert.equal(client.state, "ready");
  const allTools = reg2.listAllDiscoveredTools();
  assert.ok(allTools.length >= 5);
  assert.ok(allTools.some((t) => t.namespacedName === "mcp.srv1.echo"));

  await reg2.closeAll();
  rmSync(dataDir, { recursive: true, force: true });
});

test("Governed Capability Execution: mcpCallImpl records evidence and cryptographic ledger entries", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-cap-mcp-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  store.append({
    kind: "mission.opened",
    author: "runtime",
    ts: new Date().toISOString(),
    body: {
      intent: "mcp test mission",
      goalSpec: { summary: "test governed mcp capability", proposedCriteria: [] },
    },
  });
  const env = new LocalEnvironment(dataDir);

  const reg = new McpRegistry(dataDir, [
    {
      id: "mock",
      command: process.execPath,
      args: [mockServerScript],
      enabled: true,
    },
  ]);
  setMcpRegistry(reg);

  // Secret to verify capture-time redaction
  const secretKey = "FORGE_SUPER_SECRET_API_KEY_999";
  const secretsMap = new Map([["test-secret" as never, secretKey]]);

  const capturedArtifacts = new Map<string, Uint8Array>();
  const ctx: DispatchContext = {
    workspaceRoot: dataDir,
    environment: env,
    environmentKind: "local",
    secrets: secretsMap,
    capture: (bytes: Uint8Array) => {
      // Simulate capture-time redaction like Engine does
      let text = new TextDecoder().decode(bytes);
      text = text.replaceAll(secretKey, "[REDACTED]");
      const cleanBytes = new TextEncoder().encode(text);
      const ref = sha256Hex(cleanBytes);
      capturedArtifacts.set(ref, cleanBytes);
      store.ledger.writeArtifact(cleanBytes, ref);
      return ref;
    },
    artifactBytes: (sha: string) => capturedArtifacts.get(sha) ?? null,
    urlAuthority: () => true,
    criterionResolver: () => null,
    signal: new AbortController().signal,
  };

  try {
    // 0. Verify unstarted server fails closed
    const unstartedResult = await mcpCallImpl.run(
      {
        capability: "mcp_call",
        args: { serverId: "mock", toolName: "echo", arguments: { message: "Fail closed" } },
      },
      ctx,
      { timeoutMs: 5000, signal: ctx.signal },
    );
    assert.equal((unstartedResult.observation as any).status, "protocol_error");

    // Explicitly start server via governed registry
    await reg.startServer("mock");

    // 1. Success execution: call "echo"
    const echoProposal = {
      capability: "mcp_call",
      args: { serverId: "mock", toolName: "echo", arguments: { message: "Evidence check" } },
    };
    const echoResult = await mcpCallImpl.run(echoProposal, ctx, { timeoutMs: 5000, signal: ctx.signal });
    assert.equal(echoResult.observationKind, "observation.mcp");
    const echoObs = echoResult.observation as {
      serverId: string;
      toolName: string;
      status: string;
      requestRef: string;
      resultRef: string;
      error: string | null;
    };
    assert.equal(echoObs.serverId, "mock");
    assert.equal(echoObs.toolName, "echo");
    assert.equal(echoObs.status, "success");
    assert.equal(echoObs.error, null);

    // Verify request and result artifacts exist in ledger
    const reqBytes = store.ledger.readArtifact(echoObs.requestRef);
    assert.ok(reqBytes);
    const reqObj = JSON.parse(new TextDecoder().decode(reqBytes));
    assert.equal(reqObj.arguments.message, "Evidence check");

    const resBytes = store.ledger.readArtifact(echoObs.resultRef);
    assert.ok(resBytes);
    assert.equal(new TextDecoder().decode(resBytes), "Evidence check");

    // Append observation to ledger
    store.append({
      kind: "observation.mcp",
      author: "runtime",
      ts: new Date().toISOString(),
      body: echoObs,
    });

    // 2. Secret Redaction Test: tool leaks secret -> captured artifact must be redacted
    const leakProposal = {
      capability: "mcp_call",
      args: { serverId: "mock", toolName: "secret_leak", arguments: { secretVal: secretKey } },
    };
    const leakResult = await mcpCallImpl.run(leakProposal, ctx, { timeoutMs: 5000, signal: ctx.signal });
    const leakObs = leakResult.observation as { resultRef: string; status: string };
    assert.equal(leakObs.status, "success");

    const leakedArtifact = store.ledger.readArtifact(leakObs.resultRef);
    assert.ok(leakedArtifact);
    const leakedText = new TextDecoder().decode(leakedArtifact);
    assert.ok(leakedText.includes("[REDACTED]"));
    assert.ok(!leakedText.includes(secretKey), "Secret must NOT exist in persisted artifact store");

    // 3. Tool Failure Test: failing_tool returns status: "tool_error"
    const failProposal = {
      capability: "mcp_call",
      args: { serverId: "mock", toolName: "failing_tool", arguments: {} },
    };
    const failResult = await mcpCallImpl.run(failProposal, ctx, { timeoutMs: 5000, signal: ctx.signal });
    const failObs = failResult.observation as { status: string; error: string | null };
    assert.equal(failObs.status, "tool_error");
    assert.ok(failObs.error?.includes("Database connection failed"));

    // 4. Large Output & Truncation
    const largeProposal = {
      capability: "mcp_call",
      args: { serverId: "mock", toolName: "large_output", arguments: { bytes: 600 * 1024 } },
    };
    const largeResult = await mcpCallImpl.run(largeProposal, ctx, { timeoutMs: 5000, signal: ctx.signal });
    const largeObs = largeResult.observation as { status: string; truncated: boolean };
    assert.equal(largeObs.status, "success");
    assert.equal(largeObs.truncated, true);

    // Verify full ledger cryptographic chain validity
    const validChain = store.ledger.verify();
    assert.equal(validChain.ok, true, "Ledger cryptographic hash chain must remain strictly valid");
  } finally {
    await reg.closeAll();
    setMcpRegistry(null);
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
