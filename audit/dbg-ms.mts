import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Engine } from "../src/engine/engine.js";
import { openMission } from "../src/ledger/index.js";
import { newMissionId } from "../src/grants/grants.js";
import type { ModelFn, ModelEvent, ModelRequest } from "../src/contracts/model.js";
const ws = mkdtempSync(join(tmpdir(), "dbg-ws-"));
const dataDir = mkdtempSync(join(tmpdir(), "dbg-data-"));
const missionId = newMissionId();
const store = openMission({ dataDir, missionId });
const ts = new Date().toISOString();
store.append({ kind: "mission.opened", author: "runtime", ts, body: { intent: "two stages", goalSpec: { summary: "two stages", proposedCriteria: [] } } });
const stages = [
  { id: "stg_" + (missionId.slice(10) + "A").padEnd(26, "0"), purpose: "stage one", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
  { id: "stg_" + (missionId.slice(10) + "B").padEnd(26, "0"), purpose: "stage two", mode: "model" as const, criteria: [], grantsRequired: [], budget: { steps: 3, tokens: 100_000, wallClockMs: 60_000 } },
];
store.append({ kind: "plan.proposed", author: "runtime", ts, body: { stages } });
store.append({ kind: "grant.issued", author: "runtime", ts, body: { grant: { id: `grt_${missionId.slice(4)}`, missionId, capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } } });
store.append({ kind: "plan.confirmed", author: "runtime", ts, body: { stages, grantIds: [`grt_${missionId.slice(4)}`] } });
store.close();
let call = 0;
const model: ModelFn = {
  async *complete(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const isStageTwo = JSON.stringify(req.messages).includes("stage two");
    const n = isStageTwo ? 2 : 1;
    call++;
    if (call % 2 === 1) {
      const content = `stage${n}`;
      const hash = createHash("sha256").update(content).digest("hex");
      yield { type: "content", sha256: hash, base64: Buffer.from(content).toString("base64") } as never;
      yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: `src/marker${n}.txt`, contentRef: hash } }, meta: { rationale: `marker ${n}`, citations: [] } } as never;
    }
    yield { type: "text-delta", text: "stage done" } as never;
  },
} as unknown as ModelFn;
const engine = new Engine({ dataDir, workspaceRoot: ws, modelFn: model });
const h = engine.openHandle(missionId);
const r1 = await engine.executeMission(h);
console.log("closure:", r1.closure);
for (const rec of h.store.read()) console.log(rec.seq, rec.kind, JSON.stringify(rec.body).slice(0, 120));
h.store.close();
rmSync(ws, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
