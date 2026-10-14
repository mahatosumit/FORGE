# RR-08 Baseline — 2026-10-14 (recorded BEFORE any change)

## Starting state
- HEAD: `4430ad5`, tree clean. Full suite 463/463; CI matrix green (run 38525748956).
- No `test:e2e` script; no `playwright` package (only `playwright-core@1.62.1` via quack tree + hardcoded Edge path).
- Existing lane `scripts/e2e-ui.mjs` (101 lines): requires live `serve` + real model + user state; hardcoded `D:/quack pro/...` paths; fixed sleeps; tautological assertion (line 55: `... || true`); no try/finally; overwrites `ui-*.png`; kimi-k3 badge assertion (user-env-specific).
- `playwright-readiness.md` (prior phase): local-manual ready, not CI-ready (browser install, server readiness, teardown, hermetic stub, de-hardcoded paths outstanding).

## Gaps this phase closes (acceptance)
1. Hermetic lane `scripts/e2e-ci.mjs`: spawns its own `ForgeApi` (mock model, temp dirs, ephemeral port) — zero creds, zero network, zero user-state dependence.
2. Deterministic sync: every fixed sleep replaced by bounded wait-for-condition; try/finally teardown (browser + server + temp dirs).
3. Real assertions only: UI-submit must increment the board count (tautology removed); badge/model checks env-independent.
4. Configurable paths/browser via env (`BROWSER_EXECUTABLE_PATH`, `E2E_ARTIFACTS_DIR`); run-scoped artifacts + JSON summary; exit code reflects result.
5. CI `browser` job (ubuntu-only: cost decision, documented): pinned actions, `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e`. Requires new devDependency `playwright@1.62.1` (matches core; dev-only, never shipped — `files` allowlist unchanged).
6. Deliberate-failure proof: sabotage commit → red CI → revert → green CI, all recorded.

## Out of scope
Pack-boot, model-cert, RR-04/12 leftovers. No `src/` product changes expected (lane + CI + devDep only); if the lane exposes a product defect, stop and queue it instead of expanding scope.
