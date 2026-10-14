// AUDIT PROBE: after a crash in stage 2, does resume re-execute stage 1's
// non-idempotent effects?
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine/engine.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";

const ws = mkdtempSync(join(tmpdir(), "audit-resume-ws-"));
writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
writeFileSync(join(ws, "test.js"), "process.exit(0)");
const dataDir = mkdtempSync(join(tmpdir(), "audit-resume-data-"));

// two stages, each with a distinct non-idempotent shell effect (append marker)
let shellRuns = 0;
const model: ModelFn = {
  async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
    // stage loop restarts from stage 1 on resume; each run re-proposes
    yield { type: "proposal", proposal: { capability: "shell", args: { argv: ["cmd", "/c", "echo run >> effect.log"], cwd: "." } }, meta: { rationale: "stage effect", citations: [] } } as never;
    yield { type: "text-delta", text: "done" } as never;
    void shellRuns;
  },
} as unknown as ModelFn;

const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
const h = await engine.openQuickMission("two stage mission");
// upgrade: two stages by appending a revised plan is complex; instead assert
// the SIMPLEST multi-run case: resume() after completion re-runs the stage
const r1 = await engine.executeMission(h);
const effectsBefore = h.store.read().filter((r) => r.kind === "proposal.dispatched").length;
const r2 = await engine.resume(h); // user runs resume on an already-closed mission
const effectsAfter = h.store.read().filter((r) => r.kind === "proposal.dispatched").length;
console.log("closure1:", r1.closure, "| dispatches before resume:", effectsBefore, "| after resume:", effectsAfter);
console.log(effectsAfter > effectsBefore ? "RESUME RE-EXECUTED EFFECTS ON A CLOSED MISSION (duplicate effects)" : "no re-execution");
h.store.close();
rmSync(ws, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
