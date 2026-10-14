# RR-08 Verification Report — 2026-10-14

## Local proof (before any push)
- Lane green: `E2E-CI: 12/12 passed`, exit 0 (hermetic: own server, mock model, bundled chromium).
- Sabotage (assertion threshold `> 99999` via exact edit): `FAIL provider badge shows a model`, 11/12, exit 1 — clean assertion failure, then reverted and re-verified 12/12. (An earlier PowerShell string-surgery sabotage broke syntax instead; redone exactly. Both episodes confirm failure propagation; only the clean one counts as evidence.)
- Gates: typecheck 0, lint PASS, build 0, full suite 465/465 (package change safe).

## CI proof (three runs, all recorded)
| Run | Commit | Matrix (3 OS) | Browser job | Verdict |
|---|---|---|---|---|
| [38528663135](https://github.com/mahatosumit/FORGE/actions/runs/38528663135) | `8d42cbf` lane+job | green ×3 | **success** (12/12 in CI) | lane works in CI |
| [38528887455](https://github.com/mahatosumit/FORGE/actions/runs/38528887455) | `d3fc809` sabotage | green ×3 | **failure** (`FAIL provider badge shows a model`, 11/12, exit 1; artifacts uploaded) | lane can fail CI for the right reason |
| [38529340537](https://github.com/mahatosumit/FORGE/actions/runs/38529340537) | `6259720` revert | green ×3 | **success** | final state green |

## Limitations (explicit)
- Browser job is ubuntu-only (cost decision, documented in workflow + checker). Windows/macOS browser coverage is future work, not claimed.
- `upload-artifact@v4.4.3` chosen over v7 lineage deliberately (conservative, matches file's v4 pins).
- Lane asserts against mock-model behavior; real-model UI flows remain covered by the interactive lane + model cert, not this job.
