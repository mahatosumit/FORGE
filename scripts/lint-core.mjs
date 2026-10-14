// lint-core.mjs — effect-boundary scan, shared by scripts/lint.mjs (CLI) and
// test/architecture/effect-boundary.test.ts (npm test enforcement, F-08).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const FORBIDDEN_IMPORTS = [
  "node:cluster", "node:dgram", "node:worker_threads",
  "openai", "anthropic", "@anthropic-ai", "@google", "drizzle",
  "pg", "mysql", "better-sqlite3", "axios", "undici", "ws", "effect",
];

const SEAM_RULES = [
  { re: /node:child_process/, allow: /^(environments\/|packs\/|mcp\/)/, why: "child_process" },
  { re: /\b(spawn|execFile|fork)\s*\(/, allow: /^(environments\/|packs\/|mcp\/)/, why: "process execution" }, // packs spawn ONLY their own sidecar, mcp spawns configured MCP servers
  { re: /\bfetch\s*\(/, allow: /^(capabilities\/(?:http|web|safe-http)\.ts|model-router\/|api\/|cli\/)/, why: "fetch()" }, // cli = loopback api client
  { re: /from ["']node:http2?["']|from ["']node:https["']/, allow: /^(capabilities\/(?:http|web|safe-http)\.ts|model-router\/|api\/)/, why: "node:http(s)" },
  { re: /node:sqlite/, allow: /^ledger\/projections\.ts$/, why: "node:sqlite" },
];

export function runLint(srcDir) {
  const violations = [];
  const rel = (f) => relative(srcDir, f).split(sep).join("/");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) checkFile(p);
    }
  };
  const checkFile = (file) => {
    const src = readFileSync(file, "utf8");
    const r = rel(file);
    for (const m of src.matchAll(/from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? m[2];
      for (const bad of FORBIDDEN_IMPORTS) {
        if (spec === bad || spec.startsWith(bad + "/")) {
          violations.push(`${r}: forbidden import "${spec}"`);
        }
      }
    }
    // type-position type queries (import("zod")) are not dynamic imports —
    // only those two exact module specifiers are exempt
    const cleaned = src.replace(/import\s*\(\s*["'](?:zod|node:sqlite)["']\s*\)/g, "TYPEQUERY");
    if (/\bimport\s*\(/.test(cleaned)) violations.push(`${r}: dynamic import()`);
    for (const rule of SEAM_RULES) {
      if (rule.re.test(cleaned) && !rule.allow.test(r)) {
        violations.push(`${r}: effect seam "${rule.why}" only allowed in ${rule.allow}`);
      }
    }
  };
  walk(srcDir);
  return violations;
}
