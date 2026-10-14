# FORGE STEP 7B — ACCEPTANCE TEST MATRIX

**Milestone:** Step 7B — Persistence & Production Runtime  
**Target:** 20 Rigorous Acceptance Tests (`CRASH-001` through `CRASH-020`)  
**Standard:** Empirical Behavioral Execution against Real Filesystem and Runtime State Machines.

---

## 1. ACCEPTANCE TESTS OVERVIEW

| Test ID | Sub-Milestone | Description | Target Invariant | Expected Outcome |
| :--- | :--- | :--- | :--- | :--- |
| **CRASH-001** | **7B.2** | Physical `fsync` verification | **INV-19** | Every ledger append flushes to disk physical media via `fsyncSync`. |
| **CRASH-002** | **7B.2** | Atomic artifact creation & retry | **INV-19** | Artifact writes use temp file + `renameSync`; transient locks back off and succeed. |
| **CRASH-003** | **7B.2** | Crash lease recovery | **INV-6** | Dead writer with heartbeat older than `LOCK_STALE_MS` is stolen safely on recovery. |
| **CRASH-004** | **7B.2** | Concurrent writer collision | **INV-6** | Active writer with fresh heartbeat rejects second concurrent writer with `LockError`. |
| **CRASH-005** | **7B.2** | Torn trailing write detection | **INV-19** | Uncommitted torn trailing line is detected; recovery mode safely truncates to last valid newline. |
| **CRASH-006** | **7B.3** | Mid-journal tampering quarantine | **INV-5** | Modified byte in historical record $k < N$ throws `JournalCorruptionError` and quarantines mission. |
| **CRASH-007** | **7B.3** | Zero-data-loss projection rebuild | **INV-13** | Deleting in-memory/DB projections and replaying from `journal.jsonl` yields identical state. |
| **CRASH-008** | **7B.3** | Closure anchor durability | **F-04** | Journal altered after closure or with mismatched closure tip throws `JournalCorruptionError`. |
| **CRASH-009** | **7B.4** | Boundary B-01 recovery | **B-01** | Interruption before proposal generation resets task to `ready` and re-runs turn. |
| **CRASH-010** | **7B.4** | Boundary B-02 / B-03 recovery | **B-02/B-03** | Pre-dispatch proposal in ledger re-evaluates safely without duplicate effects. |
| **CRASH-011** | **7B.4** | Boundary B-04 / B-05 / B-06 recovery | **INV-20** | Dispatched non-idempotent action (`shell`, `fs.append`) fails closed as `post-effect-unknown`. |
| **CRASH-012** | **7B.4** | Conservative idempotency replay | **INV-20** | Dispatched pure-read / idempotent action (`search`, `fs.write`) replays safely without blockage. |
| **CRASH-013** | **7B.4** | Boundary B-10 (DAG task step) | **B-10** | Crash between task steps resumes from exact next task; completed tasks never re-execute. |
| **CRASH-014** | **7B.4** | Boundary B-11 (Milestone step) | **B-11** | Crash during milestone transition cleanly transitions to next milestone. |
| **CRASH-015** | **7B.4** | Boundary B-12 (Checkpoint crash) | **B-12** | Crash during checkpoint creation preserves previous valid checkpoint intact. |
| **CRASH-016** | **7B.5** | Fast resume from checkpoint | **7B.5** | Engine restores completed task set from checkpoint without replaying entire historical DAG. |
| **CRASH-017** | **7B.5** | Resumption ledger audit | **7B.5** | Resuming from checkpoint appends `mission.resumed` with `fromCheckpointId`; zero record mutations. |
| **CRASH-018** | **7B.1** | Deterministic state machine | **7B.1** | Illegal state transitions rejected with `MissionStateTransitionError`; terminal sinks immutable. |
| **CRASH-019** | **7B.6** | Version incompatibility defense | **7B.6** | Journal with schema version > 1 fails closed with `UnsupportedSchemaVersionError`. |
| **CRASH-020** | **7B.7** | Production runtime daemon sweep | **7B.7** | `ForgeRuntime` startup scans dataDir, detects interrupted missions, and executes recovery sweep. |

---

*Authored by Principal Security Engineering & Certified by FORGE Architecture Core.*
