// F-03 reproduction: workspace confinement escapes via directory junction.
// Disposable fixtures only; creates a REAL Windows junction (mklink /J, no admin).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { LocalEnvironment } from "../../../src/environments/local.js";
import { evaluateProposal } from "../../../src/gate/gate.js";
import type { WorkspacePath } from "../../../src/contracts/base.js";

const ws = mkdtempSync(join(tmpdir(), "forge-audit-ws-"));
const outside = mkdtempSync(join(tmpdir(), "forge-audit-outside-"));
const results: string[] = [];
const check = (name: string, escaped: boolean, detail = "") => {
  results.push(`${escaped ? "ESCAPED" : "blocked"}  ${name}${detail ? "  — " + detail : ""}`);
};

// Fixture: workspace/sub -> junction to outside
mkdirSync(join(ws, "sub"), { recursive: true });
execSync(`cmd /c rmdir "${join(ws, "sub")}"`, { stdio: "ignore" });
execSync(`cmd /c mklink /J "${join(ws, "sub")}" "${outside}"`, { stdio: "ignore" });
writeFileSync(join(outside, "readme-outside.txt"), "OUTSIDE-ORIGINAL");

const env = new LocalEnvironment(ws);
const P = (s: string) => s as WorkspacePath;

// 1. READ through junction (lexical absolute allows; readFile has no realpath)
try {
  const bytes = env.readFile(P("sub/readme-outside.txt"));
  check("readFile through dir-junction", bytes.toString().includes("OUTSIDE-ORIGINAL"), bytes.length + " bytes from OUTSIDE");
} catch (e) {
  check("readFile through dir-junction", false, String((e as Error).message).slice(0, 80));
}

// 2. WRITE (new file) through junction — full chain: gate allows, putFile escapes
const outsideTarget = join(outside, "pwned.txt");
const gateVerdict = evaluateProposal(
  { capability: "fs", args: { op: "write", path: "sub/pwned.txt", contentRef: "0".repeat(64) } } as never,
  { rationale: "audit", citations: [] },
  { grants: [{ id: "grt_a1", missionId: "mis_a1", capability: "fs", constraints: { paths: ["**"] }, expiresAt: null, issuer: "envelope", parentGrantId: null }] as never, resolvePath: { resolveReal: (p) => env.resolveReal(p) } },
);
try {
  env.putFile(P("sub/pwned.txt"), Buffer.from("ESCAPED-WRITE"));
  const landed = existsSync(outsideTarget);
  check("putFile through dir-junction", landed, `gate=${gateVerdict.type} fileOutside=${landed}`);
} catch (e) {
  check("putFile through dir-junction", false, String((e as Error).message).slice(0, 80));
}

// 3. exec cwd through junction
try {
  const r = await env.exec({ argv: ["node", "-e", "require('fs').writeFileSync('cwd-escaped.txt','x')"] as never, cwd: P("sub"), timeoutMs: 30_000, env: new Map(), signal: new AbortController().signal, isolationProfile: "host" });
  check("exec cwd through dir-junction", existsSync(join(outside, "cwd-escaped.txt")), `exit=${r.exit}`);
} catch (e) {
  check("exec cwd through dir-junction", false, String((e as Error).message).slice(0, 80));
}

// 4. control cases that must stay blocked
for (const [name, p] of [["../ traversal", "../x.txt"], ["absolute win", "C:\\Windows\\Temp\\x"],
  ["drive-relative", "C:evil.txt"], ["UNC", "\\\\server\\share\\x"], ["ADS", "ads.txt:stream"],
  ["trailing dot", "weird."], ["trailing space", "weird "], ["tilde", "~x"], ["percent", "%2e%2e%2fx"]] as Array<[string, string]>) {
  try {
    env.putFile(P(p), Buffer.from("x"));
    check(`control: ${name}`, true, "write accepted (path=" + p + ")");
  } catch (e) {
    check(`control: ${name}`, false, String((e as Error).message).slice(0, 60));
  }
}

console.log(results.join("\n"));
console.log("\nWINDOWS dir-junction escape reproduced:", existsSync(outsideTarget) ? "YES" : "NO");
try { rmSync(ws, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } catch {}
