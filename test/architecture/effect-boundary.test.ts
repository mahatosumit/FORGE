// effect-boundary.test.ts — F-08: the effect-boundary scan is part of npm
// test (previously only a lint script). Fails if forbidden imports, dynamic
// imports, or out-of-module effect seams are introduced anywhere in src/.
// Also proves the scan is not vacuous: it flags a seeded violation.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../../scripts/lint-core.mjs";

test("effect boundary: real src/ tree has zero violations", () => {
  const violations = runLint(join(process.cwd(), "src"));
  assert.deepEqual(violations, [], `effect-boundary violations: ${violations.join("; ")}`);
});

test("effect boundary: the scan catches a seeded child_process import outside environments/", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-scan-"));
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine", "evil.ts"), 'import { exec } from "node:child_process";\n');
  const violations = runLint(dir);
  assert.ok(violations.some((v) => v.includes("child_process")), "seeded violation must be flagged");
  rmSync(dir, { recursive: true, force: true });
});

test("effect boundary: the scan catches dynamic import()", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-scan2-"));
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine", "dyn.ts"), "const m = await import('./x.js');\n");
  const violations = runLint(dir);
  assert.ok(violations.some((v) => v.includes("dynamic import()")));
  rmSync(dir, { recursive: true, force: true });
});

test("effect boundary: type-position type queries are NOT dynamic imports", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-scan3-"));
  mkdirSync(join(dir, "gate"), { recursive: true });
  writeFileSync(join(dir, "gate", "types.ts"), "type Z = import('zod').z;\n");
  assert.deepEqual(runLint(dir), []);
  rmSync(dir, { recursive: true, force: true });
});
