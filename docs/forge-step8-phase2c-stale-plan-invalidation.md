# FORGE STEP 8 PHASE 2C — STALE PLAN INVALIDATION & DISPATCH RACE SPECIFICATION
## Epoch-Bound Plan Progression, Atomic Dispatch Transactions, and Cascade Invalidation

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Security Invariant:** Downstream tasks cannot execute against invalid, revoked, or stale predecessor states:
$$\forall T_j \succ T_i, \quad \text{Status}(T_i) \neq \text{"completed"} \implies \text{Status}(T_j) \in \{\text{"blocked"}, \text{"invalidated"}\}$$

---

## 1. Problem Statement: The Dispatch Race Window

In concurrent multi-agent systems, validating plan epochs during planning alone leaves a dangerous race window:
```text
Task T2 planned under epoch 1
          ↓
Scheduler selects T2
          ↓ (scheduler delay / queueing)
Parent planner revisions plan: epoch -> 2
          ↓
Scheduler dispatches T2 under epoch 1!
```
If epoch validation only occurs when the task is added to the DAG, a delayed dispatch can execute an obsolete task after the plan has changed.

To eliminate this vulnerability:
> **Plan epoch validation must occur inside the final dispatch authorization transaction immediately before physical capability execution.**

---

## 2. Atomic Dispatch Transaction Architecture (`DR-06` & `DR-10`)

```
                           SCHEDULER SELECTS TASK T_j
                                        │
                                        ▼
             [Acquire Cross-Process Lock: task-dispatch-tx]
                                        │
                        ┌───────────────┴───────────────┐
                        ▼                               ▼
                 Check Plan Epoch               Check Prereq State
                 • Current Epoch == Task Epoch?  • All dependencies completed?
                 • If NO: ABORT & INVALIDATE    • If NO: ABORT & BLOCK
                        │                               │
                        └───────────────┬───────────────┘
                                        ▼
                            Check Lineage & Revocation
                            • Parent delegation active?
                            • Task not revoked?
                                        │
                        ┌───────────────┴───────────────┐
                        ▼ (Pass)                        ▼ (Fail)
                 Authorize Dispatch              Abort Dispatch
                 • Emit task.dispatched          • Mark invalidated
                 • Release Lock                  • Terminate child process
                 • Launch Jail Execution         • Release Lock
                        │                               │
                        ▼                               ▼
                 PHYSICAL EXECUTION              CLEAN ROLLBACK
```

---

## 3. Invalidation Mechanisms

### 3.1 Strict Dependency Barriers
In the parent task DAG:
- A task $T_j$ with dependencies $\{T_1, \dots, T_k\}$ remains in state `blocked`.
- $T_j$ **cannot transition to `ready` or `dispatched`** until:
  $$\forall T_i \in \text{Dependencies}(T_j), \quad \text{Status}(T_i) = \text{"completed"} \land \text{ReceiptVerified}(T_i) = \text{true}$$
- If any dependency $T_i$ transitions to `failed`, `revoked`, `crashed`, or `cancelled`:
  $$T_j \leftarrow \text{"invalidated"}$$

### 3.2 Plan Revision Epoch Invalidation (`planEpoch`)
Plans are versioned with monotonically increasing integers:
1. Every child delegation contract records `planEpoch` at issuance.
2. If the parent planner emits a `plan.proposed` or `mission.goal-revised` record:
   - The parent increments `planEpoch`.
   - The Host Supervisor immediately performs a **Stale Delegation Cancellation Sweep**:
     - All active child delegations where $\text{child}.\text{planEpoch} < \text{parent}.\text{planEpoch}$ are transitioned to `cancelled`.
     - Supervisor terminates their physical process trees via `ProcessTreeDriver.killProcessTree()`.
     - Their escrows are audited and settled cleanly.
3. If a stale child attempts to deliver a receipt after plan revision, the receipt is rejected closed with `StalePlanEpochError`.

### 3.3 Cascade Invalidation Propagation
When a parent task fails or its child delegation is revoked:
```typescript
class PlanInvalidationEngine {
  static cascadeInvalidate(
    failedTaskId: TaskId,
    dag: TaskDag,
    supervisor: MultiAgentSupervisor,
  ): TaskId[] {
    const invalidated: TaskId[] = [];
    const queue = [failedTaskId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = dag.getDirectDependents(current);

      for (const dep of dependents) {
        if (dag.getStatus(dep) !== "invalidated" && dag.getStatus(dep) !== "completed") {
          dag.setStatus(dep, "invalidated");
          invalidated.push(dep);
          queue.push(dep);

          // Terminate active child delegation immediately
          const activeDelId = dag.getActiveDelegation(dep);
          if (activeDelId) {
            supervisor.revokeChild(activeDelId, `Dependency task ${current} failed`, "cascade");
          }
        }
      }
    }

    return invalidated;
  }
}
```

---

## 4. Formal Invariants

| ID | Rule | Description |
|---|---|---|
| **INV-43.1** | **Strict Dependency Barrier** | A task cannot be dispatched until all direct dependencies are `completed` with verified receipts. |
| **INV-43.2** | **Dispatch Epoch Check** | Plan epoch validation is executed inside the final dispatch authorization transaction under lock. |
| **INV-43.3** | **Cascade Invalidation Sweep** | Predecessor failure immediately invalidates all downstream reachable tasks in the DAG. |
| **INV-43.4** | **Orphan Annihilation** | Any active process tree associated with an invalidated task is terminated within 300ms. |
