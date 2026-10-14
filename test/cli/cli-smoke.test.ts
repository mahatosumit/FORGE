// cli-smoke.test.ts — CLI E2E: a real mission runs in the workspace (real
// effects, real verification), then the CLI binary reads the SAME ledger the
// way a user does: missions / inspect / log / receipt / doctor.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Engine } from "../../src/engine/engine.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../../src/contracts/model.js";

const CLI = join(process.cwd(), "dist", "cli", "cli.js"); // the built product artifact
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function runCli(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env } }).toString();
}

test("CLI e2e: run → verified receipt → missions/inspect/log/doctor reflect the ledger", async () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-cli-"));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  writeFileSync(join(ws, "test.js"), 'const fs=require("fs");const s=fs.readFileSync("src/cart/totals.ts","utf8");if(s.includes("roundToCent")){process.exit(0)}process.exit(1)');
  mkdirSync(join(ws, "src", "cart"), { recursive: true });
  writeFileSync(join(ws, "src", "cart", "totals.ts"), "export function total(items) { return items; }\n");

  const fixContent = "export function total(items: number[]) { return roundToCent(items.reduce((a, b) => a + b, 0)); }\nexport function roundToCent(n: number) { return Math.round(n * 100) / 100; }\n";
  const fixHash = sha(new TextEncoder().encode(fixContent));
  let call = 0;
  const model: ModelFn = {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      call++;
      if (call === 1) {
        yield { type: "content", sha256: fixHash, base64: Buffer.from(fixContent).toString("base64") };
        yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: "src/cart/totals.ts", contentRef: fixHash } }, meta: { rationale: "fix rounding", citations: [] } };
      } else {
        yield { type: "text-delta", text: "done" };
      }
    },
  };

  const dataDir = join(ws, ".forge", "data");
  const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
  const h = await engine.openQuickMission("Fix the failing checkout test");
  const result = await engine.executeMission(h);
  h.store.close();
  assert.equal(result.closure, "verified");

  // the CLI is a stateless reader over the same ledger
  const missions = runCli(ws, ["missions"]);
  assert.ok(missions.includes("closed:verified"));
  assert.ok(missions.includes("Fix the failing checkout test"));

  const inspect = runCli(ws, ["inspect", h.missionId]);
  assert.ok(inspect.includes("mission.closed: 1"));
  assert.ok(inspect.includes("verdict.recorded: 1"));

  const log = runCli(ws, ["log", h.missionId]);
  assert.ok(log.includes("fs write src/cart/totals.ts"));
  assert.ok(log.includes("criterion → pass (mechanical)"));
  assert.ok(log.includes("closed: verified"));

  const closedBody = (JSON.parse(runCli(ws, ["receipt", h.missionId])) as {
    receipt: {
      closure: string; weakestTier: string;
      changeManifest: Array<{ path: string | null }>;
      authorityManifest: Array<{ issuer: string }>;
      chainTip: string;
    };
  }).receipt;
  assert.equal(closedBody.closure, "verified");
  assert.equal(closedBody.weakestTier, "mechanical");
  assert.ok(closedBody.changeManifest.some((c) => c.path === "src/cart/totals.ts"));
  assert.ok(closedBody.authorityManifest.length >= 1);
  assert.match(closedBody.chainTip, /^[0-9a-f]{64}$/);

  // real effect on disk
  assert.ok(readFileSync(join(ws, "src", "cart", "totals.ts"), "utf8").includes("roundToCent"));

  rmSync(ws, { recursive: true, force: true });
});
