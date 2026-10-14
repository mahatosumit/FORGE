// RR-08 local structural check for ci.yml (NOT a substitute for a real Actions run).
// Supersedes the RR-09 checker (frozen): generalizes to N pinned actions and
// covers the browser job. Asserts: top-level keys, permissions value, every
// `uses:` is a full 40-hex SHA with a # vX.Y.Z comment, triggers unchanged,
// base steps unchanged, browser job present with hermetic properties.
import { readFileSync } from "node:fs";
const yml = readFileSync(".github/workflows/ci.yml", "utf8");
const fails = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fails.push(msg); };

ok(/^name: ci/m.test(yml), "name: ci present");
ok(/^\s{0,2}permissions:\s*$/m.test(yml) && /contents: read/.test(yml), "top-level permissions: contents: read");
ok(/on:\s*\n\s+push:\s*\n\s+pull_request:/.test(yml), "triggers push + pull_request unchanged");
const uses = [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
ok(uses.length >= 2, `third-party uses present (got ${uses.length})`);
for (const u of uses) {
  const [repo, ref] = u.split("@");
  ok(/^[0-9a-f]{40}$/.test(ref ?? ""), `${repo} pinned to full 40-hex SHA`);
}
const usesLines = yml.split("\n").filter((l) => l.includes("uses:"));
ok(usesLines.every((l) => /# v\d+\.\d+\.\d+/.test(l)), "every pin carries a # vX.Y.Z comment");
for (const step of ["npm ci", "npm run typecheck", "npm run lint", "npm test"]) {
  ok(yml.includes(`- run: ${step}`), `base step preserved: ${step}`);
}
ok(!/pull_request_target/.test(yml), "no pull_request_target trigger");
// Browser job contract (hermetic, least-cost):
ok(/^\s{2}browser:/m.test(yml), "browser job present");
ok(/runs-on: ubuntu-latest/.test(yml.split("browser:")[1] ?? ""), "browser job ubuntu-only (cost decision)");
ok(/playwright install --with-deps chromium/.test(yml), "bundled-chromium provisioning step present");
ok(/npm run test:e2e/.test(yml), "browser job runs npm run test:e2e");
ok(/upload-artifact@/.test(yml) && /if: failure\(\)/.test(yml), "artifact upload on failure only");
if (fails.length) { console.error(`\n${fails.length} CHECK(S) FAILED`); process.exit(1); }
console.log("\nstructural check: all pass (local only — real GitHub Actions run unverified)");
