# Crash Recovery & State Machines in FORGE v1.1

FORGE is crash-safe by design. It treats the ledger as the single source of truth.

## Recovery Semantics

1. **Pre-Effect Proposals**:
   If the runtime crashes after a proposal is validated but before it is dispatched, the proposal is safely re-evaluated upon resume.
2. **Post-Effect Unknown (ADR-006)**:
   If the runtime crashes after a proposal has been dispatched but before its observation is recorded to disk, FORGE marks the state `post-effect-unknown`. It NEVER silently re-executes potentially non-idempotent operations. The operator is prompted to confirm whether the side-effect took place before continuing.
3. **Closed Missions (F-02)**:
   A closed mission (`mission.closed`) can NEVER be resumed or mutated. Any attempt to append records to a closed ledger is rejected by the runtime.

## Resuming an Interrupted Mission

### In Web UI:
- Interrupted or recoverable missions appear in the Mission History table with a **Resume** action.

### In CLI:
```bash
forge resume <missionId>
```
FORGE reads the ledger, reconstructs the active grant state and stage progress, verifies hash integrity, and continues execution seamlessly.
