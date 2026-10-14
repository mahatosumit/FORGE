# FORGE STEP 8 — REMEDIATED CONCURRENCY & TRANSACTIONAL BOUNDARIES MODEL

**Document:** Formal Specification — Remediated Concurrency, CAS Boundaries & Anti-TOCTOU Architecture  
**Status:** REMEDIATED ARCHITECTURAL SPECIFICATION  
**Version:** FORGE v1.3-remediated-concurrency  
**Date:** 2026-10-07  
**Remediates:** Finding S8-10 (Medium)  
**Authors:** Principal Security Architect & Adversarial Engineering  

---

## 1. THE CONCURRENCY PROBLEM & TOCTOU VULNERABILITIES

In an asynchronous runtime (Node.js event loop with multi-task autonomy), relying on un-synchronized in-memory state projections introduces critical Time-Of-Check to Time-Of-Use (TOCTOU) races:
1. **Budget Overdraw:** Two asynchronous tasks read the same in-memory `remainingBudget = 10`. Both propose child delegations of 8. Both pass the Gate. Both append, overdrawing the parent pool (16 > 10).
2. **Fanout Limit Breach:** Two tasks read `activeChildren = 2` ($F_{\max} = 3$). Both pass fanout check. Both spawn children, creating 4 active children ($4 > 3$).
3. **Revocation Race:** Task dispatches a capability while parent concurrently writes `grant.revoked`.

---

## 2. FORMAL CAS & TRANSACTIONAL SERIALIZATION BOUNDARIES

FORGE eliminates TOCTOU races by defining explicit, machine-enforced transactional boundaries backed by physical file locks and atomic Compare-And-Swap (CAS) primitives:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                TRANSACTIONAL BOUNDARY MAP                              │
├─────────────────────┬───────────────────────────┬──────────────────────────────────────┤
│ Operation Domain    │ Concurrency Hazard        │ Enforcing Primitive                  │
├─────────────────────┼───────────────────────────┼──────────────────────────────────────┤
│ 1. Budget Escrow    │ Sibling overdraw race     │ Parent Ledger Write Lock + CAS       │
│ 2. Delegation Spawn │ Fanout ($F_{\max}$) race  │ Parent Ledger Lock + Registry Check  │
│ 3. Task Claims      │ Sibling claim collision   │ Atomic CAS on Task State (Ready->Run)│
│ 4. Pre-Dispatch Rev │ In-flight revocation race │ Supervisor Pre-Dispatch Atomic Hook  │
│ 5. Receipt Accept   │ Duplicate receipt race    │ Parent Ledger Lock + Digest Set CAS  │
│ 6. Checkpoint Store │ Stale checkpoint race     │ Milestone Transition Mutex           │
│ 7. Registry Cascade │ Descendant escape race    │ Central Registry Write Lock          │
└─────────────────────┴───────────────────────────┴──────────────────────────────────────┘
```

---

## 3. SPECIFICATION OF THE SEVEN CRITICAL TRANSACTION SEAMS

### 3.1 Seam 1: Budget Escrow Reservation (Remediates S8-10)
- **Hazard:** Concurrent parent tasks allocating overlapping budget portions.
- **Enforcement:**
  ```typescript
  function reserveBudgetTx(parentLedger: Ledger, spec: DelegationSpec): ReservationResult {
    return parentLedger.withExclusiveLock(() => {
      const currentProjections = rebuildBudgetProjection(parentLedger);
      if (spec.budget.maxTokens > currentProjections.availableTokens) {
        throw new InsufficientBudgetError();
      }
      return parentLedger.appendRecord({
        kind: "delegation.authorized",
        body: { delegationId: spec.id, budgetEscrow: spec.budget },
      });
    });
  }
  ```
- **Guarantee:** Read, threshold check, and append execute atomically inside the exclusive lock.

### 3.2 Seam 2: Delegation Creation & Fanout Bounding
- **Hazard:** Concurrent delegations exceeding $F_{\max} \le 3$ or $N_{\max} \le 10$.
- **Enforcement:** Executed inside `parentLedger.withExclusiveLock()` concurrently querying the Central Delegation Registry. If `activeChildren + 1 > F_{\max}`, proposal is rejected before grant issuance.

### 3.3 Seam 3: Task Claim CAS
- **Hazard:** Sibling agents simultaneously claiming DAG Task $T_1$.
- **Enforcement:** Task transition from `ready` to `running` requires an atomic CAS operation:
  $$\text{CAS}(T.\text{status}, \text{"ready"} \to \text{"running"}, \text{claimedBy} = \text{agentId})$$
  The second attempt observes `status === "running"` and throws `TaskAlreadyClaimedError`.

### 3.4 Seam 4: Pre-Dispatch Revocation Interception
- **Hazard:** Revocation occurs after proposal approval but before execution.
- **Enforcement:** Capability Host on host supervisor checks `DelegationRegistry.getStatus(delegationId)` immediately before invoking capability implementation. If status is `revoked`, dispatch is aborted synchronously with zero side effects.

### 3.5 Seam 5: Receipt Acceptance & Nonce Deduplication
- **Hazard:** Replayed receipt delivered by rogue agent or network retry.
- **Enforcement:** Parent verifies `receipt.receiptDigest` and `receipt.nonce` against an immutable Set persisted in the parent projection index. If already present, transaction aborts with `DuplicateReceiptError`.

### 3.6 Seam 6: Checkpoint State Reconstitution
- **Hazard:** Checkpoint committed concurrently with milestone transition.
- **Enforcement:** Checkpoint creation acquires the mission milestone lock, serializing checkpoint writes after all in-flight tasks have reached terminal states.

### 3.7 Seam 7: Cascade Revocation Sweep
- **Hazard:** New child created while parent cascade revocation is traversing registry.
- **Enforcement:** Central Delegation Registry write lock is acquired. Parent entry is marked `revoked`. While lock is held, all descendant entries are discovered and marked `revoked`. Any concurrent delegation proposal attempting to register under parent will observe `parent.status === "revoked"` and fail immediately.

---

*Authored by Principal Security Architect & Adversarial Engineering.*
