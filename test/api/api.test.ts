// api.test.ts — M5 DoD: auth enforcement; escalation round-trip through the
// API (mission pauses, user extends, mission continues); mission board data.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeApi } from "../../src/api/server.js";
import type { ModelEvent, ModelRequest } from "../../src/contracts/model.js";

function sha(b: Uint8Array) { return createHash("sha256").update(b).digest("hex"); }
import { createHash } from "node:crypto";

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "forge-ws-"));
  writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  writeFileSync(join(ws, "test.js"), 'const fs=require("fs");process.exit(fs.existsSync("notes/fix.md") && fs.readFileSync("notes/fix.md","utf8").includes("FIXED")?0:1);');
  mkdirSync(join(ws, "src"), { recursive: true });
  writeFileSync(join(ws, "src", "x.ts"), "old\n");
  return ws;
}

/** Model that requires an OUT-OF-GRANT fs write (docs/**) — forcing an
 *  escalation round-trip through the API — then finishes. */
function escalationModel(): ModelFn {
  const content = "FIXED\n";
  const contentHash = sha(new TextEncoder().encode(content));
  let call = 0;
  return {
    async *complete(_req: ModelRequest): AsyncGenerator<ModelEvent> {
      call++;
      if (call === 1) {
        yield { type: "content", sha256: contentHash, base64: Buffer.from("FIXED\n").toString("base64") };
        yield { type: "proposal", proposal: { capability: "fs", args: { op: "write", path: "notes/fix.md", contentRef: contentHash } }, meta: { rationale: "write a fix note outside the granted source scope", citations: [] } };
      } else {
        yield { type: "text-delta", text: "done" };
      }
    },
  } as unknown as ModelFn;
}

test("api: auth required; escalation round-trip extends authority and mission completes", async () => {
  const ws = makeWorkspace();
  const dataDir = mkdtempSync(join(tmpdir(), "forge-data-"));
  // stage the content the model will reference
  const contentHash = sha(new TextEncoder().encode("FIXED\n"));

  const api = new ForgeApi({ dataDir, workspaceRoot: ws, modelFn: escalationModel(), escalationTimeoutMs: 10_000 });
  await api.listen();

  // unauthenticated request rejected
  const noAuth = await fetch(`http://127.0.0.1:${api.port}/missions`);
  assert.equal(noAuth.status, 401);

  const headers = { authorization: `Bearer ${api.token}`, "content-type": "application/json" };

  // open the mission — it will hit the escalation and pause
  const res = await fetch(`http://127.0.0.1:${api.port}/missions`, { method: "POST", headers, body: JSON.stringify({ intent: "write a fix note" }) });
  assert.equal(res.status, 201);
  const { missionId } = (await res.json()) as { missionId: string };

  // wait for the pending escalation
  let pending: Array<{ requestId: string; capability: string }> = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const escRes = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}/escalations`, { headers });
    const data = (await escRes.json()) as { pending: Array<{ requestId: string; capability: string }> };
    if (i > 2) console.error("esc resp:", JSON.stringify(data).slice(0,200));
    if (data.pending && data.pending.length > 0) { pending = data.pending; break; }
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.capability, "fs");

  // user extends authority for THIS mission
  const decide = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}/escalations/${pending[0]!.requestId}`, {
    method: "POST", headers, body: JSON.stringify({ decision: "extend" }),
  });
  if (decide.status !== 200) console.error("decide body:", await decide.text());
  assert.equal(decide.status, 200);

  // the mission resumes and closes: the docs write was applied (real effect)
  let closure: string | null = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const st = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}`, { headers });
    const data = (await st.json()) as { status?: string };
    if (data.status === "closed") {
      const rec = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}/records`, { headers });
      const { records } = (await rec.json()) as { records: Array<{ kind: string; body: { closure?: string } }> };
      closure = records.find((r) => r.kind === "mission.closed")?.body.closure ?? null;
      break;
    }
  }
  if (closure !== "verified") { const rr = await fetch(`http://127.0.0.1:${api.port}/missions/${missionId}/records`, { headers }); const all=(await rr.json()).records; const idx=all.findIndex(r=>r.id==="X"); const vr=all.find(r=>r.kind==="observation.fs"); console.error("FS:", JSON.stringify(vr)); const wr=all.find(r=>r.kind==="grant.decided"); console.error("DECIDED:", JSON.stringify(wr)); console.error("AFTER:", JSON.stringify(all.slice(wr ? wr.seq : 0, (wr?wr.seq:0)+3).map(r=>[r.seq,r.kind,String(JSON.stringify(r.body)).slice(0,150)]))); }
  assert.equal(closure, "verified"); // criterion: notes/fix.md exists with FIXED
  // the real effect happened: file exists with the content
  assert.equal(readFileSync(join(ws, "notes", "fix.md"), "utf8"), "FIXED\n");

  api.close();
  rmSync(ws, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  void contentHash;
});

import { readFileSync } from "node:fs";
