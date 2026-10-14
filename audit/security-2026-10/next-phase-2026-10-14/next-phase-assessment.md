# Next-Phase Assessment — 2026-10-14

## Baseline verification (independent, this session)

| Check | Expected (audit report) | Actual | Verdict |
|---|---|---|---|
| typecheck | pass | exit 0 | ✓ |
| lint | pass | PASS (effect seams confined) | ✓ |
| build | pass | exit 0 | ✓ |
| full suite | 453/453 | **453/453, 0 fail** (`%TEMP%\baseline-suite.tap`) | ✓ |
| npm audit (prod) | 0 vulns | 0 vulnerabilities | ✓ |
| Audit fixes present in tree | F-01/02/03/04/05/06/07/08 | all confirmed by source grep (`realRoot`, `closure body altered`, `forbidden origin`, `frame-ancestors`, ULID guard, security test file) | ✓ |
| `timingSafeEqual` present | absent (RR-06 open) | absent | ✓ consistent |
| Git/worktree | "intentionally not Git-backed" | no `.git`; worktree = plain files | ✓ consistent |
| Prior audit evidence | 10 files in `audit/security-2026-10/` | present, untouched | ✓ |

**No material discrepancy with the report.** Proceeding.

## Scope selection (per directive priority order)

Order: 1) critical trust-boundary failures — none open; **2) session/auth lifecycle (RR-06) + extension admission (RR-02)**; 3) FS confinement/cross-platform (RR-12 — junction classes already fixed; POSIX symlink shares the canonicalization, live-tested only on Windows); 4) recovery/continuation + browser CI (RR-04/08); 5) CI supply chain + long-run (RR-09/05); 6) real-model cert (RR-10, authorization-gated).

**Selected phase: "Session lifecycle hardening + pack admission hardening" (RR-06 + RR-02).**

Why bounded here:
- RR-06 has a *reproduced-adjacent* defect visible in the shipped flow: every `forge run` leaves a stale `session.json` pointing at a dead port; subsequent CLI commands (`approve`, `recovery resume`, mission `stop` via server) attempt API calls against it and fail with raw connection errors instead of falling back to the local path. Fix is small, testable, and removes a trust-file lifecycle hazard (a token-bearing artifact that outlives its process).
- RR-02's runtime code contains concrete, source-verified defects independent of "not yet wired into boot": (a) sidecars spawn with the **full inherited process environment** (provider keys included), unlike every other exec seam which strips env to an allowlist; (b) `spawn` has **no `error` handler** — a missing/broken entry after enable produces an uncaught `error` event (process crash); (c) `registry.json` is `JSON.parse`d in the constructor with no validation (corrupt file → boot-time throw with no typed error); (d) pack ids are used as object keys without a prototype-key guard. Each is defect-class evidence; fixes are minimal and land with adversarial tests proving rejection *before* side effects (no untrusted code is executed on the host at any point in the tests).
- Every other candidate remains on the ranked matrix for the next phase; none regressed.

## Method constraints honored
- No user mission data touched; all fixtures in temp dirs. Pre-change copies in `backups/` of this phase dir. No secrets printed or persisted. No new dependencies. Untrusted sidecars never executed — adversarial fixtures are only used to prove *admission/runtime* rejection; the one executable fixture is the repository's own trusted example protocol shape.
