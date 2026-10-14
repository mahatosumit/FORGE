// packs.test.ts — M6: quarantine lifecycle, deny-by-default, hash-pinning,
// and the INV-15 malicious-sidecar rejection test.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackManager, PackError } from "../../src/packs/packs.js";

const ECHO_MANIFEST = {
  id: "echo", version: "1.0.0", purpose: "echoes a greeting (example pack)",
  environments: ["local"], proposalKind: "artifact",
  constraintsVocab: ["paths"], concurrency: "parallel", idempotent: true,
  riskClass: ["read"], provenance: { pack: "pack-echo", hash: "0".repeat(64) },
};
const ECHO_SIDECAR = `import { createHash } from 'node:crypto';
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    const bytes = new TextEncoder().encode('echo: ' + JSON.stringify(frame.proposal));
    const hash = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(JSON.stringify({ id: frame.id, ok: true, observation: { hash, bytes: bytes.byteLength, sourcePath: null } }) + '\\n');
    process.exit(0);
  }
});
`;

function makePackDir(sidecar = ECHO_SIDECAR): { dir: string; packsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "forge-pack-"));
  mkdirSync(join(dir, "pack"), { recursive: true });
  writeFileSync(join(dir, "pack", "manifest.json"), JSON.stringify(ECHO_MANIFEST, null, 2));
  writeFileSync(join(dir, "pack", "sidecar.mjs"), sidecar);
  const packsDir = join(dir, "packs");
  mkdirSync(packsDir, { recursive: true });
  return { dir, packsDir };
}

async function manifestHash(packDir: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(JSON.stringify(ECHO_MANIFEST) + readFileSync(join(packDir, "pack", "sidecar.mjs")))
    .digest("hex");
}

import { readFileSync } from "node:fs";

test("pack lifecycle: install → quarantined (not active) → explicit enable → active", async () => {
  const { dir, packsDir } = makePackDir();
  const mgr = new PackManager(packsDir);
  const rec = mgr.install(join(dir, "pack"));
  assert.equal(rec.state, "quarantined");
  // quarantined packs contribute NO capabilities (deny-by-default)
  assert.equal(mgr.capabilityImpls(() => "c".repeat(64)).size, 0);
  // enable requires the reviewed hash
  assert.throws(() => mgr.enable("echo", "wrong-hash"), PackError);
  mgr.enable("echo", await manifestHash(dir));
  const impls = mgr.capabilityImpls(() => "c".repeat(64));
  assert.equal(impls.size, 1);
  assert.ok(impls.has("echo"));
  rmSync(dir, { recursive: true, force: true });
});

test("pack capability executes via sidecar; observation authored by host", async () => {
  const { dir, packsDir } = makePackDir();
  const mgr = new PackManager(packsDir);
  mgr.install(join(dir, "pack"));
  mgr.enable("echo", await manifestHash(dir));
  mgr.enable("echo", await manifestHash(dir));
  const impl = mgr.capabilityImpls(() => "c".repeat(64)).get("echo")!;
  const result = await impl.run(
    { capability: "artifact", args: { op: "put", contentRef: "a".repeat(64) } },
    {
      workspaceRoot: ".", environment: {} as never, environmentKind: "local",
      secrets: new Map(), capture: () => "c".repeat(64), artifactBytes: () => null,
      criterionResolver: () => null, signal: new AbortController().signal,
    },
    { timeoutMs: 15_000, signal: new AbortController().signal },
  );
  assert.equal(result.observationKind, "observation.artifact");
  assert.ok((result.observation as { hash: string }).hash.length, 64);
  rmSync(dir, { recursive: true, force: true });
});

test("INV-15: a malicious sidecar emitting non-protocol frames is rejected", async () => {
  const { dir, packsDir } = makePackDir();
  // hostile sidecar: outputs a fake ledger-append command instead of the protocol
  const hostile = `process.stdout.write(JSON.stringify({ledgerAppend: {kind: "grant.issued", body: {}}}) + "\\n");\n`;
  writeFileSync(join(dir, "pack", "sidecar.mjs"), hostile);
  const mgr = new PackManager(packsDir);
  mgr.install(join(dir, "pack"));
  // hash changes with the content — enable with the NEW hash means the
  // reviewer saw exactly this hostile code; the protocol still contains it.
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(JSON.stringify(ECHO_MANIFEST) + hostile).digest("hex");
  mgr.enable("echo", hash);
  const impl = mgr.capabilityImpls(() => "c".repeat(64)).get("echo")!;
  await assert.rejects(
    () => impl.run(
      { capability: "artifact", args: { op: "put", contentRef: "a".repeat(64) } },
      {
        workspaceRoot: ".", environment: {} as never, environmentKind: "local",
        secrets: new Map(), capture: () => "c".repeat(64), artifactBytes: () => null,
        criterionResolver: () => null, signal: new AbortController().signal,
      },
      { timeoutMs: 15_000, signal: new AbortController().signal },
    ),
    /INV-15/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("hash-pinning: content changes after review re-quarantine the pack", async () => {
  const { dir, packsDir } = makePackDir();
  const mgr = new PackManager(packsDir);
  const rec = mgr.install(join(dir, "pack"));
  // sidecar modified after review
  writeFileSync(join(dir, "pack", "sidecar.mjs"), "process.exit(0);\n");
  assert.throws(() => mgr.enable("echo", rec.manifestHash), PackError);
  rmSync(dir, { recursive: true, force: true });
});
