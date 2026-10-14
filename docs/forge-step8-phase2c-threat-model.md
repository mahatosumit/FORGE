# FORGE STEP 8 PHASE 2C — THREAT MODEL & ATTACK SURFACE SPECIFICATION
## Adversarial Threat Modeling for Autonomous Multi-Agent Planner Loops

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Security Mandate:** Confront, analyze, and mathematically block the 8 critical attack vectors of autonomous multi-agent planning.  

---

## 1. Executive Summary & Threat Landscape

In Phase 2C, the threat landscape expands beyond physical sandbox escapes into **cognitive, algorithmic, economic, and concurrency attack surfaces**. When LLM planners execute autonomously across recursive agent hierarchies, security failures emerge from **planner divergence, economic exhaustion, prompt poisoning, race conditions, and covert collusion**.

This document models the **8 Principal Attack Surfaces** of Phase 2C, incorporating the **DR-01 through DR-08 Hardening Specifications**.

---

## 2. The 8 Critical Attack Surfaces of Phase 2C

```
                                ┌─────────────────────────────────────────────────────┐
                                │             PHASE 2C ATTACK SURFACES                │
                                └──────────────────────────┬──────────────────────────┘
                                                           │
        ┌───────────────────────────┬──────────────────────┴─────┬───────────────────────────┐
        ▼                           ▼                            ▼                           ▼
[T1: Runaway Loops]        [T2: Recursive Fork Bombs]   [T3: Semantic Goal Drift]   [T4: Budget Laundering]
  • Infinite reflection      • Depth > 2 explosions       • Goal dilution             • Micro-escrows
  • Ungrounded criteria      • Fanout exhaustion          • Meaning subversion        • Crash resurrection
        │                           │                            │                           │
        ▼                           ▼                            ▼                           ▼
[T5: Colluding Children]   [T6: Stale Plan Poisoning]   [T7: Covert Info Leaks]     [T8: Planner Escalation]
  • Sibling state leak       • Tainted dependencies       • Prompt injection          • Tricking parent
  • Out-of-band signaling    • Desynchronized execution   • Untrusted observation     • Dynamic privilege creep
```

---

### Attack Surface T1: Autonomous Planner Behavior (Runaway & Ungrounded Loops)
- **Threat:** Planners spinning in circular reasoning, thrashing failing actions, constructing massive unexecutable task graphs, or claiming unverified success.
- **Hardened Countermeasures (DR-09, INV-36, INV-44):**
  - Multi-dimensional quotas: `maxPlannerTurns`, `maxTaskActions`, `maxProposalCount`, `maxVerificationAttempts`, `maxRetriesPerTask`, `maxReplans`, `maxModelTokens`, `maxWallClockMs`.
  - Monotonic Progress Rule: 3 consecutive turns without a proposal or criterion evaluation triggers forced escalation or task termination.
  - Zero Self-Certified Success: Planners cannot certify success via natural language; success is evaluated mechanically by the parent verifier harness.

---

### Attack Surface T2: Recursive Delegation & Topology Explosion (Fork Bombs)
- **Threat:** Uncontrolled agent tree branching, fork-bombs, memory/PID exhaustion, and delegation cycles.
- **Hardened Countermeasures (DR-03, DR-07, INV-37, INV-38):**
  - Hard Depth Bound: $D_{max} \le 2$ (Root = 0, Child = 1, Grandchild = 2). Grandchild proposals to delegate fail closed with `DepthLimitExceededError`. Depth 3 cannot exist.
  - Parent Fanout Bound: $F_{max} \le 3$ active children per parent under serialized lock.
  - Global Concurrency Ceiling: $N_{max} \le 10$ active agents across the entire host daemon.
  - Creation Path Closure: Bounds enforced across *all* creation vectors (`delegate`, `retry`, `recovery boot sweep`, `checkpoint restore`).
  - Graph Acyclicity Check: Ancestor path $\pi$ evaluated under lock; cycle detection throws `CycleDetectedError`.

---

### Attack Surface T3: Goal Drift & Semantic Dilution
- **Threat:** Gradual divergence from root intent through prompt re-interpretation down the hierarchy.
- **Hardened Countermeasures (DR-01, DR-02, INV-39):**
  - Canonical `IntentEnvelope`: Anchors root goals, success criteria, verifiers, risk ceilings, constraints, and data policy. Immutably hashed via RFC 8785: $\text{intentHash} = \text{SHA256}(\text{CanonicalJSON}(\text{IntentEnvelope}))$. Inherited across all descendants.
  - Machine-Addressable `Criterion` State Machines: Criteria are typed objects (`criterionId`, `intentHash`, `status`, `allowedContributionTypes`, `completionVerifier`, `immutableVersion`).
  - Structural Subsumption: Delegation must cite `targetCriterionId`, matching `criterionVersion`, and contribution type in `allowedContributionTypes`.
  - Immutability Barrier: Children cannot mutate their inception `goalSpec`.

---

### Attack Surface T4: Budget Amplification & Token Laundering
- **Threat:** Crash-and-refund token resurrection, micro-allocation DoS, and speculative retry debt.
- **Hardened Countermeasures (DR-03, S8-06, S8-10, INV-40):**
  - Strict Conservation Law: $\text{TotalLimit} = \text{Consumed}_P + \sum \text{Escrow}_c + \text{Available}_P$.
  - Mandatory Escrow Floor: Proposals requesting $< 10,000$ tokens fail closed with `BudgetBelowMinimumFloorError`.
  - Zero Auto-Refund on Crash: Abrupt death freezes escrow as `UNCERTAIN`. Direct refund throws `UncertainBudgetRefundError`. Settled strictly via host crash ledger audit.
  - Atomic Serialized CAS: Multi-dimensional reservation committed under cross-process lock.

---

### Attack Surface T5: Colluding Children & Covert Channels
- **Threat:** Sibling agents collaborating out-of-band to bypass mutual capability restrictions (e.g. file reader leaking to network sender).
- **Hardened Countermeasures (DR-04, INV-41):**
  - Star-Topology Brokerage: Direct IPC prohibited ($\text{Flow}(C_i \rightarrow C_j) = \emptyset$).
  - 6-Level Security Lattice: $\text{PUBLIC} < \text{WORKSPACE} < \text{MISSION\_PRIVATE} < \text{CHILD\_PRIVATE} < \text{SECRET} < \text{EXTERNAL}$.
  - Artifacts labeled `CHILD_PRIVATE` cannot be mounted into sibling workspaces.
  - Declassification requires explicit Mechanical Declassification Filter check.

---

### Attack Surface T6: Stale Plans & Concurrency Invalidation
- **Threat:** Downstream tasks executing against failed predecessor outputs, or children running under obsolete plan revisions.
- **Hardened Countermeasures (DR-06, DR-10, INV-43):**
  - Strict Dependency Barriers: Task cannot be dispatched until prerequisites are `completed` with verified receipts.
  - Cascade Invalidation Sweep: Dependency failure immediately cascades to downstream reachable tasks ($\text{Status} \leftarrow \text{invalidated}$).
  - Atomic Dispatch Epoch Barrier: Plan epoch checked inside the final dispatch transaction immediately before execution. If `currentEpoch > task.planEpoch`, execution is aborted cleanly.

---

### Attack Surface T7: Cross-Agent Information Flow & Prompt Poisoning
- **Threat:** Untrusted third-party prompt injection in child data hijacking parent planner reasoning.
- **Hardened Countermeasures (DR-04, DR-05, INV-42):**
  - Untrusted Observation Tagging: All natural language summaries from children wrapped in `<untrusted_child_observation>` tags and sanitized.
  - Dual Intent & Authority Gates: Authorization $\neq$ Goal Correctness. The Tier 1 Intent Gate checks whether proposed actions align with active criterion scope before Tier 2 Authority evaluation, blocking authorized capability misuse.

---

### Attack Surface T8: Planner-Induced Capability Escalation
- **Threat:** Autonomous planners dynamically requesting wider privileges for children than the parent possesses.
- **Hardened Countermeasures (DR-05, INV-28):**
  - Closed-World Attenuation Intersection: $\text{EffectiveEnvelope}(\text{Child}) = \text{ParentEnvelope} \cap \text{RequestedEnvelope}$.
  - Non-Escalation Axiom: Children can never exceed parent capabilities, risk ceilings, or path bounds. Out-of-bounds requests are rejected closed at Tier 2 Authority Gate.

---

## 3. Threat-to-Defense Mapping Matrix

| Threat Vector | Severity | Hardening Requirement | FORGE Invariant | Mechanical Defense Component |
|---|---|---|---|---|
| **T1: Runaway Loops** | HIGH | Multi-quota limits & non-LLM progress | **DR-09, INV-36, INV-44** | Hard operational ceilings, host mechanical verifier |
| **T2: Fork Bombs** | CRITICAL | Topology closure across all paths | **DR-03, DR-07, INV-37, 38** | $D \le 2, F \le 3, N \le 10$, creation path closure, cycle check |
| **T3: Goal Drift** | HIGH | Machine-addressable criteria | **DR-01, DR-02, INV-39** | Canonical `IntentEnvelope`, criterion state machine |
| **T4: Budget Laundering** | CRITICAL | Decoupled CAS & 10k token floor | **DR-03, S8-06, INV-40** | Serialized CAS transaction, mandatory floor, UNCERTAIN lock |
| **T5: Collusion** | HIGH | Security lattice & declassification | **DR-04, INV-41** | 6-level security lattice, mechanical declassification filter |
| **T6: Stale Plans** | MEDIUM | Atomic dispatch epoch validation | **DR-06, DR-10, INV-43** | Dispatch transaction epoch check, cascade invalidation |
| **T7: Prompt Poisoning** | HIGH | Dual Intent + Authority Gates | **DR-04, DR-05, INV-42** | Tier 1 Intent Gate + Tier 2 Authority Gate + tagged wrapper |
| **T8: Planner Escalation**| CRITICAL | Closed-world mathematical intersection | **DR-05, INV-28** | Mathematical subset check at Authority Gate |

---

## 4. Design Gate Conclusion

This threat model establishes that autonomous multi-agent planning can only be made safe when governed by **three independent mechanical tiers (Intent, Authority, Physical Isolation)** operating over **machine-addressable data structures under atomic serialized transactions**.

Phase 2C implementation cannot begin until these specifications are formally approved.
