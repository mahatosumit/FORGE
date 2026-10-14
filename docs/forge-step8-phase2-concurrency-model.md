# FORGE STEP 8 PHASE 2 — CONCURRENCY MODEL
## Multi-Agent Concurrency, Linearization Points, and Lock Semantics

**Document:** Concurrency & Linearization Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-concurrency-model  
**Date:** 2026-10-07  
**Scope:** Multi-Process Synchronization, Advisory File Locks, CAS Linearization, and Independent Ledger Writers  

---

## 1. WHY NODE.JS SINGLE-THREADING IS NOT A SECURITY ASSUMPTION

A common failure in multi-agent designs is assuming:
> *"Because Node.js runs on a single-threaded event loop, race conditions between agents cannot occur."*

This assumption is catastrophically false in FORGE Phase 2:
1. Child runtimes execute in **separate OS processes or containers**.
2. Multiple supervisor threads, external audit daemons, and host workers access shared files concurrently.
3. Node.js processes can be terminated mid-operation, leaving partial writes or stale lock files.
4. Therefore, all concurrency, topology constraints, and budget mutations must be protected by **durable cross-process synchronization primitives**.

---

## 2. CROSS-PROCESS SYNCHRONIZATION ARCHITECTURE

```text
       PROCESS A (Supervisor)                   PROCESS B (Child Runtime)
                 │                                         │
        acquireLock(".lock")                     acquireLock(".lock")
                 │                                         │
        [Lock Acquired]                                 [Blocked / Retrying]
        - Read journal tip                              - Bounded backoff
        - Append record + fsyncSync                     - Lease timeout check
        - Atomic rename / update                        - Stale lease recovery
                 │                                         │
        releaseLock(".lock")                               │
                 │                                         │
                 └────────────────────────────────────────>│
                                                        [Lock Acquired]
```

### 2.1 File Lock Primitives
* **`src/ledger/lock.ts`:**
  - Implements crash-safe, lease-based advisory file locking using atomic OS file creation (`openSync(path, 'wx')`).
  - Records owner PID, creation timestamp, and monotonic lease duration.
  - Automatically recovers stale locks if owner PID is dead or lease expired (tested by `CRASH-003` and `CRASH-027`).
* **Lock Targets:**
  - `governance/.delegation-registry.lock`: Exclusive lock protecting registry mutations, topology limit assertions, and cascade revocations.
  - `missions/<missionId>/.lock`: Exclusive single-writer lock protecting a mission journal from concurrent append operations.

---

## 3. LINEARIZATION POINTS FOR CONCURRENT OPERATIONS

### 3.1 Concurrent Child Spawning (Fanout Limit Enforced)
* **Scenario:** Parent attempts to spawn 4 children concurrently in parallel worker threads ($C_1, C_2, C_3, C_4$).
* **Linearization Point:** The acquisition of `governance/.delegation-registry.lock` inside `registerDelegation()`.
* **Execution:**
  1. Threads serialize on the lock.
  2. Thread 1 acquires lock: active children = 0 $\to$ registers $C_1$ (active = 1), releases lock.
  3. Thread 2 acquires lock: active children = 1 $\to$ registers $C_2$ (active = 2), releases lock.
  4. Thread 3 acquires lock: active children = 2 $\to$ registers $C_3$ (active = 3), releases lock.
  5. Thread 4 acquires lock: active children = 3 $\to$ checks $F \le 3$. Since $3 \ge 3$, throws `FanoutLimitExceededError`, releases lock.
* **Guarantee:** Never more than 3 active children exist, regardless of thread interleaving.

### 3.2 Concurrent Revocations
* **Scenario:** Parent triggers revocation of Child $A$ while Host Supervisor timeout daemon simultaneously revokes Child $A$.
* **Linearization Point:** The acquisition of `governance/.delegation-registry.lock` inside `revokeDelegation()`.
* **Execution:**
  1. Caller 1 acquires lock: finds $A$ active $\to$ updates $A$ to `revoked`, appends `delegation.revoked`, releases lock.
  2. Caller 2 acquires lock: finds $A$ already `revoked` $\to$ performs no-op, returns cleanly (idempotent), releases lock.
* **Guarantee:** Zero double-revocation anomalies or corrupted state.

### 3.3 Parent and Child Independent Ledger Writes
* **Scenario:** Parent is appending DAG task records to `missions/<parentMissionId>/journal.jsonl` while Child is appending capability observations to `missions/<childMissionId>/journal.jsonl`.
* **Linearization Point:** Independent mission directories each possess an independent single-writer lock (`missions/<mId>/.lock`).
* **Execution:**
  - Parent locks `missions/<parentMissionId>/.lock`.
  - Child locks `missions/<childMissionId>/.lock`.
  - Zero lock contention occurs between parent and child ledgers (empirically proven by Step 7B test `CRASH-026`).
* **Guarantee:** High-throughput non-blocking multi-agent execution.

### 3.4 Budget Settlement Linearization
* **Scenario:** Child completes and submits receipt for reconciliation while parent planner is allocating budget for a new sibling.
* **Linearization Point:** `BudgetEscrowManager` mutation under parent mission lock.
* **Execution:**
  - Reservations deduct from `available` via atomic CAS.
  - Reconciliations return unspent remainder to `available`.
  - Both operations execute inside `ledger.withLock()`, guaranteeing that `available` is never read in a torn state.
