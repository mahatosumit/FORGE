# FORGE STEP 8 PHASE 2 — BUDGET MODEL
## Hierarchical Multi-Agent Budget Settlement & Conservation Model

**Document:** Multi-Agent Budget Settlement Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-budget-model  
**Date:** 2026-10-07  
**Scope:** 7-Stage Budget Lifecycle, Conservation Laws, Multi-Tier Escrow, and Crash Reconciliation  

---

## 1. MULTI-AGENT BUDGET LIFECYCLE

The allocation, usage, and settlement of resources across the multi-agent tree follow a strict 7-stage lifecycle:

```text
       1. RESERVATION
       [Parent Authority Gate reserves escrow via atomic CAS]
              │
              ▼
       2. EXECUTION
       [Child runtime dispatches authorized capability proposals]
              │
              ▼
       3. OBSERVATION
       [Physical execution produces evidence & observation record]
              │
              ▼
       4. CONSUMED
       [Observation records exact token / call / time / byte usage]
              │
              ▼
    ┌─────────┴─────────┐
    ▼                   ▼
5A. RECEIPT READY    5B. UNCERTAIN (Crash / Loss)
    │                   │
    ▼                   ▼
6. RECONCILIATION    6. CRASH AUDIT DAEMON
    │                   │
    ▼                   ▼
7. SETTLEMENT        7. PARTITIONED SETTLEMENT
   (Consumed committed, (Audited Consumed committed,
    Remainder refunded)  Remainder refunded)
```

---

## 2. MATHEMATICAL BUDGET CONSERVATION LAW

Across all 5 resource dimensions:
1. `maxTokens`
2. `maxModelCalls`
3. `maxCapabilityCalls`
4. `maxExecutionTimeMs`
5. `maxArtifactBytes`

The conservation of authority demands that resources cannot be minted, resurrected, or double-spent across delegation tiers.

### 2.1 Two-Tier Conservation (Root and Direct Children)
$$\forall \text{dimension } m: \quad \text{TotalLimit}(m) = \text{Consumed}_{\text{root}}(m) + \sum_{c \in \text{Children}} \text{Escrow}_c(m) + \text{Available}_{\text{root}}(m)$$
$$\text{where } \text{Available}_{\text{root}}(m) \ge 0$$

### 2.2 Multi-Tier Conservation (Root $\to$ Child $\to$ Grandchild)
For every child $c$ delegating to grandchildren $gc$:
$$\text{Escrow}_c(m) = \text{Consumed}_c(m) + \sum_{gc \in \text{Grandchildren}(c)} \text{Escrow}_{gc}(m) + \text{Available}_c(m)$$
$$\text{where } \text{Available}_c(m) \ge 0$$

At no point in time may the sum of consumed, escrowed, and available funds exceed the initial root budget allocation, nor may any available balance become negative.

---

## 3. COMPREHENSIVE SETTLEMENT SCENARIOS

### Scenario 1: Child Success with Partial Consumption
* **Setup:** Parent escrows 10,000 tokens for Child $C$. Child successfully completes task, consuming 3,500 tokens.
* **Process:**
  1. Child emits receipt with `budgetConsumed.maxTokens = 3500`.
  2. Parent verifies receipt and ledger observations ($3,500$ tokens logged).
  3. Parent commits `delegation.receipt_verified`.
  4. Escrow is partitioned:
     - Consumed: 3,500 tokens added to parent's consumed tally.
     - Unspent Remainder: $10,000 - 3,500 = 6,500$ tokens refunded to parent's `available` balance.
  5. Parent commits `delegation.budget_reconciled`.
* **Invariant:** Total budget remains perfectly conserved ($3,500 + 6,500 = 10,000$).

### Scenario 2: Child Failure / Error
* **Setup:** Child fails at step 2 after consuming 1,200 tokens.
* **Process:**
  1. Child emits failure receipt with `status: "failure"`, `budgetConsumed.maxTokens = 1200`.
  2. Parent verifies observations confirm 1,200 tokens consumed.
  3. Parent commits `delegation.receipt_rejected` or `delegation.failed`.
  4. Partition:
     - 1,200 tokens marked consumed.
     - 8,800 unspent tokens refunded to parent available balance.
  5. Parent commits `delegation.budget_reconciled`.
* **Invariant:** Consumed funds are accounted for; unspent funds are safely returned.

### Scenario 3: Child Process Crashes Mid-Execution
* **Setup:** Child has 10,000 tokens escrowed. Child process dies abruptly.
* **Process:**
  1. Supervisor detects process termination.
  2. Recovery sweep inspects child ledger.
  3. If child has a dispatched proposal without observation, state transitions to `UNCERTAIN`.
  4. Escrow is frozen in `UNCERTAIN` state.
  5. **Direct refund is forbidden:** Calling `refundUncertainDirectly()` throws `UncertainBudgetRefundError`.
* **Resolution:** Requires Crash Audit Daemon (see Section 4).

### Scenario 4: Parent Process Crashes While Child Is Running
* **Setup:** Child is actively executing in sandbox; host supervisor crashes.
* **Process:**
  1. Child continues executing within its container (isolated execution).
  2. Host supervisor reboots and executes recovery sweep.
  3. Reads parent ledger: sees `delegation.authorized` and `delegation.activated`.
  4. Reconnects to child runtime via IPC / socket or checks process table.
  5. If child is still alive, parent adopts child process and continues monitoring.
  6. Escrow remains safely in `ALLOCATED` state.

### Scenario 5: Simultaneous Parent and Child Crash
* **Setup:** Machine loses power or host OS crashes while both parent and child are executing.
* **Process:**
  1. On boot recovery, Supervisor reconstructs `MultiAgentProjection` from parent `journal.jsonl`.
  2. Replays child `journal.jsonl`.
  3. Both processes are dead.
  4. Child state transitions to `CRASHED` / `UNCERTAIN`.
  5. Parent ledger commits `delegation.crashed`.
  6. Escrow transitions to `UNCERTAIN`.

### Scenario 6: Lost Receipt
* **Setup:** Child successfully completed task and exited, but `receipt.json` was deleted or unreadable due to disk error.
* **Process:**
  1. Parent attempts to read receipt; file not found.
  2. Parent falls back to direct inspection of child `journal.jsonl`.
  3. If child journal contains a clean task completion record, the parent `ReceiptVerifier` reconstructs a verified receipt directly from the immutable journal records.
  4. If child journal is corrupt or missing completion record, transition to `UNCERTAIN`.

### Scenario 7: Duplicated or Replayed Receipt
* **Setup:** Attacker or buggy IPC re-delivers an already processed receipt.
* **Process:**
  1. Parent `ReceiptVerifier` checks `receipt.nonce` against consumed nonces.
  2. Nonce match detected.
  3. Receipt dropped immediately without state change or budget mutation.
  4. Zero double-refund occurs.

### Scenario 8: Multi-Dimensional Partial Consumption Accounting
* **Setup:** Child consumes 5,000 tokens, 3 model calls, 1 capability call, 45,000 ms execution time, and 12,000 artifact bytes.
* **Process:**
  - All 5 dimensions are reconciled independently and atomically in `delegation.budget_reconciled`.
  - Every dimension satisfies $\text{Consumed}_c(m) \le \text{Escrow}_c(m)$.
  - Any attempt to refund more than $\text{Escrow}_c(m) - \text{Consumed}_c(m)$ throws an assertion error.

---

## 4. THE CRASH AUDIT DAEMON

The `CrashAuditDaemon` is the sole authorized mechanism to settle `UNCERTAIN` budgets:

1. **Forensic Log Audit:**
   - Mounts child mission directory in read-only mode.
   - Audits child `journal.jsonl` and workspace artifacts.
   - Determines the last durable observation record.
2. **External Side Effect Reconciliation:**
   - If an unobserved external request (e.g. `http`) was dispatched, checks if an idempotent response or evidence exists.
   - If evidence exists, marks actual consumed resources.
   - If completely unknown, treats in-flight allocation as consumed (worst-case assumption) to ensure safety against under-reporting.
3. **Partition & Settlement:**
   - Partitions `UNCERTAIN` balance into:
     - $\text{AuditedConsumed}$: committed to parent consumed tally.
     - $\text{AuditedRefund}$: returned to parent available balance.
   - Commits `delegation.budget_reconciled` to parent journal with `auditReference`.
