// anthropic.test.ts — F-09: protocol-level conformance for the
// anthropic-messages adapter against a real loopback server speaking the
// Anthropic SSE wire protocol. No cloud API key required.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolveModelFn, type ProviderDescriptor } from "../../src/model-router/router.js";
import type { ModelEvent, ModelRequest } from "../../src/contracts/model.js";

function descriptor(port: number): ProviderDescriptor {
  return {
    id: "loopback-anthropic",
    kind: "anthropic-messages",
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnvVar: "FORGE_ANTHROPIC_TEST_KEY",
    model: "test-claude",
    contextWindow: 100_000,
  };
}

const req = (signal: AbortSignal): ModelRequest => ({
  messages: [
    { role: "system", content: "runtime framing", provenance: "runtime-framing" },
    { role: "user", content: "work", provenance: "runtime-framing" },
  ],
  capabilityCards: [],
  activeGrants: [],
  maxOutputTokens: 100,
  signal,
});

test("anthropic: request formation (x-api-key, system extraction), streaming, structured extraction", async () => {
  const bodies: string[] = [];
  const headers: Record<string, string | undefined> = {};
  const server: Server = createServer((rq, res) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c: Buffer) => chunks.push(c));
    rq.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      headers["x-api-key"] = rq.headers["x-api-key"] as string | undefined;
      headers["anthropic-version"] = rq.headers["anthropic-version"] as string | undefined;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const proposalJson = JSON.stringify({ proposal: { capability: "shell", args: { argv: ["npm", "test"], cwd: "." } }, rationale: "r", citations: [] });
      const claimJson = JSON.stringify({ claim: "c", citations: ["rec_01HZZ000000000000000000001"] });
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "step 1\n" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: proposalJson + "\n" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: claimJson + "\n" } })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  process.env["FORGE_ANTHROPIC_TEST_KEY"] = "sk-test";
  const fn = resolveModelFn(descriptor(port));

  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);

  // request formation: system extracted from messages; auth via x-api-key
  assert.equal(headers["x-api-key"], "sk-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.ok(bodies[0]!.includes('"system":"runtime framing"'));
  assert.ok(bodies[0]!.includes('"model":"test-claude"'));

  const proposal = events.find((e) => e.type === "proposal");
  assert.ok(proposal && proposal.type === "proposal");
  if (proposal.type === "proposal") assert.equal(proposal.proposal.capability, "shell");
  const claim = events.find((e) => e.type === "claim");
  assert.ok(claim && claim.type === "claim");

  server.close();
  delete process.env["FORGE_ANTHROPIC_TEST_KEY"];
});

test("anthropic: 429 → RateLimited with bounded retries; auth failure → AuthFailed", async () => {
  let hits429 = 0;
  const s1: Server = createServer((_rq, res) => { hits429++; res.writeHead(429); res.end("{}"); });
  await new Promise<void>((r) => s1.listen(0, "127.0.0.1", () => r()));
  process.env["FORGE_ANTHROPIC_TEST_KEY"] = "k";
  const fn = resolveModelFn({ ...descriptor((s1.address() as { port: number }).port) });
  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error");
  assert.equal(err.error.code, "RateLimited");
  assert.ok(hits429 >= 2 && hits429 <= 5, "bounded retries");
  s1.close();

  const s2: Server = createServer((_rq, res) => { res.writeHead(401); res.end("{}"); });
  await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
  const fn2 = resolveModelFn({ ...descriptor((s2.address() as { port: number }).port) });
  const events2: ModelEvent[] = [];
  for await (const ev of fn2.complete(req(new AbortController().signal))) events2.push(ev);
  const err2 = events2.find((e) => e.type === "error");
  assert.ok(err2 && err2.type === "error");
  assert.equal(err2.error.code, "AuthFailed");
  s2.close();
  delete process.env["FORGE_ANTHROPIC_TEST_KEY"];
});

test("anthropic: malformed SSE chunks are skipped; truncated stream still yields extractable output", async () => {
  const server: Server = createServer((_rq, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: not-json-at-all\n\n");
    const claimJson = JSON.stringify({ claim: "ok", citations: ["rec_01HZZ000000000000000000001"] });
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: claimJson + "\n" } })}\n\n`);
    // no [DONE], connection just ends — truncated stream
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env["FORGE_ANTHROPIC_TEST_KEY"] = "k";
  const fn = resolveModelFn({ ...descriptor((server.address() as { port: number }).port) });
  const events: ModelEvent[] = [];
  for await (const ev of fn.complete(req(new AbortController().signal))) events.push(ev);
  const claim = events.find((e) => e.type === "claim");
  assert.ok(claim && claim.type === "claim");
  server.close();
  delete process.env["FORGE_ANTHROPIC_TEST_KEY"];
});
