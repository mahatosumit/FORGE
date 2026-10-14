# GATE B Mechanism and Fix — 2026-10-14

## Demonstrated facts (observed, not inferred)
1. Pre-abort `ps` (ubuntu run 6): parent.js pid 2663 has **pgid 2113** (launcher's group), not 2663. child.js (2670) and grandchild.js (2677) share pgid 2113. Same shape on mac (pgid 965 ≠ pid 2326). → `detached: true` did NOT produce group leadership on CI Linux/mac runners.
2. Post-abort `ps`: child.js reparented to PPID 1, state S, matching cmdline, alive ~8 s after kill; grandchild also alive (PPID 2670).
3. Kill target used: `-2663` (group). A group containing no processes → ESRCH → silently caught → fallback killed ONLY the direct child (parent.js dead ✓).
4. Consequence: middle + grandchild orphaned, alive indefinitely. Deterministic across 4 POSIX runs; Windows green via `taskkill /T` (enumeration-based, group-independent).

## Demonstrated mechanism
**Group-only kill + direct-only fallback assumes group leadership that does not hold.** The kill path never enumerated the subtree, so any deviation from the assumed grouping (whatever its underlying cause — still open: Node/libuv `detached` interaction under this exact option set) orphans descendants. The `setsid` question is documented as open but is NO LONGER load-bearing for the fix.

## Fix (this phase, minimal)
- New total helper `killTreePosix(rootPid)` in `src/environments/local.ts`: snapshot via `ps -eo pid,ppid` (bounded, guarded) → SIGKILL leaves-up → group sweep → root sweep. Never throws. Constant command string (no injection); PID-recycle race class unchanged from pid-based killing (noted residual).
- `local.ts` `onAbort` POSIX branch: group-attempt/direct-fallback replaced by `killTreePosix(pid)` (same outer guard retained).
- `process-tree.ts` `killProcessTree` POSIX branch: same helper (identical defect class in the revoke path; helper semantics proven by GATE B itself; full suite guards regressions).
- Untouched: Windows branch, container path, timeout logic, all assertions (GATE B test asserts death exactly as before — it fails on old code across 4 CI runs and must pass on this code).

## What this does NOT claim
- Why `detached: true` yielded no setsid on CI runners (open question, logged for a libuv/Node-behavior note; irrelevant to correctness of the fix).
- Long-run soak behavior of repeated tree kills (bounded by test scope).
