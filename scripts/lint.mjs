// lint.mjs — effect-boundary lint (MODULES.md M-1/M-3, DEPENDENCY-GRAPH.md).
// Effect seams are mechanically restricted to designated modules:
//   node:child_process / spawn / execFile / fork → src/environments/** (and pack sidecar supervision in src/packs/**)
//   fetch()                                      → src/capabilities/http.ts + src/model-router/** + src/api/** + src/cli/** (loopback api client)
//   node:http(s)                                 → src/model-router/** + src/api/**
//   node:sqlite                                  → src/ledger/projections.ts only
//   dynamic import()                             → nowhere (type-position type queries are allowed)
// The scan core is shared with test/architecture/effect-boundary.test.ts so
// `npm test` enforces the same boundary.
import { join } from "node:path";
import { runLint } from "./lint-core.mjs";

const violations = runLint(join(process.cwd(), "src"));
if (violations.length) {
  console.error("LINT FAIL:\n" + violations.join("\n"));
  process.exit(1);
}
console.log("lint: PASS (effect seams confined to designated modules; no dynamic imports; no forbidden deps)");
