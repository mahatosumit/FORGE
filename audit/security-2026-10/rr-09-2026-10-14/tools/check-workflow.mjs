// RR-09 local structural check for ci.yml (NOT a substitute for a real Actions run).
// Asserts: required top-level keys, permissions block value, every `uses:` is a
// full 40-hex SHA with a version comment, triggers unchanged, steps unchanged.
import { readFileSync } from "node:fs";
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fails.push(msg); };

ok(/^name: ci/m.test(yml), "name: ci present");
ok(/^\s{0,2}permissions:\s*$/m.test(yml) && /contents: read/.test(yml), "top-level permissions: contents: read");
ok(/on:\s*\n\s+push:\s*\n\s+pull_request:/.test(yml), "triggers push + pull_request unchanged");
const uses = [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
ok(uses.length === 2, `exactly 2 third-party uses (got ${uses.length})`);
for (const u of uses) {
  const [repo, ref] = u.split("@");
  ok(/^[0-9a-f]{40}$/.test(ref ?? ""), `${repo} pinned to full 40-hex SHA`);
}
const comments = [...yml.matchAll(/# (v[\d.]+)/g)].map((m) => m[1]);
ok(comments.length === 2 && comments.every((c) => c === "v4.4.0"), "both pins carry # v4.4.0 comments");
for (const step of ["npm ci", "npm run typecheck", "npm run lint", "npm test"]) {
  ok(yml.includes(`- run: ${step}`), `step preserved: ${step}`);
}
ok(!/pull_request_target/.test(yml), "no pull_request_target trigger");
if (fails.length) { console.error(`\n${fails.length} CHECK(S) FAILED`); process.exit(1); }
console.log("\nstructural check: all pass (local only — real GitHub Actions run unverified)");
