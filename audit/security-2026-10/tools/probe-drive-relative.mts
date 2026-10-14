import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { LocalEnvironment } from "../../../src/environments/local.js";
import type { WorkspacePath } from "../../../src/contracts/base.js";

const ws = mkdtempSync(join(tmpdir(), "forge-audit-ws-"));
console.log("ws =", ws);
const abs = resolve(ws, "C:evil.txt");
const rel = relative(ws, abs);
console.log("path.resolve(ws,'C:evil.txt') =", abs);
console.log("path.relative =", rel, "| isAbsolute(rel) =", isAbsolute(rel), "| startsWith('..') =", rel.startsWith(".."));

const env = new LocalEnvironment(ws);
try {
  env.putFile("C:evil.txt" as WorkspacePath, Buffer.from("drive-relative-escape"));
  console.log("putFile ACCEPTED");
  // candidate locations
  const candidates = [
    "C:\\evil.txt",
    join(process.cwd(), "evil.txt"),
    join(ws, "C:evil.txt"),
    join(ws, "evil.txt"),
  ];
  for (const c of candidates) console.log(existsSync(c) ? "FOUND: " + c : "absent: " + c);
} catch (e) {
  console.log("putFile threw:", String((e as Error).message));
}
try { rmSync(ws, { recursive: true, force: true }); } catch {}
