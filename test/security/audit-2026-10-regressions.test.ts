// Security regression suite — independent audit 2026-10-13/14.
// Each test reproduces an audit finding against the PUBLIC behavior and pins
// the fix. Findings: F-01 host/origin gate, F-02 security headers,
// F-03 junction traversal, F-04 attached interpreter-eval flags,
// F-06 IPv6 host matching, F-07 false post-closure corruption alarm.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ForgeApi } from "../../src/api/server.js";
import { ConfigStore } from "../../src/config/store.js";
import { LocalEnvironment } from "../../src/environments/local.js";
import { evaluateProposal } from "../../src/gate/gate.js";
import { openMission, openMissionReadOnly } from "../../src/ledger/index.js";
import { newMissionId } from "../../src/grants/grants.js";
import { verifyChain } from "../../src/codec/hashChain.js";
import type { WorkspacePath } from "../../src/contracts/base.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Raw http request allowing a spoofed Host header (fetch forbids it). */
function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startAuditApi(): Promise<{ api: ForgeApi; token: string; port: number; dataDir: string; workspaceRoot: string; close: () => void }> {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-sec-data-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "forge-sec-ws-"));
  const forgeDir = mkdtempSync(join(tmpdir(), "forge-sec-forge-"));
  const configStore = new ConfigStore(forgeDir);
  const api = new ForgeApi({
    dataDir,
    workspaceRoot,
    modelFn: { async *complete() { yield { type: "text-delta" as const, text: "audit" }; } } as never,
    configStore,
    escalationTimeoutMs: 500,
    port: 0,
  });
  await api.listen();
  return {
    api,
    token: api.token,
    port: api.port,
    dataDir,
    workspaceRoot,
    close: () => {
      api.close();
      try { rmSync(dataDir, { recursive: true, force: true }); rmSync(workspaceRoot, { recursive: true, force: true }); rmSync(forgeDir, { recursive: true, force: true }); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// F-01 — DNS-rebinding / foreign-origin requests are rejected
// ---------------------------------------------------------------------------

test("F-01: spoofed Host header is rejected (403)", async () => {
  const { token, port, close } = await startAuditApi();
  try {
    const spoof = await rawRequest(port, "/missions", { host: "evil.example.com", authorization: `Bearer ${token}` });
    assert.equal(spoof.status, 403, `expected 403 for foreign Host, got ${spoof.status}`);
    const ok = await rawRequest(port, "/missions", { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
  } finally { close(); }
});

test("F-01: foreign Origin header is rejected (403); absent Origin allowed", async () => {
  const { token, port, close } = await startAuditApi();
  try {
    const foreign = await rawRequest(port, "/missions", { host: `127.0.0.1:${port}`, origin: "https://evil.example.com", authorization: `Bearer ${token}` });
    assert.equal(foreign.status, 403, `expected 403 for foreign Origin, got ${foreign.status}`);
    const same = await rawRequest(port, "/missions", { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, authorization: `Bearer ${token}` });
    assert.equal(same.status, 200);
    const none = await rawRequest(port, "/missions", { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` });
    assert.equal(none.status, 200);
  } finally { close(); }
});

test("F-01: unauthenticated and wrong-token requests still fail closed (401)", async () => {
  const { port, token, close } = await startAuditApi();
  try {
    assert.equal((await rawRequest(port, "/missions", { host: `127.0.0.1:${port}` })).status, 401);
    assert.equal((await rawRequest(port, "/missions", { host: `127.0.0.1:${port}`, authorization: "Bearer deadbeef" })).status, 401);
    assert.equal((await rawRequest(port, `/missions?token=${token}`, { host: `127.0.0.1:${port}` })).status, 401, "query token must only work on /events");
  } finally { close(); }
});

// ---------------------------------------------------------------------------
// F-02 — browser security headers on console + API
// ---------------------------------------------------------------------------

test("F-02: console response carries CSP, frame denial, nosniff; API carries nosniff", async () => {
  const { token, port, close } = await startAuditApi();
  try {
    const html = await rawRequest(port, "/", { host: `127.0.0.1:${port}` });
    assert.equal(html.status, 200);
    assert.match(String(html.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(html.headers["x-frame-options"], "DENY");
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    const api = await rawRequest(port, "/health", { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` });
    assert.equal(api.headers["x-content-type-options"], "nosniff");
    assert.equal(api.headers["cache-control"], "no-store");
  } finally { close(); }
});

// ---------------------------------------------------------------------------
// F-03 — directory junction must not redirect effects outside the workspace
// ---------------------------------------------------------------------------

test("F-03: read/write/exec through a directory junction are blocked", { skip: process.platform !== "win32" }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-sec-jws-"));
  const outside = mkdtempSync(join(tmpdir(), "forge-sec-jout-"));
  try {
    mkdirSync(join(ws, "sub"));
    execSync(`cmd /c rmdir "${join(ws, "sub")}"`, { stdio: "ignore" });
    execSync(`cmd /c mklink /J "${join(ws, "sub")}" "${outside}"`, { stdio: "ignore" });
    writeFileSync(join(outside, "outside.txt"), "SECRET-OUTSIDE");
    const env = new LocalEnvironment(ws);
    const P = (s: string) => s as WorkspacePath;

    assert.throws(() => env.readFile(P("sub/outside.txt")), /escapes the workspace/);
    assert.throws(() => env.putFile(P("sub/pwn.txt"), Buffer.from("x")), /escapes the workspace/);
    assert.equal(existsSync(join(outside, "pwn.txt")), false, "no file may land outside the workspace");
    assert.throws(
      () => env.exec({ argv: ["node", "-e", "0"] as never, cwd: P("sub"), timeoutMs: 5000, env: new Map(), signal: new AbortController().signal, isolationProfile: "host" }),
      /escapes the workspace/,
    );
    // Control: plain in-workspace file still works
    env.putFile(P("inside.txt"), Buffer.from("ok"));
    assert.equal(env.readFile(P("inside.txt")).toString(), "ok");
  } finally {
    try { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } catch {}
  }
});

test("F-03: Windows canonicalization aliases are rejected (ADS, trailing dot/space, drive-relative)", { skip: process.platform !== "win32" }, () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-sec-alias-"));
  try {
    const env = new LocalEnvironment(ws);
    const P = (s: string) => s as WorkspacePath;
    assert.throws(() => env.putFile(P("f.txt:stream"), Buffer.from("x")), /escapes the workspace/);
    assert.throws(() => env.putFile(P("alias."), Buffer.from("x")), /escapes the workspace/);
    assert.throws(() => env.putFile(P("alias "), Buffer.from("x")), /escapes the workspace/);
    assert.throws(() => env.putFile(P("C:relative.txt"), Buffer.from("x")), /escapes the workspace/);
  } finally { try { rmSync(ws, { recursive: true, force: true }); } catch {} }
});

// ---------------------------------------------------------------------------
// F-04 — attached interpreter-eval flag forms do not silently bypass R4
// ---------------------------------------------------------------------------

test("F-04: node -e<code> attached form does not match a bare argv-prefix grant", () => {
  const grant = { id: "grt_sec1", missionId: "mis_sec1", capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["node"] } }, expiresAt: null, issuer: "envelope", parentGrantId: null } as never;
  const verdict = evaluateProposal(
    { capability: "shell", args: { argv: ["node", "-eprintln(process.version)"], cwd: "." } } as never,
    { rationale: "audit", citations: [] },
    { grants: [grant] },
  );
  assert.notEqual(verdict.type, "allow", `attached -e form must not silently allow: ${JSON.stringify(verdict)}`);
});

test("F-04: bare npm test prefix still matches (no regression)", () => {
  const grant = { id: "grt_sec2", missionId: "mis_sec1", capability: "shell", constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } }, expiresAt: null, issuer: "envelope", parentGrantId: null } as never;
  const verdict = evaluateProposal(
    { capability: "shell", args: { argv: ["npm", "test", "--", "--grep", "x"], cwd: "." } } as never,
    { rationale: "audit", citations: [] },
    { grants: [grant] },
  );
  assert.equal(verdict.type, "allow");
});

// ---------------------------------------------------------------------------
// F-06 — IPv6 host patterns cannot cross-match other IPv6 hosts
// ---------------------------------------------------------------------------

test("F-06: IPv6 grant pattern does not match a different IPv6 host", () => {
  const grant = { id: "grt_sec3", missionId: "mis_sec1", capability: "web_fetch", constraints: { hosts: ["[::1]"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } as never;
  const verdict = evaluateProposal(
    { capability: "web_fetch", args: { url: "http://[2001:db8::beef]/x", extractMode: "text" } } as never,
    { rationale: "audit", citations: [] },
    { grants: [grant] },
  );
  assert.notEqual(verdict.type, "allow", `different IPv6 host must not match: ${JSON.stringify(verdict)}`);
});

test("F-06: suffix-confusion host (allowed.com.evil.com) does not match allowed.com", () => {
  const grant = { id: "grt_sec4", missionId: "mis_sec1", capability: "web_fetch", constraints: { hosts: ["api.example.com"] }, expiresAt: null, issuer: "envelope", parentGrantId: null } as never;
  const verdict = evaluateProposal(
    { capability: "web_fetch", args: { url: "http://api.example.com.evil.com/x", extractMode: "text" } } as never,
    { rationale: "audit", citations: [] },
    { grants: [grant] },
  );
  assert.notEqual(verdict.type, "allow");
});

// ---------------------------------------------------------------------------
// F-07 — continued missions are not misreported as corrupted; real tampering still fails
// ---------------------------------------------------------------------------

test("F-07: post-closure continuation opens cleanly; forged post-closure record still fails", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-sec-ledger-"));
  try {
    const missionId = newMissionId();
    const store = openMission({ dataDir, missionId });
    store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "t", goalSpec: { summary: "s", proposedCriteria: [] } } });
    const tip = store.ledger.current()!.hash;
    store.append({ kind: "mission.closed", author: "runtime", ts: new Date().toISOString(), body: { closure: "completed-unverified", receipt: { closure: "completed-unverified", weakestTier: "none", criteria: [], authorityManifest: [], changeManifest: [], costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 }, chainTip: tip } } });
    // Legitimate continuation (directive reopen), same open session:
    store.append({ kind: "mission.directive", author: "user", ts: new Date().toISOString(), body: { delivery: "steer", content: "continue" } });
    store.close();

    // Reopen: must NOT report corruption; chain must verify.
    const reopened = openMission({ dataDir, missionId });
    const records = reopened.read();
    assert.equal(verifyChain(records).ok, true);
    assert.equal(records.at(-1)!.kind, "mission.directive");
    reopened.close();

    // Tampering the closure body's anchor must still fail closed.
    const journal = join(dataDir, "missions", missionId, "journal.jsonl");
    const raw = readFileSync(journal, "utf8");
    const tampered = raw.replace(/"chainTip":"[0-9a-f]{64}"/, `"chainTip":"${"f".repeat(64)}"`);
    assert.notEqual(tampered, raw, "fixture must contain a chainTip to tamper");
    writeFileSync(journal, tampered);
    assert.throws(() => openMission({ dataDir, missionId }), /hash|corrupt|anchor/i);
  } finally { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} }
});
