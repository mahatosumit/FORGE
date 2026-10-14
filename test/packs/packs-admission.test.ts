// Pack admission hardening — adversarial tests (RR-02, phase 2026-10-14).
// Prove: sidecar environment isolation, deterministic cwd, spawn-failure
// rejection (no process crash), corrupt-registry typed error, key-safety.
// NO untrusted code executes: fixtures are minimal protocol-valid sidecars and
// malicious *content* is only ever fed to admission/registry paths.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PackManager, PackError } from "../../src/packs/packs.js";

const MANIFEST = {
  id: "echo.audit", version: "1.0.0", purpose: "audit fixture pack",
  environments: ["local"], proposalKind: "artifact",
  constraintsVocab: ["paths"], concurrency: "parallel", idempotent: true,
  riskClass: ["read"], provenance: { pack: "audit", hash: "0".repeat(64) },
};

// Sidecar: dumps its environment/cwd next to itself, then answers validly.
const PROBE_SIDECAR = `import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
writeFileSync(new URL('./probe-dump.json', import.meta.url), JSON.stringify({
  cwd: process.cwd(),
  sentinelLeaked: process.env.FORGE_AUDIT_SENTINEL === 'leak-me',
  pathPresent: typeof process.env.PATH === 'string',
}));
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    const bytes = new TextEncoder().encode('audit: ' + frame.id);
    const hash = createHash('sha256').update(bytes).digest('hex');
    process.stdout.write(JSON.stringify({ id: frame.id, ok: true, observation: { hash, bytes: bytes.byteLength, sourcePath: null } }) + '\\n');
    process.exit(0);
  }
});
`;

function makePack(mgrDir: string, manifest = MANIFEST, sidecar = PROBE_SIDECAR) {
  const dir = mkdtempSync(join(mgrDir, "pack-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "sidecar.mjs"), sidecar);
  return dir;
}

function reviewedHash(packDir: string, manifest: unknown = MANIFEST): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(JSON.stringify(manifest) + readFileSync(join(packDir, "sidecar.mjs"))).digest("hex");
}
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

function ctx() {
  return {
    workspaceRoot: ".", environment: {} as never, environmentKind: "local" as const,
    secrets: new Map(), capture: () => "c".repeat(64), artifactBytes: () => null,
    criterionResolver: () => null, signal: new AbortController().signal,
  };
}

test("RR-02: sidecar environment is isolated (no ambient secrets) and cwd is the pack dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pack-audit-"));
  process.env["FORGE_AUDIT_SENTINEL"] = "leak-me";
  try {
    const packDir = makePack(root);
    const mgr = new PackManager(join(root, "packs"));
    mgr.install(packDir);
    mgr.enable("echo.audit", reviewedHash(packDir));
    const impl = mgr.capabilityImpls(() => "c".repeat(64)).get("echo.audit")!;
    const res = await impl.run({ capability: "artifact", args: { op: "put", contentRef: "a".repeat(64) } } as never, ctx() as never, { timeoutMs: 20_000, signal: new AbortController().signal });
    assert.ok(res.observation);

    const dump = JSON.parse(readFileSync(join(packDir, "probe-dump.json"), "utf8")) as { cwd: string; sentinelLeaked: boolean; pathPresent: boolean };
    assert.equal(dump.sentinelLeaked, false, "sidecar must not inherit ambient secrets");
    assert.equal(dump.pathPresent, true, "PATH must be available for tooling");
    assert.equal(
      dump.cwd.toLowerCase(),
      packDir.toLowerCase(),
      `sidecar cwd must be its own pack directory, got ${dump.cwd}`,
    );
  } finally {
    delete process.env["FORGE_AUDIT_SENTINEL"];
    rmSync(root, { recursive: true, force: true });
  }
});

test("RR-02: a sidecar that disappears after enable fails with PackError (activation and spawn race)", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pack-audit-"));
  try {
    const packDir = makePack(root);
    const mgr = new PackManager(join(root, "packs"));
    mgr.install(packDir);
    mgr.enable("echo.audit", reviewedHash(packDir));

    // (a) entry missing at activation time → typed failure, no impl produced
    rmSync(join(packDir, "sidecar.mjs"));
    assert.throws(() => mgr.capabilityImpls(() => "c".repeat(64)), (e: unknown) => e instanceof PackError);

    // (b) entry vanishes between activation and dispatch → spawn fault is a
    // typed PackError, never an uncaught 'error' event.
    const packDir2 = makePack(root);
    writeFileSync(join(packDir2, "manifest.json"), JSON.stringify({ ...MANIFEST, id: "echo.audit2" }, null, 2));
    const mgr2 = new PackManager(join(root, "packs2"));
    mgr2.install(packDir2);
    const hash2 = (() => { const { createHash } = require("node:crypto"); return createHash("sha256").update(JSON.stringify({ ...MANIFEST, id: "echo.audit2" }) + readFileSync(join(packDir2, "sidecar.mjs"))).digest("hex"); })();
    mgr2.enable("echo.audit2", hash2);
    const impl = mgr2.capabilityImpls(() => "c".repeat(64)).get("echo.audit2")!;
    rmSync(join(packDir2, "sidecar.mjs"));
    await assert.rejects(
      impl.run({ capability: "artifact", args: { op: "put", contentRef: "a".repeat(64) } } as never, ctx() as never, { timeoutMs: 5_000, signal: new AbortController().signal }),
      (e: unknown) => e instanceof PackError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RR-02: corrupt registry.json produces a typed PackError, not a raw parse error", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pack-audit-"));
  try {
    const packsDir = join(root, "packs");
    mkdirSync(packsDir, { recursive: true });
    writeFileSync(join(packsDir, "registry.json"), "{ definitely not json");
    assert.throws(() => new PackManager(packsDir), (e: unknown) => e instanceof PackError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RR-02: key-colliding pack ids are rejected or safely handled (no prototype surprises)", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-pack-audit-"));
  try {
    const mgr = new PackManager(join(root, "packs"));
    // "__proto__" is rejected by the schema; "constructor" is schema-valid but
    // must never resolve to an inherited member.
    const bad = makePack(root, { ...MANIFEST, id: "__proto__" });
    assert.throws(() => mgr.install(bad), PackError);
    assert.throws(() => mgr.enable("constructor", "whatever"), (e: unknown) => e instanceof PackError);
    assert.throws(() => mgr.enable("toString", "whatever"), (e: unknown) => e instanceof PackError);
    const proto = Object.getPrototypeOf(mgr["registry"].packs);
    assert.ok(proto === null || proto === Object.prototype, "registry map must not be polluted");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
