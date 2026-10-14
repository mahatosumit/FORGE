# GATE B Verification — 2026-10-14

## Decisive run: 38525748956 (commit `5f6336c`)
https://github.com/mahatosumit/FORGE/actions/runs/38525748956

| OS | tests | pass | fail | skipped | GATE B |
|---|---|---|---|---|---|
| ubuntu | 465 | 461 | 0 | 4 (2×F-03 Windows-only + 2×physical-probe preconditions absent) | ✔ pass |
| mac | 465 | 463 | 0 | 2 (F-03 pair) | ✔ pass |
| windows | 465 | 463 | 0 | 2 (Docker pipe open + metadata answering on that runner) | ✔ pass |

## What this proves
- The enumerated whole-tree kill terminates the full parent→child→grandchild chain on Linux and macOS where the group-assumption kill demonstrably failed 4/4 times before. The same regression test that failed across runs 38517345801/38519250546/38519687136 now passes with byte-identical assertions (only the wait strategy and diagnostic messages changed around them).
- No collateral damage: 465/465 locally (Windows), lint PASS, typecheck exit 0, build exit 0; CI shows zero new failures and the designed skips fire exactly where preconditions are absent.
- The `/proc`+`ps` diagnostics stay in the test as permanent failure forensics (guarded, read-only, no behavior).

## Commands (all post-fix, exact)
- `npm run typecheck` → exit 0 · `npm run lint` → PASS · `npm run build` → exit 0
- `npm test` (local, Windows) → 465/465 pass, 0 fail, 0 skipped
- CI run 38525748956 → matrix above. Raw logs: `evidence/ci7-*.log`.

## Limitations (explicit)
- The `detached: true` → no-setsid mystery on CI Linux remains OPEN as a behavioral question (no longer load-bearing: the fix does not depend on grouping). A libuv/Node-behavior note is future work, not a risk.
- Snapshot-then-kill PID-recycle race: same class as any pid-based kill, documented in code; no evidence of occurrence.
- `killProcessTree` shares the new helper — covered by the multi-agent revoke suites (green locally and on CI), not by a dedicated new test.
