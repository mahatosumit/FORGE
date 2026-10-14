import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, MissionClosedError } from "../src/engine/engine.js";
import { openMission, openMissionReadOnly } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

async function runAudit() {
  console.log("=== F-03 BLOCKED MISSION CLOSURE AUDIT ===");

  // 1. Escalation Denial -> mission.closed{blocked} with receipt
  {
    const ws = mkdtempSync(join(tmpdir(), "f03-deny-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f03-deny-data-"));
    let escalationCalled = false;

    const outOfGrantModel: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield {
          type: "proposal",
          proposal: { capability: "shell", args: { argv: ["rm", "-rf", "/tmp/forbidden"], cwd: "." as never } },
          meta: { rationale: "need root cleanup", citations: [] },
        } as never;
        yield { type: "text-delta", text: "waiting" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: outOfGrantModel,
      onEscalation: async (req) => {
        escalationCalled = true;
        assert.equal(req.capability, "shell");
        return { decision: "deny", expiresAt: null };
      },
    });

    const h = await engine.openQuickMission("test escalation denial");
    const res = await engine.executeMission(h);

    assert.equal(escalationCalled, true, "onEscalation must be called");
    assert.equal(res.closure, "blocked", "Mission must close as 'blocked' on denial");
    assert.ok(res.receipt, "Receipt must be assembled and returned");
    assert.equal(res.receipt.closure, "blocked");

    // Check ledger records
    const records = h.store.read();
    const closedRec = records.find((r) => r.kind === "mission.closed");
    assert.ok(closedRec, "mission.closed record must be present");
    assert.equal((closedRec.body as any).closure, "blocked");

    const grantDecided = records.find((r) => r.kind === "grant.decided");
    assert.ok(grantDecided, "grant.decided record must be present in ledger");
    assert.equal((grantDecided.body as any).decision, "deny");

    // Resume on blocked mission must be rejected
    await assert.rejects(async () => {
      await engine.resume(h);
    }, MissionClosedError);

    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 1 passed: Escalation denial leads to terminal mission.closed{blocked} and valid receipt");
  }

  // 2. Escalation Timeout (in API / Engine)
  {
    const ws = mkdtempSync(join(tmpdir(), "f03-timeout-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f03-timeout-data-"));

    const outOfGrantModel: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        yield {
          type: "proposal",
          proposal: { capability: "shell", args: { argv: ["curl", "http://evil.com"], cwd: "." as never } },
          meta: { rationale: "network request", citations: [] },
        } as never;
      },
    };

    // Simulate timeout by not resolving or letting default escalation handler deny
    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: outOfGrantModel,
      // No onEscalation provided -> engine returns { escalated: true } -> runStage returns "escalate" -> mission closes as "blocked"
    });

    const h = await engine.openQuickMission("test escalation timeout");
    const res = await engine.executeMission(h);
    assert.equal(res.closure, "blocked", "Without user decision, escalation turns into blocked mission closure");
    assert.ok(res.receipt);

    const closed = h.store.read().find((r) => r.kind === "mission.closed");
    assert.ok(closed);
    assert.equal((closed.body as any).closure, "blocked");

    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 2 passed: Escalation timeout / absence closes mission as blocked");
  }

  // 3. Process restart during escalation
  {
    const ws = mkdtempSync(join(tmpdir(), "f03-restart-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "f03-restart-data-"));
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "restart during escalation", goalSpec: { summary: "test", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s1", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s1", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [] } });

    // Host appends grant.requested and then crashes
    const prop = store.append({ kind: "proposal.received", author: "model", ts, body: { proposal: { capability: "shell", args: { argv: ["ls"], cwd: "." as any } }, meta: { rationale: "r", citations: [] } } });
    store.append({ kind: "proposal.validated", author: "runtime", ts, refs: [prop.id], body: { proposalId: prop.id, result: "rejected-gate", reasonCode: "out-of-grant" } });
    store.append({ kind: "grant.requested", author: "runtime", ts, refs: [prop.id], body: { proposalId: prop.id, capability: "shell", requested: { argvClass: { kind: "exact", argv: ["ls"] } }, rationale: "r", citations: [] } });
    store.close();

    // Now restart process and resume
    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: {
        async *complete(): AsyncGenerator<ModelEvent> {
          yield { type: "text-delta", text: "done after restart" } as never;
        },
      },
    });

    const h = engine.openHandle(missionId);
    const res = await engine.resume(h);
    // Mission continues or finishes cleanly without deadlock
    assert.ok(res.closure === "completed-unverified" || res.closure === "blocked");
    h.store.close();

    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 3 passed: Process restart during escalation resumes cleanly from ledger");
  }

  console.log("ALL F-03 AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("F-03 AUDIT FAILED:", e);
  process.exit(1);
});
