// provider.test.ts — M4/M7: the openai-compatible adapter works end-to-end
// against a REAL loopback HTTP server speaking the OpenAI SSE wire protocol.
// Also: error classification (429 → RateLimited; 500 → Transport with retry)
// and provider isolation (adapter only emits data events).

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolveModelFn, resolveRoutingModelFn, extractStructuredEvents, type ProviderDescriptor } from "../../src/model-router/router.js";
import type { ModelRequest } from "../../src/contracts/model.js";

function startServer(handler: (req: IncomingMessageLike, res: ServerResponseLike, body: string) => void): Promise<{ server: Server; port: number; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      bodies.push(body);
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, bodies });
    });
  });
}

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

function sse(res: ServerResponseLike, events: Array<{ delta?: string; done?: boolean }>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    if (e.done) res.write("data: [DONE]\n\n");
    else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: e.delta } }] })}\n\n`);
  }
  res.end();
}

function descriptor(port: number): ProviderDescriptor {
  return {
    id: "loopback",
    kind: "openai-compatible",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEnvVar: "FORGE_TEST_KEY",
    model: "test-model",
    contextWindow: 100_000,
  };
}

const req = (signal: AbortSignal): ModelRequest => ({
  messages: [{ role: "system", content: "frame", provenance: "runtime-framing" }],
  capabilityCards: [],
  activeGrants: [],
  maxOutputTokens: 100,
  signal,
});

test("provider: streaming text + structured proposal extraction over real HTTP/SSE", async () => {
  const { server, port } = await startServer((_q, res) => {
    sse(res, [
      { delta: "thinking...\n" },
      { delta: '{"proposal": {"capability": "shell", "args": {"argv": ["npm", "test"], "cwd": "."}}, "rationale": "run tests", "citations": []}\n' },
      { delta: '{"claim": "the suite is green", "citations": ["rec_01HZZ000000000000000000001"]}\n' },
      { done: true },
    ]);
  });
  process.env["FORGE_TEST_KEY"] = "test-key-123";
  const fn = resolveModelFn(descriptor(port));

  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);

  assert.ok(events.some((e) => e.type === "text-delta" && e.text.includes("thinking")));
  const proposal = events.find((e) => e.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  if (proposal.type === "proposal") {
    assert.equal(proposal.proposal.capability, "shell");
    assert.deepEqual(proposal.proposal.args.argv, ["npm", "test"]);
  }
  const claim = events.find((e) => e.type === "claim");
  assert.ok(claim && claim.type === "claim");
  assert.equal(claim.statement, "the suite is green");

  server.close();
  delete process.env["FORGE_TEST_KEY"];
});

test("provider: 429 → RateLimited error event (after bounded retries)", async () => {
  let hits = 0;
  const { server, port } = await startServer((_q, res) => {
    hits++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "slow down" }));
  });
  process.env["FORGE_TEST_KEY"] = "k";
  const fn = resolveModelFn({ ...descriptor(port) });
  // shrink retry backoff via attempts — bounded: 3 retries then error event
  const events: ModelEvent[] = [];
  const started = Date.now();
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  const elapsed = Date.now() - started;
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.error.code, "RateLimited");
  assert.ok(hits >= 2, "should have retried at least once");
  assert.ok(elapsed < 30_000, "bounded retries, not infinite");
  server.close();
  delete process.env["FORGE_TEST_KEY"];
});

test("provider: missing credential fails closed with AuthFailed (no request sent)", async () => {
  delete process.env["FORGE_TEST_KEY"];
  const { server, port, bodies } = await startServer((_q, res) => {
    res.writeHead(200); res.end("data: [DONE]\n\n");
  });
  const fn = resolveModelFn(descriptor(port));
  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.error.code, "AuthFailed");
  assert.equal(bodies.length, 0); // no request left the process
  server.close();
});

test("provider: malformed structured block yields InvalidOutput error event (never silently dropped)", async () => {
  const { server, port } = await startServer((_q, res) => {
    sse(res, [
      { delta: '{"proposal": { definitely not json }\n' },
      { done: true },
    ]);
  });
  process.env["FORGE_TEST_KEY"] = "k";
  const fn = resolveModelFn(descriptor(port));
  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.error.code, "InvalidOutput");
  server.close();
  delete process.env["FORGE_TEST_KEY"];
});

test("extractStructuredEvents: repairs literal newlines inside JSON string values", () => {
  // Small models pretty-print JSON with real newlines inside string values —
  // strict JSON.parse rejects this; the extractor must repair it conservatively.
  const sloppy =
    '{\n  "proposal": {\n    "capability": "fs",\n    "args": {\n      "op": "patch",\n      "path": "src/token-bucket.js",\n      "content": "line one\nline two\n"\n    },\n    "rationale": "fix the bug"\n  }\n}';
  const { events, invalid } = extractStructuredEvents(sloppy);
  // fs "patch" with `content` (a fragment) is NOT a patch — patch op requires `patch`
  // diff payload; schema refinement must reject it. args.content is an extra key on a
  // strict schema. So: 0 events, 1 invalid — fail-closed.
  assert.deepEqual(events, []);
  assert.equal(invalid.length, 1);
  assert.ok(invalid[0]!.includes("Unrecognized key"), "should cite the schema violation");
});

test("extractStructuredEvents: unparseable structured-looking block is reported, not dropped", () => {
  const { events, invalid } = extractStructuredEvents('{"proposal": { nope');
  assert.equal(events.length, 0);
  assert.ok(invalid.length > 0);
});

test("extractStructuredEvents: narration + single-line proposal + pretty-printed fs.write all extracted", () => {
  // Regression: the balanced-block scan previously only ran when no event had
  // parsed yet, silently dropping multi-line proposals that followed a
  // successfully-parsed single-line proposal in the same reply.
  const reply = [
    "I'll run the tests and then apply the fix.",
    '{"proposal": {"capability": "shell", "args": {"argv": ["npm", "test"], "cwd": "."}}, "rationale": "run tests", "citations": []}',
    '{\n  "proposal": {\n    "capability": "fs",\n    "args": {\n      "op": "write",\n      "path": "src/token-bucket.js",\n      "content": "export class TokenBucket {\\n  constructor() {\\n    this.tokens = 10;\\n  }\\n}\\n"\n    }\n  },\n  "rationale": "apply the fix"\n}',
  ].join("\n");
  const { events, invalid } = extractStructuredEvents(reply);
  const caps = events.filter((e) => e.type === "proposal").map((e) => (e as { proposal: { capability: string } }).proposal.capability);
  assert.deepEqual(caps, ["shell", "fs"], `expected both proposals, got ${JSON.stringify(caps)} / invalid: ${JSON.stringify(invalid)}`);
  assert.equal(invalid.length, 0);
});

test("router: credential pool rotates on 401 before yielding content from the next key", async () => {
  // Two env keys: first returns 401 (AuthFailed), second succeeds.
  const seenKeys: string[] = [];
  const { server, port } = await startServer((req, res) => {
    seenKeys.push(String(req.headers["authorization"]));
    if (String(req.headers["authorization"]).endsWith("bad-key")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
      return;
    }
    sse(res, [{ delta: "ok-from-second-key" }, { done: true }]);
  });
  process.env["FORGE_KEY_A"] = "bad-key";
  process.env["FORGE_KEY_B"] = "good-key";
  const d = { ...descriptor(port), apiKeyEnvVar: "FORGE_KEY_A" };
  const fn = resolveRoutingModelFn({ primary: d, credentialPool: ["FORGE_KEY_B"] });
  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  assert.ok(events.some((e) => e.type === "text-delta" && e.text.includes("ok-from-second-key")), "second credential must succeed");
  assert.ok(seenKeys.length >= 2, `expected rotation across credentials, got ${JSON.stringify(seenKeys)}`);
  assert.ok(seenKeys[0]!.endsWith("bad-key"));
  assert.ok(seenKeys[seenKeys.length - 1]!.endsWith("good-key"));
  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close();
  delete process.env["FORGE_KEY_A"];
  delete process.env["FORGE_KEY_B"];
});

import type { IncomingMessageLike as _I } from "node:http";
import type { ModelEvent } from "../../src/contracts/model.js";
