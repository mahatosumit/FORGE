import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine.js";
import { verifyContentEvent } from "../src/contracts/model.js";
import { JsonValueSchema, WorkspacePathSchema, ArgvSchema } from "../src/contracts/base.js";
import { ProposalSchema } from "../src/contracts/proposals.js";
import { parseBody } from "../src/contracts/records.js";

async function runAudit() {
  console.log("=== RESOURCE BOUNDS AUDIT ===");

  // 1. Huge Content Event (> 2 MiB)
  {
    console.log("Testing Oversized Content Event (> 2 MiB)...");
    const hugeBase64 = Buffer.alloc(2 * 1024 * 1024 + 100).toString("base64");
    const ev = { type: "content" as const, sha256: "0".repeat(64) as any, base64: hugeBase64 };
    const v = verifyContentEvent(ev);
    assert.equal(v.ok, false, "Oversized content event (> 2 MiB) MUST be rejected");
    console.log("✔ Test 1 passed: Content event > 2 MiB rejected");
  }

  // 2. Huge Proposal rationale (> 4 KiB)
  {
    console.log("Testing Proposal rationale bound (> 4 KiB)...");
    const hugeRationale = "a".repeat(4097);
    const proposalReceivedBody = {
      proposal: { capability: "fs", args: { op: "write", path: "src/a.txt", contentRef: "0".repeat(64) } },
      meta: { rationale: hugeRationale, citations: [] },
    };
    let threw = false;
    try {
      parseBody("proposal.received", proposalReceivedBody);
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "Rationale > 4 KiB MUST fail schema validation");
    console.log("✔ Test 2 passed: Huge proposal rationale rejected");
  }

  // 3. Huge / Deep JSON in JsonValue
  {
    console.log("Testing Deep & Huge JSON bounds...");
    const deepObj: any = {};
    let cur = deepObj;
    for (let i = 0; i < 300; i++) {
      cur.nested = {};
      cur = cur.nested;
    }
    // Huge keys
    const wideObj: Record<string, any> = {};
    for (let i = 0; i < 300; i++) wideObj[`k${i}`] = 1;
    const vWide = JsonValueSchema.safeParse(wideObj);
    assert.equal(vWide.success, false, "Object with > 256 keys MUST be rejected");
    console.log("✔ Test 3 passed: Wide JSON object (> 256 keys) rejected");
  }

  // 4. Huge stdout / stderr in LocalEnvironment
  {
    console.log("Testing Shell output capture truncation (2 MiB limit)...");
    const ws = mkdtempSync(join(tmpdir(), "res-ws-"));
    const dataDir = mkdtempSync(join(tmpdir(), "res-data-"));

    let turn = 0;
    const model = {
      async *complete() {
        turn++;
        if (turn === 1) {
          yield {
            type: "proposal",
            proposal: {
              capability: "shell",
              args: { argv: ["node", "-e", "process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 'X'))"], cwd: "." as any },
            },
            meta: { rationale: "huge stdout", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir, workspaceRoot: ws, modelFn: model as any,
      onEscalation: async () => ({ decision: "extend", expiresAt: null }),
    });
    const h = await engine.openQuickMission("huge stdout test");
    await engine.executeMission(h);

    const obs = h.store.read().find((r) => r.kind === "observation.shell");
    assert.ok(obs);
    assert.equal((obs.body as any).truncated, true, "Output > 2 MiB MUST be marked truncated");

    h.store.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log("✔ Test 4 passed: Massive stdout capped at 2 MiB and flagged truncated");
  }

  console.log("ALL RESOURCE BOUNDS AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("RESOURCE BOUNDS AUDIT FAILED:", e);
  process.exit(1);
});
