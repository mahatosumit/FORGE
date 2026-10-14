# Phase Zero evidence manifest — generated during audit, append-only notes

## Workspace
- Target: D:\quack pro\forge
- Audit output dir: D:\quack pro\forge\audit\security-2026-10\
- Backups of any file modified during this audit: D:\quack pro\forge\audit\security-2026-10\backups\

## Claimed vs verified (to fill during audit)
| Claim | Verified? | Evidence |
|---|---|---|
| typecheck passes | | |
| lint passes | | |
| build succeeds | | |
| 442/442 tests pass | | |
| real-model cert passes | (NOT re-run; model cost) | prior logs in %TEMP%\forge-cert13.log |
| browser E2E 12/12 | | |
| server is FORGE on :3100 | | |
| 3 historical broken chains | | |
| not git-backed | | |

## Secret handling
- Record locations/metadata only: forge/.env (NVIDIA_API_KEY present: SET), .forge/forge-config.json (apiKeyEnvVar references), .forge/session.json (bearer token), .forge/data (mission journals).
- No secret VALUES reproduced in any audit output.
