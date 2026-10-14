# Verification Report — next-phase 2026-10-14

All results below were produced **after** the last source edit of this phase. Raw TAP files are kept in `%TEMP%` (paths listed); key numbers are reproduced here.

## Commands and results

| # | Command | Result |
|---|---------|--------|
| 1 | `npm run typecheck` | exit 0 |
| 2 | `npm run lint` | `lint: PASS (effect seams confined…)` |
| 3 | `npm run build` | exit 0 |
| 4 | `node --import tsx --test "test/**/*.test.ts"` (full suite) | **463/463 pass, 0 fail** (`%TEMP%\phase-suite.tap`) — baseline was 453; +4 pack-admission, +6 session-lifecycle |
| 5 | `node --test "test/packs/packs-admission.test.ts"` — **REGRESSION (≤2 min)` | RED 4/4 (`%TEMP%\pack-red.tap`) |
| 6 | same file after fix + pre-existing packs suite | GREEN 8/8 (`%TEMP%\pack-green4.tap`) |
| 7 | `node --test "test/security/session-lifecycle.test.ts"` | 6/6 pass |
| 8 | `npm audit --omit=dev` | 0 vulnerabilities |
| 9 | `src/cli/session.ts` extraction + focused suites | typecheck 0; 14/14 pass (session 6, packs-admission 4, packs 4) |
| 10 | full suite after extraction (`%TEMP%\full-after-extract.tap`) | **463/463 pass, 0 fail**; lint PASS; build exit 0 |

## Red → green evidence (TDD)

## Red → green evidence (TDD)

- **RR-02:** adversarial tests written first; run showed `# tests 4 # pass 0 # fail 4` with the expected failure reasons (env sentinel leaked / cwd wrong; raw `ENOENT` instead of `PackError`; raw `SyntaxError` for corrupt registry; `ZodError` instead of `PackError`). After implementation: 4/4 pass, and the 4 pre-existing pack tests pass unchanged.
- **RR-06:** the underlying defect predates this phase and was observed live during the security audit (stale `session.json` after server exit; CLI attempting dead-port calls). The backup of the pre-change CLI (`backups/src_cli_cli.ts.orig`) plus the audit record constitute the RED evidence; the new tests pin the corrected contract (shape validation, stale clearing, live adoption, wrong-token rejection, idempotent cleanup).

## Limitations (explicit)
- SIGINT/SIGTERM cleanup in `serve` is implemented but **not exercised by an automated test** (signal handling in the test runner is platform-sensitive). It is small, reviewed code; manual verification is recommended at next interactive use. Recorded in `residual-risk-update.md`.
- The pack runtime is still **not wired into boot** (protocol skeleton by design); all pack evidence is library-level against the real `PackManager`/sidecar path.
- No real-model calls were made in this phase (authorization boundary); all end-to-end verification is deterministic/hermetic.

## Invariant check (no weakening)
- Authority sequence untouched: no edits to `src/gate/`, capability enforcement, ledger semantics, or model-router retry logic.
- The pack `enable()` contract (reviewed-hash equality + content-hash pinning) is unchanged; hardening only *adds* typed failures.
- Auth changes are behavior-preserving (same accept/reject outcomes; constant-time comparison only).
