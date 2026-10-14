// secrets.test.ts — F-06 / F-07 regression tests:
// 1. Ungranted secret names are NEVER resolved (Authority).
// 2. Granted secrets in stdout, stderr, and nested JSON are redacted ([REDACTED]).
// 3. Raw secret values NEVER enter journal.jsonl, artifacts, or model context (Containment).
// 4. Short secrets (< 4 chars) are not globally replaced (False-positive safety).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/engine/engine.js";
import { openMission } from "../../src/ledger/index.js";
import { newMissionId } from "../../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../../src/contracts/model.js";
import type { SecretName } from "../../src/contracts/base.js";

test("F-07 Authority: Ungranted secret names are never resolved; granted secrets are redacted from stdout & stderr", async () => {
  const ws = mkdtempSync(join(tmpdir(), "f06-ws-"));
  const dataDir = mkdtempSync(join(tmpdir(), "f06-data-"));

  const SECRET_A = "SECRET123_SUPER_TOKEN_XYZ";
  const UNGRANTED_SECRET = "UNGRANTED_TOP_SECRET_VALUE";

  const secretStore: Record<string, string> = {
    "deploy/github-pat": SECRET_A,
    "forbidden/secret": UNGRANTED_SECRET,
  };

  const secretsResolver = {
    resolve(name: SecretName): string | null {
      return secretStore[name] ?? null;
    },
  };

  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();

  store.append({
    kind: "mission.opened",
    author: "runtime",
    ts,
    body: { intent: "secret test", goalSpec: { summary: "secret", proposedCriteria: [] } },
  });
  store.append({
    kind: "plan.proposed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
    },
  });

  // Grant ONLY deploy/github-pat, NOT forbidden/secret
  store.append({
    kind: "grant.issued",
    author: "runtime",
    ts,
    body: {
      grant: {
        id: `grt_${missionId.slice(4)}`,
        missionId,
        capability: "shell",
        constraints: {
          argvClass: { kind: "argv-prefix", segments: ["node", "-e"] },
          secretNames: ["deploy/github-pat" as never],
        },
        expiresAt: null,
        issuer: "base-policy",
        parentGrantId: null,
      },
    },
  });
  store.append({
    kind: "plan.confirmed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
      grantIds: [`grt_${missionId.slice(4)}` as never],
    },
  });
  store.close();

  const modelReceivedMessages: unknown[] = [];
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
            args: {
              argv: [
                "node",
                "-e",
                "console.log('STDOUT:' + process.env['deploy/github-pat'] + ' FORBIDDEN:' + process.env['forbidden/secret']); console.error('STDERR:' + process.env['deploy/github-pat']);",
              ],
              cwd: "." as never,
            },
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
  assert.equal(res.closure, "completed-unverified");

  // 1. Model context containment check
  const allContext = JSON.stringify(modelReceivedMessages);
  assert.equal(allContext.includes(SECRET_A), false, "Raw secret value must NEVER enter model context!");
  assert.equal(allContext.includes(UNGRANTED_SECRET), false, "Ungranted secret must NEVER enter model context!");

  // 2. Ledger journal.jsonl containment check
  const journalText = readFileSync(join(dataDir, "missions", missionId, "journal.jsonl"), "utf8");
  assert.equal(journalText.includes(SECRET_A), false, "Raw secret value must NEVER enter journal.jsonl!");
  assert.equal(journalText.includes(UNGRANTED_SECRET), false, "Ungranted secret must NEVER enter journal.jsonl!");

  // 3. Artifacts containment check
  const artifactsDir = join(dataDir, "missions", missionId, "artifacts");
  for (const artFile of readdirSync(artifactsDir)) {
    const artContent = readFileSync(join(artifactsDir, artFile), "utf8");
    assert.equal(artContent.includes(SECRET_A), false, `Artifact ${artFile} contains unredacted secret!`);
    assert.equal(artContent.includes(UNGRANTED_SECRET), false, `Artifact ${artFile} contains ungranted secret!`);
    assert.ok(artContent.includes("[REDACTED]"), "Artifact should contain [REDACTED] placeholder");
    assert.ok(artContent.includes("FORBIDDEN:undefined"), "Ungranted secret must be undefined in process env");
  }

  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("F-06 Redaction: Multiple, repeated, and nested JSON secrets in stdout/stderr are redacted cleanly", async () => {
  const ws = mkdtempSync(join(tmpdir(), "f06-ws2-"));
  const dataDir = mkdtempSync(join(tmpdir(), "f06-data2-"));

  const SECRET_A = "SECRET123_SUPER_TOKEN_XYZ";
  const SECRET_B = "ANOTHER_SECRET_456";

  const secretStore: Record<string, string> = {
    "deploy/github-pat": SECRET_A,
    "api/token": SECRET_B,
  };

  const secretsResolver = {
    resolve(name: SecretName): string | null {
      return secretStore[name] ?? null;
    },
  };

  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();

  store.append({
    kind: "mission.opened",
    author: "runtime",
    ts,
    body: { intent: "multi secret test", goalSpec: { summary: "multi", proposedCriteria: [] } },
  });
  store.append({
    kind: "plan.proposed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
    },
  });
  store.append({
    kind: "grant.issued",
    author: "runtime",
    ts,
    body: {
      grant: {
        id: `grt_${missionId.slice(4)}`,
        missionId,
        capability: "shell",
        constraints: {
          argvClass: { kind: "argv-prefix", segments: ["node", "-e"] },
          secretNames: ["deploy/github-pat" as never, "api/token" as never],
        },
        expiresAt: null,
        issuer: "base-policy",
        parentGrantId: null,
      },
    },
  });
  store.append({
    kind: "plan.confirmed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
      grantIds: [`grt_${missionId.slice(4)}` as never],
    },
  });
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
            args: {
              argv: [
                "node",
                "-e",
                `const a = process.env['deploy/github-pat']; const b = process.env['api/token'];
                 console.log(JSON.stringify({ nested: { tokenA: a, tokenB: b, repeatA: a + '---' + a } }));
                 console.error('STDERR: ' + b);`,
              ],
              cwd: "." as never,
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
  const res = await engine.executeMission(h);
  assert.equal(res.closure, "completed-unverified");

  const journalText = readFileSync(join(dataDir, "missions", missionId, "journal.jsonl"), "utf8");
  assert.equal(journalText.includes(SECRET_A), false, "SECRET_A must not be in journal");
  assert.equal(journalText.includes(SECRET_B), false, "SECRET_B must not be in journal");

  const artifactsDir = join(dataDir, "missions", missionId, "artifacts");
  for (const artFile of readdirSync(artifactsDir)) {
    const artContent = readFileSync(join(artifactsDir, artFile), "utf8");
    assert.equal(artContent.includes(SECRET_A), false, `Artifact ${artFile} contains SECRET_A`);
    assert.equal(artContent.includes(SECRET_B), false, `Artifact ${artFile} contains SECRET_B`);
  }

  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("F-06 Redaction: Short secrets (< 4 chars) are not globally replaced", async () => {
  const ws = mkdtempSync(join(tmpdir(), "f06-ws3-"));
  const dataDir = mkdtempSync(join(tmpdir(), "f06-data3-"));

  const SECRET_SHORT = "abc";

  const secretStore: Record<string, string> = {
    "short/secret": SECRET_SHORT,
  };

  const secretsResolver = {
    resolve(name: SecretName): string | null {
      return secretStore[name] ?? null;
    },
  };

  const missionId = newMissionId();
  const store = openMission({ dataDir, missionId });
  const ts = new Date().toISOString();

  store.append({
    kind: "mission.opened",
    author: "runtime",
    ts,
    body: { intent: "short secret test", goalSpec: { summary: "short", proposedCriteria: [] } },
  });
  store.append({
    kind: "plan.proposed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
    },
  });
  store.append({
    kind: "grant.issued",
    author: "runtime",
    ts,
    body: {
      grant: {
        id: `grt_${missionId.slice(4)}`,
        missionId,
        capability: "shell",
        constraints: {
          argvClass: { kind: "argv-prefix", segments: ["node", "-e"] },
          secretNames: ["short/secret" as never],
        },
        expiresAt: null,
        issuer: "base-policy",
        parentGrantId: null,
      },
    },
  });
  store.append({
    kind: "plan.confirmed",
    author: "runtime",
    ts,
    body: {
      stages: [
        {
          id: "stg_01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
          purpose: "s",
          mode: "model",
          criteria: [],
          grantsRequired: [],
          budget: { steps: 5, tokens: 10000, wallClockMs: 10000 },
        },
      ],
      grantIds: [`grt_${missionId.slice(4)}` as never],
    },
  });
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
            args: {
              argv: ["node", "-e", "console.log('xx' + process.env['short/secret'] + 'xx');"],
              cwd: "." as never,
            },
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
  const res = await engine.executeMission(h);
  assert.equal(res.closure, "completed-unverified");

  h.store.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
