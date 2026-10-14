// AUDIT PROBE 2: resume() on an already-CLOSED verified mission — does the
// engine re-execute granted effects?
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Engine } from "../src/engine/engine.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

const ws = mkdtempSync(join(tmpdir(), "audit-r2-ws-"));
writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
writeFileSync(join(ws, "test.js"), "process.exit(0)"); // always passes
mkdirSync(join(ws, "src"), { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "audit-r2-data-"));

let calls = 0;
const model: ModelFn = {
  async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
    calls++;
    if (calls % 2 === 1) {
      const c = "x".repeat(calls);
      yield { type: "content", sha256: createHash("sha256").update(c).digest("hex"), base64: Buffer.from(c).toString("base64") } as never;
      yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: `src/f${calls}.ts`, contentRef: createHash("sha256").update(c).digest("hex") } }, meta: { rationale: "write", citations: [] } } as never;
    } else {
      yield { type: "text-delta", text: "done" } as never;
    }
  },
} as unknown as ModelFn;

const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
const h = await engine.openQuickMission("mission");
const r1 = await engine.executeMission(h);
const dispatches1 = h.store.read().filter((r) => r.kind === "proposal.dispatched").length;
const closureAtClose = h.store.read().some((r) => r.kind === "mission.closed");

// NOW the user runs forge resume on the closed mission:
const r2 = await engine.resume(h);
const dispatches2 = h.store.read().filter((r) => r.kind === "proposal.dispatched").length;

console.log("closure1:", r1.closure, "| closed record:", closureAtClose, "| dispatches:", dispatches1);
console.log("resume closure:", r2.closure, "| dispatches after resume:", dispatches2);
console.log(dispatches2 > dispatches1 ? "FINDING: resume re-executed effects on a CLOSED mission" : "no re-execution");
h.store.close();
rmSync(ws, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
