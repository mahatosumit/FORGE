# RR-08 Implementation Report — 2026-10-14

Scope: browser lane + CI wiring only. No `src/` product changes (lane is a consumer of the public API/console, like a user).

## Changes (exact files)
1. **`scripts/e2e-ci.mts` (new, ~200 lines):** hermetic lane. Spawns its own `ForgeApi` (mock model, temp dirs, ephemeral port) — zero credentials (lane scrubs `*_API_KEY` from its env), zero network, zero user-state dependence. Bounded condition polls replace all fixed sleeps; try/finally teardown (browser + server + temp dirs); run-scoped artifacts + `results.json`; exit code reflects result. Preserved checks from the interactive lane (boot errors, board, badge, detail, 4 tabs, UI submit, recovery modal, final sweep) with two deliberate corrections: the board-increment assertion is real (the old lane had `|| true`), and the model-badge assertion is env-independent (non-empty, not kimi-k3).
2. **`package.json` / `package-lock.json`:** new devDependency `playwright@1.62.1` (matches `playwright-core@1.62.1`; dev-only — `files` allowlist unchanged, never shipped).
3. **`.github/workflows/ci.yml`:** new `browser` job (ubuntu-only: documented cost decision). Pinned actions only (`checkout` + `setup-node` existing SHAs; `upload-artifact@b4b15b8c...` `# v4.4.3`, SHA verified live against the GitHub API after catching an invented value before commit). Steps: `npm ci`, `npx playwright install --with-deps chromium`, `npm run test:e2e` (15 min step timeout), artifact upload on failure only (7-day retention).
4. **`.gitignore`:** `e2e-artifacts/` (run-scoped lane output never committed).
5. **`audit/.../rr-08/tools/check-workflow.mjs`:** generalized structural checker (RR-09's frozen checker untouched — reverted an accidental edit the same turn). Covers N pinned actions + browser-job contract (hermetic properties asserted statically).

## Deliberately not changed
`src/` (zero product edits), matrix job, triggers, permissions, existing scripts (interactive `e2e-ui.mjs` kept for live use).
