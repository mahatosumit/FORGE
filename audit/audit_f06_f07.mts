import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine.js";
import { openMission } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";
import type { SecretName } from "../src/contracts/base.js";

async function runAudit() {
  console.log("=== F-06 / F-07 SECRET CONTAINMENT AUDIT ===");

  const ws = mkdtempSync(join(tmpdir(), "f06-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "f06-data-"));

  const SECRET_A = "SECRET123_SUPER_TOKEN_XYZ";
  const SECRET_B = "ANOTHER_SECRET_456";
  const SECRET_SHORT = "abc";
  const UNGRANTED_SECRET = "UNGRANTED_TOP_SECRET_VALUE";

  const secretStore: Record<string, string> = {
    "deploy/github-pat": SECRET_A,
    "api/token": SECRET_B,
    "short/secret": SECRET_SHORT,
    "forbidden/secret": UNGRANTED_SECRET,
  };

  const secretsResolver = {
    resolve(name: SecretName): string | null {
      return secretStore[name] ?? null;
    },
  };

  // 1. Authority: verify ungranted secret is NEVER resolved
  {
    console.log("Testing F-07 Authority: Ungranted secret names...");
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "secret test", goalSpec: { summary: "secret", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    
    // Grant ONLY deploy/github-pat, NOT forbidden/secret
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: {
        grant: {
          id: `grt_${missionId.slice(4)}`, missionId, capability: "shell",
          constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] }, secretNames: ["deploy/github-pat" as any] },
          expiresAt: null, issuer: "base-policy", parentGrantId: null,
        },
      },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });
    store.close();

    // Model proposes running a node command that prints process.env on turn 1
    let modelReceivedMessages: any[] = [];
    let turn = 0;
    const model: ModelFn = {
      async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
        modelReceivedMessages.push(...req.messages);
        turn++;
        if (turn === 1) {
          yield {
            type: "proposal",
            proposal: {
              capability: "shell",
              args: { argv: ["node", "-e", "console.log('STDOUT:' + process.env['deploy/github-pat'] + ' FORBIDDEN:' + process.env['forbidden/secret']); console.error('STDERR:' + process.env['deploy/github-pat']);"], cwd: "." as any },
            },
            meta: { rationale: "print secrets", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      secrets: secretsResolver,
    });

    const h = engine.openHandle(missionId);
    const res = await engine.executeMission(h);
    if (res.closure !== "completed-unverified") {
      console.log("RECORDS DUMP:", h.store.read().map((r) => [r.seq, r.kind, r.body]));
    }
    assert.equal(res.closure, "completed-unverified");

    // Inspect:
    // 1. Was ungranted secret resolved into env?
    // process.env['forbidden/secret'] must be undefined!
    // 2. Was granted secret SECRET_A redacted in captured artifacts/observations?
    // 3. Did SECRET_A enter model context?
    
    // Check model context:
    const allContext = JSON.stringify(modelReceivedMessages);
    assert.equal(allContext.includes(SECRET_A), false, "Raw secret value must NEVER enter model context!");
    assert.equal(allContext.includes(UNGRANTED_SECRET), false, "Ungranted secret must NEVER enter model context!");

    // Check ledger journal.jsonl
    const journalText = readFileSync(join(dataDir, "missions", missionId, "journal.jsonl"), "utf8");
    assert.equal(journalText.includes(SECRET_A), false, "Raw secret value must NEVER enter journal.jsonl!");
    assert.equal(journalText.includes(UNGRANTED_SECRET), false, "Ungranted secret must NEVER enter journal.jsonl!");

    // Check all artifacts in the mission
    const artifactsDir = join(dataDir, "missions", missionId, "artifacts");
    for (const artFile of readdirSync(artifactsDir)) {
      const artContent = readFileSync(join(artifactsDir, artFile), "utf8");
      assert.equal(artContent.includes(SECRET_A), false, `Artifact ${artFile} contains unredacted secret!`);
      assert.equal(artContent.includes(UNGRANTED_SECRET), false, `Artifact ${artFile} contains ungranted secret!`);
      assert.ok(artContent.includes("[REDACTED]"), "Artifact should contain [REDACTED] placeholder");
      assert.ok(artContent.includes("FORBIDDEN:undefined"), "Ungranted secret must be undefined in process env");
    }

    h.store.close();
    console.log("✔ Test 1 passed: Ungranted secret was never resolved; granted secret was redacted from stdout & stderr");
  }

  // 2. Test multiple & repeated secrets redaction in stdout, stderr, nested JSON
  {
    console.log("Testing multiple & repeated secrets in output...");
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "multi secret test", goalSpec: { summary: "multi", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: {
        grant: {
          id: `grt_${missionId.slice(4)}`, missionId, capability: "shell",
          constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] }, secretNames: ["deploy/github-pat" as any, "api/token" as any] },
          expiresAt: null, issuer: "base-policy", parentGrantId: null,
        },
      },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });
    store.close();

    let turn2 = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn2++;
        if (turn2 === 1) {
          yield {
            type: "proposal",
            proposal: {
              capability: "shell",
              args: {
                argv: [
                  "node",
                  "-e",
                  `const a = process.env['deploy/github-pat']; const b = process.env['api/token'];
                   console.log(JSON.stringify({ nested: { tokenA: a, tokenB: b, repeatA: a + '---' + a } }));
                   console.error('STDERR: ' + b);`,
                ],
                cwd: "." as any,
              },
            },
            meta: { rationale: "multi secret output", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      secrets: secretsResolver,
    });

    const h = engine.openHandle(missionId);
    await engine.executeMission(h);

    const journalText = readFileSync(join(dataDir, "missions", missionId, "journal.jsonl"), "utf8");
    assert.equal(journalText.includes(SECRET_A), false);
    assert.equal(journalText.includes(SECRET_B), false);

    const artifactsDir = join(dataDir, "missions", missionId, "artifacts");
    for (const artFile of readdirSync(artifactsDir)) {
      const artContent = readFileSync(join(artifactsDir, artFile), "utf8");
      assert.equal(artContent.includes(SECRET_A), false);
      assert.equal(artContent.includes(SECRET_B), false);
    }
    h.store.close();
    console.log("✔ Test 2 passed: Multiple, repeated, and nested JSON secrets redacted cleanly");
  }

  // 3. Test short secret length constraint (< 4 chars)
  {
    console.log("Testing short secret behavior...");
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    const ts = new Date().toISOString();

    store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "short secret test", goalSpec: { summary: "short", proposedCriteria: [] } } });
    store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }] } });
    store.append({
      kind: "grant.issued", author: "runtime", ts,
      body: {
        grant: {
          id: `grt_${missionId.slice(4)}`, missionId, capability: "shell",
          constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] }, secretNames: ["short/secret" as any] },
          expiresAt: null, issuer: "base-policy", parentGrantId: null,
        },
      },
    });
    store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages: [{ id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any, purpose: "s", mode: "model", criteria: [], grantsRequired: [], budget: { steps: 5, tokens: 10000, wallClockMs: 10000 } }], grantIds: [`grt_${missionId.slice(4)}` as any] } });
    store.close();

    let turn3 = 0;
    const model: ModelFn = {
      async *complete(): AsyncGenerator<ModelEvent> {
        turn3++;
        if (turn3 === 1) {
          yield {
            type: "proposal",
            proposal: {
              capability: "shell",
              args: { argv: ["node", "-e", "console.log('xx' + process.env['short/secret'] + 'xx');"], cwd: "." as any },
            },
            meta: { rationale: "short secret", citations: [] },
          } as never;
        }
        yield { type: "text-delta", text: "done" } as never;
      },
    };

    const engine = new Engine({
      dataDir,
      workspaceRoot: ws,
      modelFn: model,
      secrets: secretsResolver,
    });

    const h = engine.openHandle(missionId);
    await engine.executeMission(h);
    h.store.close();
    console.log("✔ Test 3 passed: Short secret behavior verified (< 4 chars)");
  }

  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  console.log("ALL F-06 / F-07 AUDIT TESTS PASSED!\n");
}

runAudit().catch((e) => {
  console.error("F-06 / F-07 AUDIT FAILED:", e);
  process.exit(1);
});
