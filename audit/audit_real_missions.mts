import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { httpImpl } from "../src/capabilities/http.js";
import { Engine, MissionClosedError } from "../src/engine/engine.js";
import { openMission } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

async function runMissions() {
  console.log("=== RUNNING REAL END-TO-END MISSIONS 1 THROUGH 9 ===");

  // MISSION 1: Simple Coding Task (implement a function, verify file created)
  {
    console.log("Running Mission 1: Simple Coding Task...");
    const ws = mkdtempSync(join(tmpdir(), "m1-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m1-data-"));

    let turn = 0;
    const model: ModelFn = {
      async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
        turn++;
        if (turn === 1) {
          const code = "export function add(a: number, b: number) { return a + b; }\n";
          const hash = createHash("sha256").update(code).digest("hex");
          yield { type: "content", sha256: hash, base64: Buffer.from(code).toString("base64") } as never;
          yield {
            type: "proposal",
            proposal: { capability: "fs", args: { op: "write", path: "src/add.ts", contentRef: hash } },
            meta: { rationale: "create add function", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "coding complete" } as never;
      },
    };

    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("Implement add function in src/add.ts");
    const res = await engine.executeMission(h);

    assert.equal(res.closure, "completed-unverified");
    assert.ok(res.receipt);
    assert.ok(existsSync(join(ws, "src", "add.ts")));
    assert.equal(readFileSync(join(ws, "src", "add.ts"), "utf8"), "export function add(a: number, b: number) { return a + b; }\n");

    const records = h.store.read();
    assert.ok(records.some((r) => r.kind === "observation.fs"));
    assert.ok(records.some((r) => r.kind === "mission.closed"));
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 1 PASS: Simple coding task executed, persisted, and closed.");
  }

  // MISSION 2: Debugging Task (fix a bug, run test command, mechanical pass)
  {
    console.log("Running Mission 2: Debugging Task...");
    const ws = mkdtempSync(join(tmpdir(), "m2-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m2-data-"));
    
    // Create package.json with test script
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
    writeFileSync(join(ws, "test.js"), "const fs = require('fs'); const txt = fs.readFileSync('fix.txt', 'utf8'); if (txt.trim() !== 'fixed') process.exit(1);");

    let turn = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn++;
        if (turn === 1) {
          const content = "fixed\n";
          const hash = createHash("sha256").update(content).digest("hex");
          yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
          yield {
            type: "proposal",
            proposal: { capability: "fs", args: { op: "write", path: "src/fix.txt", contentRef: hash } },
            meta: { rationale: "apply fix", citations: [] },
          } as never;
          // Also write to root fix.txt
          yield {
            type: "proposal",
            proposal: { capability: "fs", args: { op: "write", path: "fix.txt", contentRef: hash } },
            meta: { rationale: "apply fix to root", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "debugging complete" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      onEscalation: async () => ({ decision: "extend", expiresAt: null }),
    });

    const h = await engine.openQuickMission("Fix bug");
    const res = await engine.executeMission(h);

    assert.equal(res.closure, "verified");
    assert.equal(res.receipt?.["weakestTier"], "mechanical");
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 2 PASS: Debugging task verified mechanically.");
  }

  // MISSION 3: Out-of-Grant Escalation
  {
    console.log("Running Mission 3: Out-of-Grant Escalation...");
    const ws = mkdtempSync(join(tmpdir(), "m3-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m3-data-"));

    let escalationSeen = false;
    let turn = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn++;
        if (turn === 1) {
          yield {
            type: "proposal",
            proposal: { capability: "shell", args: { argv: ["special-tool", "--run"], cwd: "." as any } },
            meta: { rationale: "need special tool", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      onEscalation: async (req) => {
        escalationSeen = true;
        assert.equal(req.capability, "shell");
        return { decision: "deny", expiresAt: null };
      },
    });

    const h = await engine.openQuickMission("Out-of-grant task");
    const res = await engine.executeMission(h);

    assert.equal(escalationSeen, true);
    assert.equal(res.closure, "blocked");
    assert.ok(res.receipt);
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 3 PASS: Out-of-grant escalation handled and cleanly blocked.");
  }

  // MISSION 4: Failed Verification
  {
    console.log("Running Mission 4: Failed Verification...");
    const ws = mkdtempSync(join(tmpdir(), "m4-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m4-data-"));

    // package.json with test that always fails (use double quotes for Windows cmd.exe)
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));

    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield { type: "text-delta", text: "I claimed it works but didn't fix it" } as never;
      },
    };

    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = await engine.openQuickMission("Failing task");
    const res = await engine.executeMission(h);

    assert.equal(res.closure, "failed");
    assert.ok(res.receipt);
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 4 PASS: Failed verification cannot close as verified.");
  }

  // MISSION 5: Two-Stage Mission with Restart
  {
    console.log("Running Mission 5: Two-Stage Mission with Restart...");
    const ws = mkdtempSync(join(tmpdir(), "m5-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m5-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    const stgs = [
      { id: "stg_" + (missionId.slice(10) + "A").padEnd(26, "0"), purpose: "stage1", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100000, wallClockMs: 60000 } },
      { id: "stg_" + (missionId.slice(10) + "B").padEnd(26, "0"), purpose: "stage2", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100000, wallClockMs: 60000 } },
    ];
    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "two stages", goalSpec: { summary: "two stages", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: stgs } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: stgs, grantIds: [`grt_${missionId.slice(4)}`] } });
    // Stage 1 completed
    store.append({ kind: "stage.completed", author: "runtime", ts, body: { stageId: stgs[0]!.id, outcome: "proceed" } });
    store.close();

    let stage2Executed = false;
    let turn = 0;
    const model: ModelFn = {
      async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
        assert.ok(JSON.stringify(req.messages).includes("stage2"), "Must be in stage 2");
        turn++;
        if (turn === 1) {
          stage2Executed = true;
          const content = "stage2_file";
          const hash = createHash("sha256").update(content).digest("hex");
          yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
          yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: "src/s2.txt", contentRef: hash } }, meta: { rationale: "s2", citations: [] } } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
    const h = engine.openHandle(missionId);
    const res = await engine.executeMission(h);

    assert.equal(res.closure, "completed-unverified");
    assert.equal(stage2Executed, true);
    assert.ok(existsSync(join(ws, "src", "s2.txt")));
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 5 PASS: Two-stage mission restart skipped stage 1 and executed stage 2.");
  }

  // MISSION 6: Crash After Effect but Before Observation
  {
    console.log("Running Mission 6: Crash After Effect Before Observation...");
    const ws = mkdtempSync(join(tmpdir(), "m6-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m6-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "crash test", goalSpec: { summary: "crash", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    store.append({ kind: "grant.issued", author: "runtime", ts, body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: {}, expiresAt: null, issuer: "base-policy", parentGrantId: null } } });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });

    const pRec = store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "fs", args: { op: "write", path: "src/crash.txt", contentRef: "0".repeat(64) } }, meta: { rationale: "w", citations: [] } } });
    store.append({ kind: "proposal.validated", author: "runtime", ts, refs: [pRec.id], body: { proposalId: pRec.id, result: "accepted", reasonCode: "in-grant", grantId: `grt_${missionId.slice(4)}` } });
    store.append({ kind: "proposal.dispatched", author: "runtime", ts, refs: [pRec.id], body: { proposalId: pRec.id, grantId: `grt_${missionId.slice(4)}`, environment: "local", timeoutMs: 30000 } });
    store.close();

    let acked = false;
    const engine = new Engine({
      dataDir, workspaceRoot: ws,
      modelFn: { async *complete() { yield { type: "text-delta", text: "done" } as never; } },
      onPostEffectUnknown: async () => { acked = true; return true; },
    });

    const h = engine.openHandle(missionId);
    await engine.resume(h);
    assert.equal(acked, true);
    assert.ok(h.store.read().some((r) => r.kind === "observation.interrupted"));
    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 6 PASS: Crash after dispatch classified post-effect-unknown and safely recovered.");
  }

  // MISSION 7: Unauthorized HTTP Redirect
  {
    console.log("Running Mission 7: Unauthorized HTTP Redirect...");
    const ws = mkdtempSync(join(tmpdir(), "m7-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m7-data-"));

    let evilHits = 0;
    const evil = createServer((_req, res) => { evilHits++; res.writeHead(200); res.end("evil"); });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
    const pe = (evil.address() as { port: number }).port;

    const granted = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${pe}/` }); res.end(); });
    await new Promise<void>((r) => granted.listen(0, "127.0.0.1", () => r()));
    const pg = (granted.address() as { port: number }).port;

    let turn = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn++;
        if (turn === 1) {
          yield {
            type: "proposal",
            proposal: { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${pg}/`, maxBytes: 1000 } },
            meta: { rationale: "fetch granted", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const res = await httpImpl.run(
      { capability: "http", args: { method: "GET", url: `http://127.0.0.1:${pg}/`, maxBytes: 1000 } },
      {
        workspaceRoot: ws,
        environment: {} as never,
        environmentKind: "local",
        secrets: new Map(),
        capture: () => "0".repeat(64),
        artifactBytes: () => null,
        criterionResolver: () => null,
        signal: new AbortController().signal,
        urlAuthority: (u) => {
          try { return new URL(u).port === String(pg); } catch { return false; }
        },
      },
      { timeoutMs: 5000, signal: new AbortController().signal },
    ) as { observation: { redirectBlocked: boolean } };

    assert.equal(evilHits, 0, "Evil server must receive 0 hits");
    assert.equal(res.observation.redirectBlocked, true);

    granted.close(); evil.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 7 PASS: Unauthorized HTTP redirect blocked with zero requests to ungranted host.");
  }

  // MISSION 8: Secret-Containing Capability Output
  {
    console.log("Running Mission 8: Secret-Containing Output...");
    const ws = mkdtempSync(join(tmpdir(), "m8-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m8-data-"));

    const SECRET_KEY = "SUPER_SECRET_DEPLOY_KEY_999";
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "secret mission", goalSpec: { summary: "secret", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: {
        grant: {
          id: `grt_${missionId.slice(4)}`, missionId, capability: "shell",
          constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] }, secretNames: ["app/deploy_key" as any] },
          expiresAt: null, issuer: "base-policy", parentGrantId: null,
        },
      },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });
    store.close();

    let turn = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn++;
        if (turn === 1) {
          yield {
            type: "proposal",
            proposal: {
              capability: "shell",
              args: { argv: ["node", "-e", "console.log('KEY=' + process.env['app/deploy_key']);"], cwd: "." as any },
            },
            meta: { rationale: "print key", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      secrets: { resolve: (n) => (n === "app/deploy_key" ? SECRET_KEY : null) },
    });

    const h = engine.openHandle(missionId);
    await engine.executeMission(h);

    const journal = readFileSync(join(dataDir, "missions", missionId, "journal.jsonl"), "utf8");
    assert.equal(journal.includes(SECRET_KEY), false, "Raw secret must not be in journal");

    const artifactsDir = join(dataDir, "missions", missionId, "artifacts");
    for (const art of readdirSync(artifactsDir)) {
      const content = readFileSync(join(artifactsDir, art), "utf8");
      assert.equal(content.includes(SECRET_KEY), false, "Raw secret must not be in artifact");
      assert.ok(content.includes("[REDACTED]"), "Artifact must contain [REDACTED]");
    }

    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 8 PASS: Secret-containing output redacted before persistence.");
  }

  // MISSION 9: Closed Mission Resume Rejection
  {
    console.log("Running Mission 9: Closed Mission Resume Rejection...");
    const ws = mkdtempSync(join(tmpdir(), "m9-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "m9-data-"));

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: { async *complete() { yield { type: "text-delta", text: "done" } as never; } },
    });

    const h = await engine.openQuickMission("closed mission");
    await engine.executeMission(h);

    await assert.rejects(async () => {
      await engine.resume(h);
    }, MissionClosedError);

    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Mission 9 PASS: Closed mission resume rejected cleanly.");
  }

  console.log("\nALL 9 REAL MISSIONS EXECUTED AND PASSED SUCCESSFULLY!\n");
}

runMissions().catch((e) => {
  console.error("MISSION AUDIT FAILED:", e);
  process.exit(1);
});
