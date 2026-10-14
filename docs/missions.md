# Mission Lifecycle & Execution in FORGE v1.1

A **Mission** is a governed, audited autonomous task execution in FORGE.

## The Governed Loop

```
1. Mission Opened (User intent recorded in immutable ledger)
2. Criteria Defined (Mechanical verification requirements established)
3. Plan Proposed & Confirmed (Budget and stage boundaries fixed)
4. Authority Envelope Minted (Base policy grants issued)
5. Model Turn (Reasoning + Proposal generation)
6. Authority Gate Evaluation (Permitted / Out-of-Grant / Denied)
7. Escalation Flow (If out-of-grant: pauses and requests human review)
8. Host Dispatch (Capability executed in isolated environment)
9. Observation Authored (Raw results recorded to ledger)
10. Claim & Verification (Verifier checks criteria against evidence)
11. Closure & Cryptographic Receipt Generation
```

## Launching Missions

### In Web UI:
1. Provide an objective in the Mission Control Center.
2. Select Authority Level:
   - `Safe Dev`: Scoped source writing (`src/**`, `test/**`), command execution matching criteria.
   - `Full Dev`: Full repository modification, git actions, network requests.
   - `Read Only`: Read and search operations only.
3. Select Verification Level:
   - `Standard`: Mechanical test verification (e.g. `npm test`, `pytest`).
   - `Strict`: Mechanical test verification + clean working tree validation.
   - `Basic`: Process exit code validation.
4. Click **Launch Governed Mission**.

### In CLI:
```bash
forge run "Add authentication middleware to /api/checkout and update unit tests"
```

## Mission Board & Telemetry

During execution:
- **Telemetry Timeline**: Real-time event stream showing every grant, proposal, dispatch, and observation.
- **Escalation Review**: When dangerous proposals arise, human operators approve or deny them.
- **Evidence Graph**: Displays how claims are backed by physical observations.
- **Receipt Tab**: SHA-256 hash chain verification proving no tampering took place.
