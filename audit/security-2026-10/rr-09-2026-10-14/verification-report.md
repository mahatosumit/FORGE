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

## Real CI observation — run 38517345801 (commit `c1ad52d`)
- Run URL: https://github.com/mahatosumit/FORGE/actions/runs/38517345801 (prior run 38517045931: https://github.com/mahatosumit/FORGE/actions/runs/38517045931 — failed only on missing `dist/`, which motivated the build step; see implementation history in the phase transcript).
- Infrastructure on all 3 OSes: checkout ✓, setup-node ✓ (both by pinned SHA), `npm ci` ✓, typecheck ✓, lint ✓, build ✓. The log proves `GITHUB_TOKEN Permissions: Contents: read` with checkout succeeding — pins and least-privilege verified in production.
- Suite results: ubuntu 456 pass / 5 fail; windows 462 / 1; mac 458 / 3 (of 463; remainder skipped/todo as printed).
- Failing set (6 distinct, all pre-existing environment-assuming tests, none touched by RR-09):
  - `GATE B` process-tree termination (ubuntu+mac): middle-child PID alive 500 ms after group kill; parent+grandchild dead. Undetermined between PID-reuse and zombie-reaping window — needs Linux `/proc`-state repro. Product defect NOT demonstrated.
  - `FREEZE-001` docker-unavailable + `P2B-E02` docker.sock-absent (ubuntu): GitHub runners HAVE a Docker daemon — the tests' "unavailable" precondition is absent. Test-environment assumption.
  - `P2B-E04` cloud-metadata refused (ubuntu+windows): Azure-hosted runners SERVE 169.254.169.254 (Azure IMDS) — connection legitimately succeeds. Test-environment assumption; FORGE-side host allowlisting is covered by F-06 unit tests.
  - `P2B-003` root-mounts blocked (ubuntu+mac): test feeds Windows literals (`c:\`, `\`) which are ordinary relative filenames on POSIX, not roots — the product is correct to accept them. Test-portability defect; test must be platform-conditional.
  - packs-admission cwd (mac): compares unresolved `$TMPDIR` against `process.cwd()` resolved through the `/var→/private/var` symlink. Test bug; fix by comparing realpaths. Test-only change.
- Conclusion: pins and permissions exonerated (every infra step green). The red suite is a distinct, pre-existing condition tracked as **RR-15** (CI-portability of environment-assuming tests) — not an RR-09 failure. Raw logs: `evidence/ci-ubuntu.log`, `evidence/ci-win.log`, `evidence/ci-mac.log`.
