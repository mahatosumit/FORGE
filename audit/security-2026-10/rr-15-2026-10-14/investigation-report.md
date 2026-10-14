# RR-15 Investigation Report — 2026-10-14

## Scope
Six CI-only test failures from run 38517345801 (commit `c1ad52d`). Test-only fixes permitted; product-code changes forbidden without a demonstrated defect; no assertion weakening; 3-OS matrix preserved.

## Per-item diagnosis → fix → CI evidence

### 1. FREEZE-001 docker-unavailable (ubuntu) — TEST race, fixed, verified
- **Mechanism:** single `isAvailable()` snapshot (3 s `docker info` timeout, flaps under CI load) vs `execute()`'s own fresh check. Product re-verifies before acting (`container-provider.ts:89-92`) and has no local fallback — product correct.
- **Fix (test-only):** stabilize on two consecutive identical readings before branching; both branches keep strict assertions (`test/execution/sandbox-escapes.test.ts`).
- **Evidence:** passes run 4 (38519250546) and run 5 (38519687136) on ubuntu.

### 2. P2B-E02 docker.sock probe (ubuntu) — TEST precondition absent, fixed, verified
- **Mechanism:** runner exposes `/var/run/docker.sock`; local env is process-level (documented), so the child legitimately sees host fs. Mount-level assertions (parts 2-3) are hermetic.
- **Fix (test-only):** physical probe moved into a `{ skip }`-gated `t.test` subtest (skip names the absent precondition); policy parts unconditional. Follow-up fix in run 5 cycle: precondition extended to Windows named pipes after run 4 proved runner Docker state varies (`//./pipe/docker_engine` opened on that runner).
- **Evidence:** ubuntu skips the subtest with reason (run 4+5); Windows skips it on Docker runners, executes it on socket-free ones; mount assertions run everywhere.

### 3. P2B-E04 metadata probe (ubuntu, windows) — TEST precondition absent, fixed, verified
- **Mechanism:** Azure IMDS answers 169.254.169.254 on hosted runners. Gate-enforcement part is the real control (F-06 unit coverage) and runs unconditionally.
- **Fix (test-only):** same skip-gated subtest pattern with a 500 ms TCP precondition probe.
- **Evidence:** skips with reason on answering hosts (run 4+5 win/ubuntu logs show the `﹣` skip marker); executes where refused.

### 4. P2B-003 root mounts (ubuntu, mac) — TEST portability defect, fixed, verified
- **Mechanism:** `resolve("c:\\")` on POSIX yields `<cwd>/c:\`, an ordinary filename — the product is correct to accept it. The test's root list was Windows-centric.
- **Fix (test-only):** platform-conditional roots (`win32` keeps all four; POSIX asserts `/`).
- **Evidence:** passes run 4+5 on ubuntu/mac.

### 5. RR-02 sidecar cwd (mac) — TEST comparison bug, fixed, verified
- **Mechanism:** unresolved `$TMPDIR` (`/var/...`) vs resolved `process.cwd()` (`/private/var/...`).
- **Fix (test-only):** compare canonical `realpathSync` both sides.
- **Evidence:** passes run 5 on mac (and everywhere else).

### 6. GATE B process-tree termination (ubuntu, mac) — DEMONSTRATED PRODUCT DEFECT, escalated
- **Data points (deterministic, 4/4 POSIX runs):** runs 2+3 (500 ms wait, middle alive), runs 4+5 (bounded ~8 s poll, middle STILL alive; durations 8347/8280/8233/8364 ms).
- **Ruled out by the Linux `/proc` diagnostic added in run 4 cycle:** state=**S** (not zombie Z), cmdline=`.../node/24.21.0/.../node /tmp/forge-gates-ws-*/child.js` (exact match — not PID reuse), 8 s post group-SIGKILL (not timing). Text: `Child PID must be terminated [state=S comm=MainThread cmdline=...child.js]`.
- **Standing fact:** parent dead + grandchild dead + middle child (S-state, matching cmdline) alive minutes-scale after `process.kill(-pgid, SIGKILL)`. Mechanism undetermined (wrong-scope kill vs pid-file crossing vs reparenting subtlety) — requires interactive Linux debugging (pgid inspection, strace of the kill path).
- **NOT fixed here** (would require product-code change without a verified mechanism — forbidden by phase rules). Next bounded phase proposed below.

## CI evidence across the phase
| Run | Commit | ubuntu | windows | mac | Note |
|---|---|---|---|---|---|
| 38517345801 | `c1ad52d` | 456/5 | 462/1 | 458/3 | baseline: 6 distinct failures |
| 38519250546 | `a017e90` | 460/1 | 462/2* | 462/1 | 5 fixes land; *E02-pipe gap found on win |
| 38519687136 | `407e107` | 460/1 | **465/0 green** | 462/1 | only GATE B remains, all OSes |

(*windows run-4 fail-2 = subtest + parent double-count of the single E02 cause.)
Raw logs: `evidence/ci-*.log` (runs 4+5) alongside the run-2 logs in the RR-09 phase dir.

## What was NOT changed
No `src/` edits in this phase (verify: `git diff --stat` across the three RR-15 commits shows test files only). No assertion weakened: every fixed test still executes its full probe locally (Windows dev host: 0 skips in the focused runs) and on socket-free/refusing CI hosts. GATE B assertions byte-identical apart from the patient wait + diagnostic message.
