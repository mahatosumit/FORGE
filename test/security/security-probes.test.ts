// security-probes.test.ts — F-01/F-02/F-05 regression tests: the original
// audit attacks must now FAIL SAFELY.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { httpImpl } from "../../src/capabilities/http.js";
import { Engine, MissionClosedError } from "../../src/engine/engine.js";
import { openMission, openMissionReadOnly } from "../../src/ledger/index.js";
import { newMissionId } from "../../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../../src/contracts/model.js";
import type { DispatchContext } from "../../src/capability-host/types.js";

const ctx = (allowed: (url: string) => boolean): DispatchContext => ({
  workspaceRoot: ".",
  environment: {} as never,
  environmentKind: "local",
  secrets: new Map(),
  capture: () => "c".repeat(64),
  artifactBytes: () => null,
  criterionResolver: () => null,
  signal: new AbortController().signal,
  urlAuthority: allowed,
});

// ---------------------------------------------------------------------------
// F-01: redirect scope
// ---------------------------------------------------------------------------

test("F-01: same-host redirect is followed and the effective URL is recorded", async () => {
  let hops = 0;
  const server: Server = createServer((req, res) => {
    hops++;
    if (hops === 1) { res.writeHead(302, { location: "/step2" }); res.end(); }
    else { res.writeHead(200); res.end("ok"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const result = await httpImpl.run(
    { capability: "http", args: { method: "GET", url: base + "/", maxBytes: 1000 } },
    ctx((u) => u.startsWith(base)), // grant covers this host (any path)
    { timeoutMs: 5000, signal: new AbortController().signal },
  ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

  assert.equal(hops, 2);
  assert.equal(result.observation.status, 200);
  assert.equal(result.observation.effectiveUrl, base + "/step2");
  assert.equal(result.observation.redirectBlocked, false);
  server.close();
});

test("F-01: unauthorized cross-host redirect is refused; journal shows the escape attempt", async () => {
  let evilHits = 0;
  const evil: Server = createServer((_req, res) => { evilHits++; res.writeHead(200); res.end("exfiltrated"); });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
  const evilPort = (evil.address() as { port: number }).port;

  let grantedPort = 0;
  const granted: Server = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal` });
    res.end();
  });
  await new Promise<void>((r) => granted.listen(0, "127.0.0.1", () => r()));
  grantedPort = (granted.address() as { port: number }).port;

  const result = await httpImpl.run(
    { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${grantedPort}/`, maxBytes: 1000 } },
    ctx((u) => u.startsWith(`http://127.0.0.1:${grantedPort}`)), // granted: ONLY this host
    { timeoutMs: 5000, signal: new AbortController().signal },
  ) as { observation: { status: number; effectiveUrl: string; redirectBlocked: boolean } };

  assert.equal(evilHits, 0, "the unauthorized host must never receive a request");
  assert.equal(result.observation.redirectBlocked, true, "the refusal must be visible in the observation");
  assert.equal(result.observation.status, 302);
  granted.close(); evil.close();
});

test("F-01: redirect loops hit the hop limit and stop", async () => {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: "/loop" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const result = await httpImpl.run(
    { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${port}/`, maxBytes: 100 } },
    ctx(() => true),
    { timeoutMs: 5000, signal: new AbortController().signal },
  ) as { observation: { redirectBlocked: boolean } };
  assert.equal(result.observation.redirectBlocked, true);
  assert.ok(hits <= 8, "hop limit bounds the loop");
  server.close();
});

// ---------------------------------------------------------------------------
// F-05: claim citation kind binding
// ---------------------------------------------------------------------------

function makeEngineWs(): string {
  const ws = mkdtempSync(join(tmpdir(), "forge-cit-"));
  return ws;
}

test("F-05: a claim citing a GRANT record (non-observation) is rejected", async () => {
  const ws = makeEngineWs();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-cit-data-"));
  let call = 0;
  let grantIdSeen = "";
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      call++;
      if (call === 1) {
        yield { type: "claim", statement: "everything is done", citations: [grantIdSeen] } as never;
      } else {
        yield { type: "text-delta", text: "done" } as never;
      }
    },
  } as unknown as ModelFn;
  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  const h = await engine.openQuickMission("x");
  // discover the quick-lane grant record id (a grant.issued record exists)
  grantIdSeen = h.store.read().find((r) => r.kind === "grant.issued")!.id;
  await engine.executeMission(h);

  const rejected = h.store.read().find((r) => r.kind === "claim.rejected");
  assert.ok(rejected, "a claim citing a grant record must be REJECTED (INV-2 kind binding)");
  assert.equal(h.store.read().some((r) => r.kind === "claim.asserted"), false);
  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F-02: closed-mission resume guard + zero additional effects
// ---------------------------------------------------------------------------

test("F-02: resume on a closed mission is rejected with zero additional effects", async () => {
  const ws = makeEngineWs();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-closed-"));
  let call = 0;
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      call++;
      yield { type: "text-delta", text: "done" } as never;
    },
  } as unknown as ModelFn;
  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  const h = await engine.openQuickMission("x");
  const r = await engine.executeMission(h);
  assert.equal(r.closure, "completed-unverified");
  const recordsAtClose = h.store.read().length;

  await assert.rejects(engine.resume(h), MissionClosedError);
  assert.equal(h.store.read().length, recordsAtClose, "no records may be appended after closure");
  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Multi-stage: stage 1 executes once, survives restart, stage 2 runs once,
// resume never repeats stage 1.
// ---------------------------------------------------------------------------

test("multi-stage: restart between stages; completed stage is skipped exactly", async () => {
  const ws = makeEngineWs();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-ms-"));
  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();
  store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "two stages", goalSpec: { summary: "two stages", proposedCriteria: [] } } });
  const stages = [
    { id: "stg_" + (missionId.slice(10) + "A").padEnd(26, "0"), purpose: "stage one", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
    { id: "stg_" + (missionId.slice(10) + "B").padEnd(26, "0"), purpose: "stage two", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
  ];
  store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages } });
  const g = store.append({
    kind: "grant.issued", author: "runtime", ts,
    body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } },
  });
  void g;
  store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages, grantIds: [`grt_${missionId.slice(4)}`] } });
  store.close(); // release the constructing writer's lock before openHandle re-acquires

  // scripted model: writes a distinct file per stage via the stage purpose;
  // alternating calls propose-then-stop so each stage terminates cleanly
  let modelCall = 0;
  const model: ModelFn = {
    async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const isStageTwo = JSON.stringify(req.messages).includes("stage two");
      const n = isStageTwo ? 2 : 1;
      modelCall++;
      if (modelCall % 2 === 1) {
        const content = `stage${n}`;
        const hash = createHash("sha256").update(content).digest("hex");
        yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
        yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: `src/marker${n}.txt`, contentRef: hash } }, meta: { rationale: `marker ${n}`, citations: [] } } as never;
      }
      yield { type: "text-delta", text: "stage done" } as never;
    },
  } as unknown as ModelFn;
  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  // the constructing writer released the lock; openHandle re-acquires
  const h = engine.openHandle(missionId);
  const r1 = await engine.executeMission(h);
  assert.equal(r1.closure, "completed-unverified");
  const stageCompletions = h.store.read().filter((r) => r.kind === "stage.completed");
  assert.equal(stageCompletions.length, 2, "both stages must have completion records");

  // restart: close everything, reopen, resume — closed mission must reject
  h.store.close();
  const h2 = engine.openHandle(missionId);
  const dispatchesBefore = h2.store.read().filter((r) => r.kind === "proposal.dispatched").length;
  await assert.rejects(engine.resume(h2), MissionClosedError);
  assert.equal(h2.store.read().filter((r) => r.kind === "proposal.dispatched").length, dispatchesBefore);
  h2.store.close();

  // both stage effects exist exactly once
  const marker1Path = join(ws, "src", "marker1.txt");
  if (!existsSync(marker1Path)) {
    const ro = openMissionReadOnly(dataDir, h.missionId);
    console.error("DUMP:", ro.read().map((r) => [r.seq, r.kind, String(JSON.stringify(r.body)).slice(0, 160)]));
  }
  assert.ok(readFileSync(marker1Path, "utf8") === "stage1");
  assert.ok(readFileSync(join(ws, "src", "marker2.txt"), "utf8") === "stage2");

  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
