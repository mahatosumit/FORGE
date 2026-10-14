# FORGE STEP 8 PHASE 2C — BUDGET CONSERVATION & CONCURRENCY TRANSACTION SPECIFICATION
## Decoupled Topology, Conservation Governor, and Atomic Reservation Transactions

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Security Invariant:** Total budget is strictly conserved; speculative creation or laundering of tokens is mathematically impossible:
$$\text{TotalLimit} = \text{Consumed}_P + \sum_{c \in \text{Children}} \text{Escrow}_c + \text{Available}_P \quad \land \quad \text{Available}_P \ge 0$$

---

## 1. Problem Statement: Decoupling Bounds from Policy

In the initial design, the micro-allocation floor ($10,000$ tokens) was incorrectly conflated with the fork-bomb defense, claiming it capped delegations to $\le 100$. However:
- If a mission has 10,000,000 tokens, a 10k floor permits 1,000 delegations.
- Minimum escrow is a **micro-allocation anti-DoS policy**, not the primary topological fork-bomb bound.
- Concurrency races between simultaneous planner turns can read `Available` simultaneously and over-allocate budget unless reservations are executed as a single atomic transaction.

To achieve mathematical rigor, Phase 2C **decouples and independently proves**:
1. **Topology Bounds** (physical hierarchy limits).
2. **Budget Bounds** (conservation law).
3. **Minimum Escrow Floor** (micro-allocation threshold).
4. **Atomic Reservation Transaction** (concurrency safety).

---

## 2. Decoupled Mathematical Invariants

### 2.1 Independent Topology Bound Proof
Hierarchy expansion is bounded independently of token count:
- $\text{ActiveAgents}_{\text{global}} \le 10$
- $\text{ActiveChildren}(p) \le 3$
- $\text{Depth}(a) \le 2$
$$\text{Max Active Agents at any instant} \le \min(1 + 3 + 9, 10) = 10$$
This holds whether the mission has 1,000 tokens or 100,000,000 tokens.

### 2.2 Independent Conservation Law Proof
At any point in time $t$, across all depths:
$$\text{TotalLimit} = \text{Consumed}_{\text{Root}} + \sum_{d \in \text{AllActiveEscrows}} d.\text{escrowed} + \sum_{s \in \text{SettledDescendants}} s.\text{consumed} + \text{Available}_{\text{Root}}$$
$$\text{Available}_{\text{Root}} \ge 0 \quad \text{at all times}$$
Any state where $\text{Available}_{\text{Root}} < 0$ is an immediate invariant violation halting runtime execution.

### 2.3 Independent Minimum Escrow Floor
To prevent micro-delegations that exhaust file handles, registry entries, and IPC slots:
$$\text{Tokens}_{\text{escrow}} \ge 10,000$$
Any delegation proposal requesting $< 10,000$ tokens is rejected closed by the Gate with `BudgetBelowMinimumFloorError`.

---

## 3. Serialized Atomic Authorization Transaction (`DR-03` & `DR-06`)

To eliminate TOCTOU races where two concurrent planner turns simultaneously observe available budget and over-commit funds, delegation authorization is unified into an **atomic serialized critical section**:

```
                          RESERVATION TRANSACTION REQUEST
                                         │
                                         ▼
                      [Acquire Cross-Process Lock: delegation-reserve-tx]
                                         │
                         ┌───────────────┴───────────────┐
                         ▼                               ▼
                 Check Topology                   Check Plan Epoch
                 • Depth <= 1                     • Current Epoch == Task Epoch
                 • Fanout < 3                     • Prerequisites Completed
                 • Global N < 10                         │
                         │                               │
                         └───────────────┬───────────────┘
                                         ▼
                               Check Target Criterion
                               • Status == in_progress
                               • Version == criterionVersion
                                         │
                                         ▼
                               Atomic CAS Budget Check
                               • maxTokens <= Available.maxTokens
                               • maxCalls <= Available.maxCalls
                               • maxTime <= Available.maxTime
                               • maxBytes <= Available.maxBytes
                                         │
                         ┌───────────────┴───────────────┐
                         ▼ (Pass)                        ▼ (Fail)
                 Commit Reservation               Rollback Cleanly
                 • Decrement Available            • Release Lock
                 • State = ESCROWED               • Throw Typed Error
                 • Register in Registry                  │
                 • Release Lock                          ▼
                         │                        REJECTED CLOSED
                         ▼
                  COMMIT SUCCESS
```

```typescript
class GovernedReservationCoordinator {
  static async executeReservationTransaction(
    parentDelegationId: DelegationId,
    request: DelegationReservationRequest,
    registry: DelegationRegistry,
    budgetManager: BudgetEscrowManager,
    taskDag: TaskDag,
  ): Promise<ReservationCommit> {
    return withCrossProcessLock(registry.lockDir, "delegation-reserve-tx", async () => {
      // 1. Validate Parent State & Lineage
      const parent = registry.getDelegation(parentDelegationId);
      if (!parent || parent.status !== "active") throw new InvalidParentStateError();

      // 2. Validate Topology Invariants (DR-07)
      if (parent.depth >= 2) throw new DepthLimitExceededError(parent.depth);
      if (registry.getActiveChildCount(parentDelegationId) >= 3) throw new FanoutLimitExceededError();
      if (registry.getActiveAgentCount() >= 10) throw new GlobalConcurrencyLimitError();

      // 3. Validate Plan Epoch & DAG Barrier (DR-06 & DR-08)
      if (request.planEpoch !== taskDag.currentEpoch) throw new StalePlanEpochError();
      if (!taskDag.arePrerequisitesCompleted(request.taskId)) throw new DependencyUnsatisfiedError();

      // 4. Validate Criterion State (DR-02)
      const crit = taskDag.getCriterion(request.targetCriterionId);
      if (!crit || crit.status !== "in_progress" || crit.immutableVersion !== request.criterionVersion) {
        throw new InvalidCriterionStateError();
      }

      // 5. Atomic Multi-Dimension CAS Budget Reservation (DR-03)
      const res = budgetManager.atomicReserveEscrow(request.delegationId, request.budget);
      if (!res.ok) throw new InsufficientBudgetError(res.errorDimension!, 0, 0);

      // 6. Register Delegation
      const entry = registry.registerDelegation(request.entry);

      return { committed: true, entry, escrow: res };
    });
  }
}
```

---

## 4. Crash Accounting: S8-06 Strict Invariant

When an agent terminates unexpectedly, crashes, or is revoked:
1. State is immediately transitioned to `UNCERTAIN`.
2. Direct refund via `refundUncertainDirectly()` throws [`UncertainBudgetRefundError`](file:///d:/quack%20pro/forge/src/multi-agent/budget-escrow.ts#L23-L30).
3. The budget remains locked until the **Host Crash Audit Daemon** inspects the physical ledger journal:
   $$\text{AuditedConsumed} = \sum_{\text{journal}} \text{actualSpend}$$
   $$\text{Refundable} = \text{Escrowed} - \text{AuditedConsumed}$$
4. Only verified unspent tokens are re-credited to parent `Available`.

---

## 5. Formal Invariants

| ID | Rule | Description |
|---|---|---|
| **INV-40.1** | **Strict Conservation** | $\Delta \text{Available}_P + \Delta \text{Escrow} + \Delta \text{Consumed} = 0$ |
| **INV-40.2** | **Floor Bound** | $\text{Tokens}_{\text{escrow}} \ge 10,000$ |
| **INV-40.3** | **No Auto-Refund on Crash** | $\text{State} = \text{UNCERTAIN} \implies \text{Refund} = \text{BLOCKED}$ |
| **INV-40.4** | **Serialized Reservation** | Reservation occurs in a single cross-process critical section covering topology, epoch, criterion, and budget. |
