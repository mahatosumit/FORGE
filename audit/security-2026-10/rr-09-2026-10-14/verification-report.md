# RR-09 Verification Report — 2026-10-14

## Commands and results (all post-change)

| # | Command | Result |
|---|---------|--------|
| 1 | Line diff `backups/ci.yml.orig` vs `.github/workflows/ci.yml` | 25→29 lines; only 4 added lines + 2 swapped `uses:` lines; all steps/triggers/matrix identical |
| 2 | `node audit/security-2026-10/rr-09-2026-10-14/tools/check-workflow.mjs` | 12/12 structural checks PASS (exit 0) |
| 3 | `npm run typecheck` | exit 0 |
| 4 | `npm run lint` | PASS |
| 5 | `npm run build` | exit 0 |
| 6 | `npm test` (full suite) | **463/463 pass, 0 fail** (`%TEMP%\rr09-suite.tap`, preserved in `evidence/`) |

## Local vs CI evidence (explicit)
- **Locally verified:** workflow file structure, SHA format + comments, trigger/step preservation, and that the pinned SHAs equal the live `v4`/`v4.4.0` commits.
- **NOT verified:** an actual GitHub Actions run. This workspace has no remote and no `.git`; no run was triggered. RR-09 must not be marked closed on local evidence alone — see `residual-risk-update.md`.

## Limitations
- No `actionlint` binary available locally; structural check is a purpose-written assertion script (`tools/check-workflow.mjs`), not a schema validator. It asserts presence/format/preservation, not full Actions semantics.
- SHA freshness decays: if upstream moves `v4`, the pins stay at v4.4.0 until a human re-verifies (by design — that is the point of pinning).
