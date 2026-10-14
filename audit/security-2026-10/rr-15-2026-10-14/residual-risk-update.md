# RR-15 Residual-Risk Update — 2026-10-14

## RR-15 status: CLOSED for test-portability scope, with one escalation
Five of six items are fixed and CI-verified on all three OSes (evidence: `investigation-report.md`, runs 38519250546 + 38519687136, raw logs in `evidence/`). The sixth item is no longer a portability question:

## Escalated: Linux process-tree survival defect (from GATE B) — OPEN, next phase
- **Demonstrated (not suspected):** middle child in S-state with matching cmdline, alive ~8 s after group SIGKILL, deterministic across 4 POSIX CI runs; zombie/reuse/timing ruled out by `/proc` evidence.
- **Not yet known:** kill-path mechanism (wrong-scope delivery vs pid bookkeeping vs reparenting). Product-code fix is forbidden until a Linux repro identifies it.
- **Proposed next bounded phase:** Linux kill-path investigation — instrument pgid membership at spawn/abort time (test-only logging first), reproduce with `ps -o pid,pgid,stat`, then fix `killProcessTree`/exec-abort accordingly with a regression that fails on the current code. Requires a Linux environment (CI iteration or container); do NOT attempt blind from Windows.
- **Security relevance:** bounded — the abort path is fail-closed at the ledger level (post-effect-unknown protocol) and the surviving process is sandboxed-profile code, but an unkilled child outliving mission abort violates the termination guarantee and must be treated as a real defect, not a flake.

## Windows fully green
Run 38519687136: windows-latest 465/465 pass, 0 fail, 0 skipped. The 3-OS matrix is preserved; no control was weakened to get here (skip paths name their absent preconditions and execute fully wherever preconditions hold).
