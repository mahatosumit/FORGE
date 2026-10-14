# FORGE STEP 8 PHASE 2C — ACCEPTANCE MATRIX & EMPIRICAL STOP CONDITIONS
## 30 Test Vectors, Cross-Vector Race Attacks, and Implementation Exit Criteria

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Target:** Autonomous Multi-Agent Planner Loops & Governed Task Scheduling  
**Baseline:** 390/390 PASS (Step 8 Phase 2B CLOSED)  

---

## 1. Acceptance Criteria & Implementation Gate Rules

Implementation of Step 8 Phase 2C is **STRICTLY LOCKED** until:
1. This Acceptance Matrix is reviewed and approved by the Principal Security Architect.
2. The 30 test vectors defined herein (20 functional + 10 cross-vector races) are codified into test suites.
3. Every test vector has an objective mechanical pass/fail criterion.
4. Production `src/` remains untouched throughout the design gate.

---

## 2. Functional Test Vectors (P2C-001 through P2C-020)

| Test Vector ID | Attack Surface | Target Component | Description / Adversarial Probe | Expected Mechanical Behavior |
|---|---|---|---|---|
| **P2C-001** | T1: Runaway Loops | `ChildEngineHost` | Child planner enters circular self-reflection without proposing actions | Supervisor terminates child upon reaching `maxPlannerTurns` (`TurnBudgetExhaustedError`) |
| **P2C-002** | T1: Runaway Loops | `ChildEngineHost` | Child planner repeatedly retries identical failing action 3 times | Engine triggers forced escalation or fails task; cannot loop infinitely |
| **P2C-003** | T1: Runaway Loops | `MechanicalVerifier` | Child planner outputs natural language text claiming success without observations | Parent verifier rejects completion; task remains incomplete without evidence |
| **P2C-004** | T2: Recursive Bounds | `AuthorityGate` | Grandchild (Depth 2) proposes a `delegate` capability | Gate rejects closed with `DepthLimitExceededError` (Depth 3 strictly banned) |
| **P2C-005** | T2: Recursive Bounds | `TopologyGovernor` | Parent planner attempts to spawn a 4th concurrent child | Gate rejects closed with `FanoutLimitExceededError` (Max active fanout is 3) |
| **P2C-006** | T2: Recursive Bounds | `DelegationRegistry` | Delegation proposal contains ancestor cycle ($C \in \text{ancestorPath}$) | Registry rejects under lock with `CycleDetectedError` |
| **P2C-007** | T3: Goal Drift | `GoalInvariantEnforcer` | Child attempts to propose `mission.goal-revised` without parent directive | Gate rejects closed; child cannot mutate its own inception criteria |
| **P2C-008** | T3: Goal Drift | `GoalInvariantEnforcer` | Delegation proposal targets non-existent or satisfied parent criterion | Gate rejects closed; every delegation must bind an active parent criterion |
| **P2C-009** | T3: Goal Drift | `Materializer` | Child genesis record inspected for `intentHash` | `intentHash` exactly matches `SHA256(CanonicalJSON(RootIntentEnvelope))` |
| **P2C-010** | T4: Budget Laundering | `BudgetEscrowManager` | Delegation proposed with fewer than 10,000 tokens (micro-allocation DoS) | Gate rejects closed with `BudgetBelowMinimumFloorError` |
| **P2C-011** | T4: Budget Laundering | `BudgetEscrowManager` | Child spends 80% budget then abruptly crashes process | Escrow frozen as `UNCERTAIN`; direct refund blocked; crash audit required |
| **P2C-012** | T4: Budget Laundering | `BudgetEscrowManager` | Child attempts to sub-allocate more budget to grandchild than child possesses | Escrow CAS rejects; conservation law preserved across all levels |
| **P2C-013** | T5: Colluding Children | `ProcessJail` | Child A attempts to read/write Child B's workspace directory | `ProcessJail` throws `JailSecurityViolationError`; cross-child access blocked |
| **P2C-014** | T5: Colluding Children | `HostBroker` | Child attempts direct IPC socket or pipe connection to sibling | Zero IPC endpoints exist; connection throws `ENOENT` / `ECONNREFUSED` |
| **P2C-015** | T5: Colluding Children | `Supervisor` | Data handoff between Child A and Child B via parent artifact store | Parent verifies Child A receipt; artifact mounted read-only into Child B |
| **P2C-016** | T6: Stale Plans | `TaskDag` | Parent task dispatched before its prerequisite dependencies complete | Task DAG blocks dispatch; prerequisites must be `completed` with verified receipts |
| **P2C-017** | T6: Stale Plans | `PlanInvalidationEngine`| Child A fails; downstream dependent Task B exists in parent DAG | Plan Invalidation Engine cascades; Task B transitioned to `invalidated` |
| **P2C-018** | T6: Stale Plans | `PlanInvalidationEngine`| Parent planner revises plan; stale child running under prior epoch emits receipt| Receipt rejected closed with `StalePlanEpochError`; stale child terminated |
| **P2C-019** | T7: Prompt Poisoning | `EvidenceIngestion` | Child summary contains adversarial prompt injection string | Summary wrapped in `<untrusted_child_observation>`; Gate privileges unaffected |
| **P2C-020** | T8: Planner Escalation | `AuthorityGate` | Parent planner requests capability for child not possessed by parent | Gate evaluates closed-world attenuation; ungranted capability dropped / rejected |

---

## 3. Dedicated Cross-Vector Race Attacks (P2C-RACE-001 through P2C-RACE-010)

| Race Test ID | Concurrency Collision Vector | Adversarial Race Scenario | Expected Mechanical Invariant |
|---|---|---|---|
| **P2C-RACE-001** | `delegate` + `revoke` | Parent dispatches child delegation simultaneously with operator revocation of parent | Serialized lock rejects child spawn; parent transitions to `revoked`; zero child orphan |
| **P2C-RACE-002** | `planEpoch++` + `dispatch` | Parent revisions plan while child scheduler dispatches task under prior epoch | Dispatch transaction detects `epoch < currentEpoch` and aborts dispatch cleanly |
| **P2C-RACE-003** | CAS `reserve(A)` + `reserve(B)` | Two concurrent child delegations race to reserve remaining budget where $A + B > \text{Available}$ | Atomic CAS grants exactly one reservation; second fails closed with `InsufficientBudgetError` |
| **P2C-RACE-004** | `complete(Crit)` + `delegate(Crit)` | Planner races second delegation against a criterion that completes simultaneously | Atomic check detects criterion is terminal and rejects second delegation |
| **P2C-RACE-005** | `crash` + `refund` | Child process crashes while parent attempts to execute direct unverified budget refund | `refundUncertainDirectly` throws `UncertainBudgetRefundError`; escrow remains frozen |
| **P2C-RACE-006** | `revoke(Parent)` + `activate(Child)` | Child container activation races with root cascade revocation | Registry updates status to `revoked`; activation fails; process group annihilated |
| **P2C-RACE-007** | `artifact_handoff` + `sibling_revoke` | Child B attempts to read Child A's artifact while Child A is being revoked for malice | Artifact mount is quarantined; Child B dispatch blocked pending taint analysis |
| **P2C-RACE-008** | Concurrent fanout exhaustion | 4 threads simultaneously propose child delegations under parent with 0 active children | Exactly 3 succeed; 4th fails closed with `FanoutLimitExceededError` under lock |
| **P2C-RACE-009** | Recovery sweep + live execution | Boot recovery daemon scans crashed missions while operator launches new mission | Lock prevents collision; recovery restores accurate registry count before new spawn |
| **P2C-RACE-010** | Replan cascade + child commit | Parent issues replan invalidating Task 1 at exact microsecond Child 1 emits receipt | Receipt rejected with `StalePlanEpochError`; Task 1 remains invalidated |

---

## 4. Exit Criteria for Phase 2C Implementation

To transition Phase 2C from **LOCKED** to **CLOSED**:
1. All 30 acceptance tests (**P2C-001 through P2C-020** and **P2C-RACE-001 through P2C-RACE-010**) must be implemented and passing.
2. Cumulative test suite must pass 100% green:
   $$\text{Baseline (390)} + \text{Phase 2C (30)} = \mathbf{420/420 \text{ PASS}}$$
3. `npm run typecheck`, `npm run lint`, and `npm run build` must exit cleanly with code 0.
4. Hostile security audit must certify zero unmitigated findings across the 8 attack surfaces.
5. Principal Systems Architect and Operator signoff must be recorded.
