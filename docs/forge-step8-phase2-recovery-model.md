# FORGE STEP 8 PHASE 2 — RECOVERY MODEL
## Crash Recovery & Consistency Model Across 13 Execution Boundaries

**Document:** Crash Recovery Model Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-recovery-model  
**Date:** 2026-10-07  
**Scope:** 13 Distributed Multi-Agent Execution Boundaries, Replay Invariants, and Post-Effect Fail-Closed Rules  

---

## 1. DISTRIBUTED EXECUTION BOUNDARY TAXONOMY

In a multi-agent system, a crash can strike at any point between the parent's initial intent and the final DAG state update. The 13 critical execution boundaries are:

```text
Boundary 01: [Parent Proposal Created] ──> [Gate Evaluation]
Boundary 02: [Parent Gate Allowed]    ──> [delegation.authorized Committed]
Boundary 03: [delegation.authorized]   ──> [Child Process Spawned]
Boundary 04: [Child Process Running]  ──> [Child Emits First Proposal]
Boundary 05: [Child Proposal Created] ──> [Child Gate Evaluation]
Boundary 06: [Child Gate Allowed]     ──> [Physical Effect Dispatched]
Boundary 07: [Physical Effect Ran]    ──> [Evidence Captured to Disk]  <-- CRITICAL SEAM
Boundary 08: [Evidence Captured]      ──> [observation.created Committed]
Boundary 09: [Task Complete]          ──> [Receipt Generated & Signed]
Boundary 10: [Receipt Written]        ──> [Receipt Transmitted to Parent]
Boundary 11: [Receipt Ingested]       ──> [Parent Verification Pass]
Boundary 12: [Receipt Verified]       ──> [Parent Budget Reconciled]
Boundary 13: [Budget Reconciled]      ──> [Parent DAG Task Completed]
```

---

## 2. THE 13 BOUNDARY RECOVERY SPECIFICATIONS

| Boundary ID | State at Crash | Record at Ledger Tip | Recovery Sweep Action | Replay Policy | Post-Crash State | Escalation Required? |
|---|---|---|---|---|---|---|
| **B-01** | `REQUESTED` | `proposal.created` | Parent Gate evaluation never finished; discard memory request. | Safe to re-evaluate proposal | `FAILED` / Discarded | No |
| **B-02** | `REQUESTED` | None (Pre-commit) | Gate approved in memory, but crash preceded journal commit. | Re-evaluate proposal on restart | Clean restart | No |
| **B-03** | `AUTHORIZED` | `delegation.authorized` | Delegation exists on disk, but child was never spawned. | Safe to spawn child or mark cancelled | `ACTIVATING` / `CANCELLED` | No |
| **B-04** | `ACTIVATING` | `delegation.activated` | Child process died before emitting first proposal. | Do NOT replay blindly; check child journal | `CRASHED` | No |
| **B-05** | `ACTIVE` | `proposal.created` (Child) | Child proposal was written, but child Gate never emitted verdict. | Safe to re-evaluate proposal | `ACTIVE` (under new epoch) | No |
| **B-06** | `ACTIVE` | `proposal.dispatched` | Gate allowed, but crash occurred before effect began. | **FAIL CLOSED**: Cannot assume effect didn't run. | `POST_EFFECT_UNKNOWN` | **YES** |
| **B-07** | `ACTIVE` | External effect executed | Effect ran (e.g. HTTP POST sent), crash occurred before artifact capture. | **STRICT PROHIBITION**: Never replay non-idempotent effect. | `POST_EFFECT_UNKNOWN` | **YES** |
| **B-08** | `ACTIVE` | Artifact on disk | Evidence exists in workspace, but `observation.created` missing from journal. | If idempotent read, re-read. If mutating, fail closed. | `POST_EFFECT_UNKNOWN` | **YES** |
| **B-09** | `ACTIVE` | `observation.created` | All tasks complete, journal flushed, crash before `receipt.json`. | Reconstruct receipt from verified child journal. | `COMPLETED` | No |
| **B-10** | `ACTIVE` | `receipt.json` on disk | Receipt signed on child disk, crash before IPC handover. | Parent supervisor reads `receipt.json` on recovery. | `ACTIVE` $\to$ Ingesting | No |
| **B-11** | `ACTIVE` | `receipt.json` received | Parent received receipt, crash before `delegation.receipt_verified`. | Re-run 6-point verification pipeline. | Ingesting | No |
| **B-12** | `COMPLETED` | `delegation.receipt_verified` | Receipt verified, crash before budget reconciliation. | Re-run `reconcileBudget()` deterministically. | Reconciling | No |
| **B-13** | `COMPLETED` | `delegation.budget_reconciled` | Budget reconciled, crash before DAG task marked complete. | Re-run DAG completion from committed reconciliation. | `COMPLETED` | No |

---

## 3. THE POST-EFFECT UNKNOWN INVARIANT

Across boundaries **B-06, B-07, and B-08**, external side effects may have altered physical reality (e.g., an external API call was dispatched, a database record inserted, or a file mutated).

### The Invariant
$$\text{If } \exists \text{ DispatchedProposal} \land \nexists \text{ CommittedObservation} \implies \text{Classification} = \mathbf{POST\_EFFECT\_UNKNOWN}$$

1. **Zero Silent Re-execution:**
   - The runtime **MUST NOT** silently re-execute the dispatched proposal. Re-executing non-idempotent proposals can result in duplicate payments, double writes, or corrupted state.
2. **Quarantine State:**
   - The child delegation transitions to `UNCERTAIN`.
   - The parent task transitions to `PENDING_ESCALATION`.
   - Escrowed budget remains frozen.
3. **Operator Resolution:**
   - The human operator or automated Crash Audit Daemon inspects the physical boundary.
   - The operator either provides an external confirmation receipt or marks the task aborted.
