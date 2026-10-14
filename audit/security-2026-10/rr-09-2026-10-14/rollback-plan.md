# RR-09 Rollback Plan — 2026-10-14

Only one file changed: `.github/workflows/ci.yml`. Pre-change copy: `backups/ci.yml.orig` (SHA-256 `61EBD54E88DAA14A1C9686BF448FF2A26297F663BE6340E630E250ABCF6BA974`).

## Isolated rollback (single command, no side effects)
```powershell
Copy-Item "audit\security-2026-10\rr-09-2026-10-14\backups\ci.yml.orig" ".github\workflows\ci.yml" -Force
```
Then confirm: `Get-FileHash .github\workflows\ci.yml` equals the pre-change hash above, and re-run `node audit/security-2026-10/rr-09-2026-10-14/tools/check-workflow.mjs` expecting FAIL on the SHA checks (proves the rollback restored tag pins).

## Blast radius
None beyond CI: no source, test, config, or data file was modified in this phase. Application behavior is identical either way (workflow file is not read by the runtime).
