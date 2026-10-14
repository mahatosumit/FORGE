# FORGE STEP 8 — MULTI-AGENT CRASH RECOVERY, REVOCATION & CONCURRENCY MODEL

**Status:** RECOVERY & CONCURRENCY SPECIFICATION  
**Version:** FORGE v1.3-recovery-model  
**Authors:** Principal Systems Architect & Security Engineering  
**Prerequisites:** Step 6 (Governance), Step 7A (Sandbox Isolation), Step 7B (Persistence)  

---

## 1. CASCADE REVOCATION PROTOCOL

In a multi-agent tree, revocation must be mathematically monotonic: revoking an authority node instantly invalidates the entire sub-tree below it.

```text
               Root Mission
                    │
                Agent A (REVOKED!)
               /        \
              ▼          ▼
          Agent B      Agent C  <--- BOTH INSTANTLY INVALIDATED
             │
             ▼
          Agent D               <--- INSTANTLY INVALIDATED
```

### 1.1 The Four Distinct Operations
To prevent security confusion, FORGE strictly differentiates four distinct operations:

| Operation | Target Domain | Mechanism | Effect |
| :--- | :--- | :--- | :--- |
| **Authorization Revocation** | Authority Gate | Ledger record `grant.revoked` | Gate mechanically blocks any future proposals. Zero new dispatches permitted. |
| **Process / Container Termination** | OS / Container Engine | `docker.kill()` primitive | Atomically terminates in-flight containers, processes, and child threads. |
| **Mission Cancellation** | State Machine | `transitionState("cancelled")` | Marks sub-mission terminal. Outgoing transitions become empty (`[]`). |
| **Evidence Preservation** | Audit Journal | Journal immutable append | Historical records, logs, and artifacts are **NEVER deleted**. Complete audit trail survives. |

### 1.2 Cascade Execution Sequence
When Agent $P$ (or Operator) revokes delegation $D$:
1. **Commit Revocation Record:** Write `delegation.revoked` to parent journal with `fsyncSync()`.
2. **Invalidate Active Grants:** Grant store marks `delegationId` and all child grant IDs as revoked.
3. **Traverse Descendant Tree:** Recursively discover all active child and grandchild delegations $D_{\text{child}} \in \text{Descendants}(D)$. Write `delegation.revoked` for each descendant.
4. **Kill Child Containers:** `ForgeRuntime` issues container termination (`docker kill -s SIGKILL`) to all child container IDs.
5. **Classify In-Flight Operations:**
   - Undispatched proposals: Discarded cleanly (`status: cancelled`).
   - Dispatched non-idempotent operations without observation: Flagged as `post-effect-unknown`.
6. **Reclaim Escrowed Budgets:** Unspent tokens and capability calls return to parent unallocated pool.

---

## 2. THE 15-SCENARIO MULTI-AGENT FAILURE & CRASH RECOVERY MATRIX

Integrating Multi-Agent Authority with Step 7B's physical persistence and crash recovery engine:

| Scenario ID | Failure Point | Persisted Ledger Facts | Recovered State | Allowed Actions | Forbidden Actions | Replay Allowed? | Operator Ack Needed? |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **F-01** | Parent crashes before child creation proposal | Parent journal intact; no delegation records. | Parent restarts in `recovering`; plan re-evaluates. | Re-evaluate reasoning turn; propose child if needed. | Cannot assume child exists. | Yes (pure computation) | No |
| **F-02** | Parent crashes after `delegation.proposed` | `delegation.proposed` logged; no authorization record. | Pre-authorization in-flight state. | Gate re-evaluates proposal against active grants. | Cannot spawn child without authorization. | Yes (pure state) | No |
| **F-03** | Parent crashes after `delegation.authorized` | `delegation.authorized` committed; budget escrowed. | Authorized pending spawn. | Spawn child process or clean up unused escrow. | Cannot double-deduct budget from parent. | Yes (idempotent spawn) | No |
| **F-04** | Parent crashes after child container activated | `delegation.activated` committed; child mission dir exists. | Active child running or orphaned. | Re-attach to child lock or signal child. | Cannot spawn duplicate second child. | No (re-attach only) | No |
| **F-05** | Child crashes during pure computation | Child journal ends mid-turn; no dispatched proposal. | Child state `recovering`; interrupted task reset. | Child restarts turn; re-reasons with ledger context. | Cannot skip failed reasoning turn. | Yes (pure computation) | No |
| **F-06** | Child crashes after real external side effect | Child dispatched non-idempotent action; 0 observations. | **`post-effect-unknown`** in child ledger. | Block automatic child execution; notify parent. | **AUTOMATIC REPLAY FORBIDDEN.** | **NO** | **YES** |
| **F-07** | Child crashes before receipt generation | Tasks completed in child journal; no receipt record. | Tasks succeeded; receipt pending. | Child generates receipt from final journal tip. | Cannot re-execute completed tasks. | Yes (receipt generation) | No |
| **F-08** | Child crashes after receipt generated, before parent ack | Receipt in child journal; uncommitted in parent. | Uncommitted receipt state. | Parent ingests receipt; verifies child ledger tip. | Cannot discard completed child work. | Yes (receipt delivery) | No |
| **F-09** | Parent recovers while child is still alive | Parent restarted; child container still running. | Parent detects child lock alive; checks heartbeats. | Await child receipt or inspect child progress. | Cannot spawn competing replacement child. | No | No |
| **F-10** | Child recovers after parent was revoked | Child journal active; parent journal has `delegation.revoked`. | Child checks parent grant; discovers revocation. | Child immediately transitions to `cancelled` and exits. | Cannot dispatch any new capabilities. | **NO** | No |
| **F-11** | Root process crashes with multiple agents active | Diverse journals across parent and child sub-dirs. | `bootRecoverySweep()` scans all mission dirs. | Recovers each sub-mission in reverse tree order (leaves $\to$ root). | Cannot cross-contaminate mission journals. | Per-invariant rules | If non-idempotent in-flight |
| **F-12** | Corrupted delegation record in parent journal | Hash chain broken in parent journal. | `JournalCorruptionError` raised. | Quarantine mission; halt all child executions. | Cannot continue running with corrupted history. | **NO** | **YES** |
| **F-13** | Stale delegation lock held by dead child | Child `.lock` mtime $> 30\text{s}$ old; dead process PID. | Stale lock detected by recovery daemon. | Steal lock cleanly; run child recovery analysis. | Cannot let dead lock permanently stall parent. | Yes (lock theft) | No |
| **F-14** | Duplicated delegation activation attempt | Attempt to spawn second container with same `delegationId`. | Single-writer mutex `.lock` already held. | Second spawn fails fast with `LockError`. | Cannot run two instances under same delegation. | **NO** | No |
| **F-15** | Replayed child receipt submitted to parent | Receipt hash already exists in parent ledger. | Parent checks historical receipt hashes. | Rejection with `DuplicateReceiptError`. | Cannot double-count completed tasks or budget. | **NO** | No |

---

## 3. CONCURRENCY & MULTI-AGENT RACE CONTROL

Multi-agent execution introduces concurrent process interactions. FORGE rejects "one giant global lock" in favor of mathematical domain partitioning:

```text
CONCURRENCY DOMAIN      PROTECTION MECHANISM                INVARIANT GUARANTEE
──────────────────────────────────────────────────────────────────────────────────
Workspace Storage       Sub-directory Partitioning          No file collisions
Budget Balances         Atomic Ledger Escrow                No double-spending
Task Scheduling         Single-Claim Task Locks             No duplicate task runs
Capability Dispatch     Atomic Pre-Dispatch Gate Check      No post-revocation runs
Journal Writes          Single-Host Mutex per Sub-Mission   No torn multi-writer files
```

### 3.1 Workspace Partitioning & Path Jails
- Each child agent operates inside a designated sub-workspace: `/workspace/subtasks/del_<id>/`.
- The container isolation driver mounts strictly this sub-directory as read-write.
- Parent workspace is mounted read-only (or entirely unmounted).
- Realpath resolution rejects any symlink attempting to escape to sibling or parent workspaces (FREEZE-003).

### 3.2 Atomic Task Claim Locks
When multiple child agents are active under a shared plan:
- A task can only be transitioned from `ready` to `running` via an atomic compare-and-swap (CAS).
- If Child $C_1$ claims Task $T_1$, $T_1$'s claim lock binds to $C_1$.
- Any competing claim from Child $C_2$ fails immediately with `TaskAlreadyClaimedError`.

### 3.3 Atomic Pre-Dispatch Revocation Interception
To eliminate the race condition where a child dispatches a capability milliseconds before the parent's revocation signal arrives:
1. Capability Host enters critical dispatch seam.
2. Capability Host executes synchronous `checkGrantActive(grantId)`.
3. If `grant.revoked` exists in parent ledger:
   - Host aborts execution before subprocess spawn.
   - Capability returns `RevokedGrantError`.
   - Zero physical side effects occur.

---

*Authored by Principal Systems Architect & Security Engineering.*
