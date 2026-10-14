# RR-08 Residual-Risk Update — 2026-10-14

## RR-08 status: CLOSED
- **Implemented:** hermetic lane + CI browser job + structural checker.
- **Verified:** local 12/12 green → sabotage red → green; CI green → sabotage red (assertion-level, artifacts uploaded) → green. All three CI executions observed directly, not inferred.
- **Closure condition satisfied:** deterministic lane exists, runs in CI, proven to fail CI on assertion failure and pass on the repaired build.

## Remaining (explicit, not RR-08 scope)
- Browser job ubuntu-only; Windows/macOS browser runs unclaimed.
- Real-model UI flows still belong to the interactive lane + model certification (RR-10, spend-gated).
- `playwright` devDep needs Dependabot-style SHA/version hygiene on the same schedule as action pins.
- Lane covers the console as of this tree; new UI surfaces need new checks (no automatic coverage).
