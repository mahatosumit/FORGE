# FORGE STEP 8 — REMEDIATED RECOVERY & INCARNATION MODEL

**Document:** Formal Specification — Remediated Crash Recovery, Durable Incarnations & Checkpoint Revalidation  
**Status:** REMEDIATED ARCHITECTURAL SPECIFICATION  
**Version:** FORGE v1.3-remediated-recovery  
**Date:** 2026-10-07  
**Remediates:** Finding S8-05 (High), Finding S8-12 (Low)  
**Authors:** Principal Security Architect & Adversarial Engineering  

---

## 1. DURABLE MONOTONIC INCARNATION EPOCH (REMEDIATES S8-05)

Ephemeral UUIDs generated in memory provide zero durable anti-replay guarantees across process restarts. In the remediated architecture, agent identity incorporates a **Durable Monotonic Epoch Counter**:

$$\text{AgentIdentity} = \langle \text{agentId}, \text{missionId}, \text{delegationId}, \text{incarnationEpoch}, \text{parentAgentId} \rangle$$

### 1.1 Epoch Persistence & Incrementation
1. **Initial Creation:** When Child Agent $C$ is first spawned under Delegation $D$, `incarnationEpoch` is initialized to `1`.
2. **Crash / Restart Event:** If Child $C$'s container or process dies and is restarted by `ForgeRuntime`:
   - The host supervisor increments: `newEpoch = lastCommittedEpoch + 1`.
   - Appends `delegation.reincarnated { delegationId, oldEpoch, newEpoch, timestamp }` to the parent mission journal with `fsyncSync()`.
   - Updates the Central Delegation Registry entry: `entry.childIncarnationEpoch = newEpoch`.
3. **Mechanical Invalidation of Old Incarnations:**
   The host supervisor's Capability Host dispatcher enforces:
   $$\text{Assert}(\text{request}.\text{incarnationEpoch} === \text{registry}.\text{childIncarnationEpoch})$$
   Any proposal, capability dispatch, budget reservation, or receipt delivered with an epoch $< \text{currentEpoch}$ fails immediately with `StaleIncarnationEpochError`. Old tokens or replayed memory snapshots are mechanically dead.

---

## 2. CHECKPOINT RESTORATION AUTHORITY REVALIDATION (REMEDIATES S8-12)

### 2.1 The Checkpoint-Authority Separation Principle
$$\mathbf{CHECKPOINT\ \ne\ AUTHORITY}$$
A checkpoint captures snapshot state (completed milestone, DAG progress, intermediate workspace state). It **never grants, extends, or resurrects authority**.

### 2.2 Revalidation Procedure on Restore
When a parent or child mission restores from a checkpoint:

```text
                        RESTORE CHECKPOINT REQUEST
                                    │
                                    ▼
                     [Load Milestone & DAG State]
                                    │
                                    ▼
                     [QUERY DELEGATION REGISTRY]
                     Check: status, epoch, expiry
                                    │
               ┌────────────────────┴────────────────────┐
               ▼                                         ▼
      Authority Valid?                          Authority Invalid?
  (status: active, not expired)             (revoked, expired, overdrawn)
               │                                         │
               ▼                                         ▼
      RESUME EXECUTION                  HALT INTO NON-AUTHORIZED STATE
  (Continue DAG from checkpoint)            ("halted_grant_revoked" or
                                            "halted_grant_expired")
                                                         │
                                                         ▼
                                            CAPABILITY DISPATCH FORBIDDEN
```

1. **Query Authoritative Registry:** Look up `delegationId` in the Central Delegation Registry.
2. **Revocation Check:** If `entry.status === "revoked"`, the restored sub-mission enters terminal state `halted_grant_revoked`. Zero capabilities can be dispatched.
3. **Expiration Check:** If `entry.expiresAt !== null && Date.now() >= entry.expiresAt`, state transitions to `halted_grant_expired`.
4. **Epoch Check:** If `checkpoint.incarnationEpoch < registry.childIncarnationEpoch`, the restore operation must advance to the new epoch or abort.
5. **Budget Check:** Remaining unconsumed escrow is re-verified against the parent escrow balance.

---

## 3. REMEDIATED 16-SCENARIO CRASH RECOVERY MATRIX

| Scenario | Failure Point | Persisted Ledger Facts | Authoritative Recovery State | Allowed Actions | Forbidden Actions | Operator Ack? |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: |
| **F-01** | Parent crashes before child proposal | No delegation records | Parent restarts in `recovering` | Re-evaluate turn; propose child if needed | Cannot assume child exists | No |
| **F-02** | Parent crashes after `delegation.proposed` | `delegation.proposed` logged | Proposal pending Gate | Gate re-evaluates proposal against active grants | Cannot spawn child without authorization | No |
| **F-03** | Parent crashes after `delegation.authorized` | `delegation.authorized` committed | Escrowed pending spawn | Spawn container or cancel escrow | Cannot double-deduct budget | No |
| **F-04** | Parent crashes after child activated | `delegation.activated` in registry | Active child running | Re-attach to child lock / await receipt | Cannot spawn competing child | No |
| **F-05** | Child crashes during pure computation | Child journal mid-turn | Interrupted task reset | Re-read ledger context; re-reason | Cannot skip failed turn | No |
| **F-06** | Child crashes after non-idempotent effect | Dispatched, 0 observations | **`post-effect-unknown`** | Block auto replay; notify supervisor | **AUTO REPLAY FORBIDDEN** | **YES** |
| **F-07** | Child crashes before receipt generation | Tasks finished; no receipt | Tasks succeeded; receipt pending | Child generates receipt from verified tip | Cannot re-execute tasks | No |
| **F-08** | Child crashes after receipt generated | Receipt in child journal; uncommitted in parent | Uncommitted receipt | Parent verifies child chain and provenance | Cannot discard child work | No |
| **F-09** | Parent recovers while child is still alive | Child lock held; container running | Active child detected | Await receipt or query supervisor | Cannot kill healthy child | No |
| **F-10** | Child recovers after parent was revoked | Registry status = `revoked` | Child mission cancelled | Child cleans up local state and exits | Cannot dispatch capabilities | No |
| **F-11** | Root process crashes with tree active | Diverse mission journals | `bootRecoverySweep()` scan | Recovers tree in reverse order (leaves $\to$ root) | Cannot cross-contaminate | If in-flight |
| **F-12** | Corrupted record in parent journal | Hash chain broken | `JournalCorruptionError` | Quarantine mission; halt children | Cannot continue running | **YES** |
| **F-13** | Stale delegation lock held by dead child | Lock mtime $> 30\text{s}$; dead PID | Stale lock detected | Steal lock; audit journal via Crash Daemon | Cannot stall parent indefinitely | No |
| **F-14** | Duplicated delegation activation attempt | Mutex lock already held | Second spawn fails fast | Fail second attempt with `LockError` | Cannot run two instances | No |
| **F-15** | Replayed child receipt submitted | Receipt digest already in parent index | Duplicate detected | Reject with `DuplicateReceiptError` | Cannot double-count tasks | No |
| **F-16** | **Restore checkpoint under revoked grant** (S8-12) | Checkpoint valid; registry shows `revoked` | **`halted_grant_revoked`** | Audit logs; notify operator | **CANNOT DISPATCH ANY CAPABILITY** | No |

---

*Authored by Principal Security Architect & Adversarial Engineering.*
