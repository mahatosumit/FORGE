import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInformationalIntent, cleanModelNarrative, Engine } from "../../src/engine/engine.js";
import { ForgeApi } from "../../src/api/server.js";
import type { ModelFn, ModelRequest, ModelEvent } from "../../src/contracts/model.js";

test("isInformationalIntent: correctly classifies questions and directives", () => {
  assert.equal(isInformationalIntent("tell me about nepal"), true);
  assert.equal(isInformationalIntent("tell me about sumit mahato team lead of optinx find out who this guy is"), true);
  assert.equal(isInformationalIntent("what is raft consensus?"), true);
  assert.equal(isInformationalIntent("who is the founder of Linux?"), true);
  assert.equal(isInformationalIntent("explain the difference between process and thread"), true);
  assert.equal(isInformationalIntent("how does memory compaction work?"), true);
  assert.equal(isInformationalIntent("describe the architectural patterns in this project"), true);
  assert.equal(isInformationalIntent("summarize recent changes"), true);
  assert.equal(isInformationalIntent("hi there"), true);
  assert.equal(isInformationalIntent("help"), true);

  // Coding and repository modification tasks are not informational
  assert.equal(isInformationalIntent("fix the failing test in checkout.test.ts"), false);
  assert.equal(isInformationalIntent("refactor the authentication middleware"), false);
  assert.equal(isInformationalIntent("patch totals.ts to round to 2 decimals"), false);
  assert.equal(isInformationalIntent("run npm test and build the project"), false);
  assert.equal(isInformationalIntent("create a new file at src/utils/math.ts"), false);
});

test("cleanModelNarrative: cleanly strips raw proposal blocks and robotic boilerplate", () => {
  const dirty = `
Based on the recent ledger and the goal to tell you about Nepal, I will propose an action to provide relevant information.

\`\`\`json
{
"proposal": {
"capability": "search",
"args": {
"query": "nepal facts",
"mode": "grep"
}
},
"rationale": "To gather information about Nepal, I will search for relevant facts.",
"citations": []
}
\`\`\`

Before executing the search, I'll provide some context about Nepal. Nepal is a landlocked country located in the Himalayas, bordered by India and China. It has a diverse geography, with Mount Everest being the highest point.

Now, I will execute the search proposal to gather more specific information about Nepal.
`;

  const cleaned = cleanModelNarrative(dirty);
  assert.ok(!cleaned.includes('{"proposal":'));
  assert.ok(!cleaned.includes("search proposal"));
  assert.ok(!cleaned.includes("Based on the recent ledger"));
  assert.ok(cleaned.includes("Nepal is a landlocked country located in the Himalayas"));
  assert.ok(cleaned.includes("Mount Everest"));

  const metaReflection = "General knowledge — answer directly.# Nepal — Overview\n\nNepal is a landlocked country.";
  const cleanedMeta = cleanModelNarrative(metaReflection);
  assert.ok(!cleanedMeta.includes("General knowledge"));
  assert.ok(cleanedMeta.startsWith("# Nepal — Overview"));

  const policyPrefix = "per policy: external person, answer directly, don't search codebase or web-scrape.Here's what I can tell you.";
  const cleanedPolicy = cleanModelNarrative(policyPrefix);
  assert.ok(!cleanedPolicy.includes("per policy:"));
  assert.ok(cleanedPolicy.startsWith("Here's what I can tell you."));
});

test("cleanModelNarrative: removes formatted multi-line and raw JSON proposal blocks", () => {
  const rawWithProposal = `
Nepal is a federal democratic republic in South Asia.
{
  "proposal": {
    "capability": "search",
    "args": { "query": "nepal" }
  }
}
Its capital is Kathmandu.
`;
  const cleaned = cleanModelNarrative(rawWithProposal);
  assert.ok(!cleaned.includes('"proposal"'));
  assert.ok(cleaned.includes("Nepal is a federal democratic republic in South Asia."));
  assert.ok(cleaned.includes("Its capital is Kathmandu."));
});

test("Engine: informational queries do not enforce mechanical criteria", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-info-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-ws-"));

  const mockModelFn: ModelFn = {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      yield {
        type: "text-delta",
        text: "Nepal is a sovereign country situated in South Asia between China and India, home to Mount Everest and the Himalayas.",
      };
    },
  };

  const engine = new Engine({
    dataDir,
    workspaceRoot,
    modelFn: mockModelFn,
  });

  const h = await engine.openConfiguredMission({
    intent: "tell me about nepal",
    verificationLevel: "standard",
  });

  // Verify no mechanical criteria were forced for a pure conversational query
  const records = h.store.read();
  const criteria = records.filter((r) => r.kind === "criterion.defined");
  assert.equal(criteria.length, 0);

  const result = await engine.executeMission(h);
  assert.equal(result.closure, "completed-unverified");

  h.store.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

test("ForgeApi: active tasks are tracked, status returns isRunning, and abort halts task", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-api-active-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-api-ws-"));

  let abortedObserved = false;
  const slowModelFn: ModelFn = {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      for (let i = 0; i < 50; i++) {
        if (req.signal?.aborted) {
          abortedObserved = true;
          return;
        }
        await new Promise((r) => setTimeout(r, 20));
        yield { type: "text-delta", text: `chunk ${i} ` };
      }
    },
  };

  const api = new ForgeApi({
    dataDir,
    workspaceRoot,
    modelFn: slowModelFn,
    port: 0,
  });
  await api.listen();

  // Start mission via API
  const res = await fetch(`http://127.0.0.1:${api.port}/missions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${api.token}`,
    },
    body: JSON.stringify({ intent: "tell me about nepal" }),
  });
  assert.equal(res.status, 201);
  const { missionId } = await res.json() as { missionId: string };

  // Check mission status immediately: isRunning should be true
  const statusRes = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}`, {
    headers: { authorization: `Bearer ${api.token}` },
  });
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json() as { isRunning: boolean; status: string };
  assert.equal(statusBody.isRunning, true);

  // Abort running mission
  const abortRes = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}/abort`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.token}` },
  });
  assert.equal(abortRes.status, 200);
  const abortBody = await abortRes.json() as { ok: boolean; aborted: boolean };
  assert.equal(abortBody.ok, true);
  assert.equal(abortBody.aborted, true);

  // Wait a moment for abort signal to take effect
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(abortedObserved, true);

  // Check mission status again: isRunning should now be false
  const statusResAfter = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}`, {
    headers: { authorization: `Bearer ${api.token}` },
  });
  assert.equal(statusResAfter.status, 200);
  const statusBodyAfter = await statusResAfter.json() as { isRunning: boolean };
  assert.equal(statusBodyAfter.isRunning, false);

  api.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});
