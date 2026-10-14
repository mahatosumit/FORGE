# RR-15 Baseline — 2026-10-14 (recorded BEFORE any fix)

## Evidence in hand (no new claims)
CI run 38517345801 (commit `c1ad52d`): https://github.com/mahatosumit/FORGE/actions/runs/38517345801
Raw logs preserved in `../rr-09-2026-10-14/evidence/ci-{ubuntu,win,mac}.log`.

## Exact per-OS map
| OS | tests | pass | fail | skipped | Failing (exact names) |
|---|---|---|---|---|---|
| ubuntu | 463 | 456 | 5 | 2 | GATE B process-tree termination; FREEZE-001 docker-unavailable; P2B-E02 docker.sock; P2B-E04 metadata-refused; P2B-003 root mounts |
| windows | 463 | 462 | 1 | 0 | P2B-E04 metadata-refused |
| mac | 463 | 458 | 3 | 2 | GATE B process-tree; P2B-003 root mounts; RR-02 sidecar cwd |
| local dev (Windows) | 463 | 463 | 0 | 0 | — |

Skip-count explanation: the 2 skips on ubuntu/mac are the F-03 Windows-only junction/alias tests (`{ skip: process.platform !== "win32" }` in `test/security/audit-2026-10-regressions.test.ts:123,149`). Windows runs all 463. Counts reconcile exactly (pass+fail+skipped = 463 everywhere).

## Characterization (read-only diagnosis, code paths cited)
1. **FREEZE-001** — TEST race: single `isAvailable()` snapshot (3 s `docker info` timeout, flaps under CI load) vs `execute()`'s own fresh check. Product re-verifies before acting (container-provider.ts:89-92) and has no local fallback (lines 134-168 go straight to `driver.run`). Fix: stabilize the reading in-test; no product change.
2. **P2B-E02** — TEST precondition absent: runner exposes `/var/run/docker.sock`; local env is process-level (documented), so the child legitimately sees host fs. Mount-level assertions (parts 2-3) are hermetic and stay unconditional. Fix: scope the physical probe as a skippable subtest.
3. **P2B-E04** — TEST precondition absent: Azure IMDS answers 169.254.169.254 on hosted runners. Gate-enforcement part stays unconditional (F-06 covers matching). Fix: same subtest-skip pattern.
4. **P2B-003** — TEST portability defect: `resolve("c:\\")` on POSIX yields `<cwd>/c:\`, an ordinary filename, not a root — the product is correct to accept it. Fix: platform-conditional root list (test-only).
5. **RR-02 cwd** — TEST comparison bug: unresolved `$TMPDIR` vs resolved `process.cwd()` through the `/var→/private/var` symlink. Fix: compare canonical realpaths (test-only).
6. **GATE B** — UNDETERMINED (PID-reuse vs zombie-window vs genuine kill gap; parent+grandchild dead, middle alive). No fix without a Linux repro. Stays open explicitly.

## Fix plan (test-only for 1-5; no src changes; no assertion weakening)
- `test/execution/sandbox-escapes.test.ts`: stabilize daemon reading (consecutive-identical poll), keep both branches' strict assertions.
- `test/multi-agent/phase2b-runtime-escape.test.ts`: P2B-E02/E04 physical probes become `{ skip }`-gated `t.test` subtests; policy parts unconditional.
- `test/multi-agent/phase2b.test.ts`: platform-conditional roots.
- `test/packs/packs-admission.test.ts`: realpath comparison.
- Local gate (typecheck/lint/build/full suite) → commit → push → watch CI → record. GATE B carried forward on evidence.
