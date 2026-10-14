# FORGE STEP 8 PHASE 2C — ADVERSARIAL DESIGN REVIEW & HARDENING SPECIFICATION
## Comprehensive Architecture Remediation for Autonomous Multi-Agent Planner Loops

**Status:** DESIGN HARDENING (Implementation STRICTLY LOCKED)  
**Evaluator:** Principal Systems Architect & Hostile Security Auditor  
**Scope:** Remediating the 10 Critical Flaws in the Initial Phase 2C Design Gate  
**Baseline:** Step 8 Phase 1 (CLOSED), Phase 2A (CLOSED), Phase 2B (CLOSED — TESTED EXECUTION SURFACE, 390/390 PASS)  

---

## 1. Executive Summary & Architectural Paradigm Shift

The initial design for Phase 2C correctly identified the 8 threat surfaces of autonomous multi-agent planning. However, the adversarial design review identified a critical architectural flaw:
> **Several key security claims transitioned from "mechanically enforceable" to "semantically assumed" at the exact boundaries where autonomous LLM planners become dangerous.**

Specifically:
1. Goal subsumption relied on natural language explanations rather than machine-addressable criterion objects.
2. `RootGoalHash` anchored prose, not constraints, risk ceilings, or data policies.
3. Information flow relied on cryptographic hashes, which guarantee integrity but not confidentiality or non-interference.
4. Authority Gate checks were conflated with intent checks, leaving the system vulnerable to prompt injections that induce authorized capability misuse.
5. Concurrency checks across budget, topology, epochs, and dispatch lacked a unified serialized authorization transaction.
6. Topology bounds were enforced on `delegate`, but lacked formal closure across recovery, resume, and checkpoint restore paths.

This document formalizes the **8 Mandatory Design Hardening Specifications (DR-01 through DR-08)** required to make Phase 2C mathematically sound and mechanically enforceable before any production code is written.

---

## 2. The Three-Tier Execution Pipeline

The core governance pipeline of FORGE is upgraded from a 2-tier check (`Planner -> Gate -> Effect`) to a **3-tier mechanical execution pipeline**:

```
                              AUTONOMOUS PLANNER PROPOSAL
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: INTENT GATE (Goal Consistency & Semantic Anchoring)                            │
│ • Validates proposal against immutable IntentEnvelope and active Criterion state       │
│ • Verifies contribution type is in criterion.allowedContributionTypes                  │
│ • Blocks authorized capability misuse induced by prompt injection                      │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ PASS
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 2: AUTHORITY GATE (Lineage, Attenuation & Concurrency CAS)                         │
│ • Closed-world capability attenuation: Requested ⊆ EffectiveEnvelope(Parent)           │
│ • Lineage active, ancestor acyclic, epoch authoritative                                │
│ • Atomic serialized transaction: CAS budget + CAS topology (D≤2, F≤3, N≤10) + epoch   │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ ALLOW
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 3: PHYSICAL EXECUTION BOUNDARY (Jail & Information Flow Labeling)                 │
│ • Workspace containment, path normalization, dropped capabilities, scrubbed env        │
│ • Information flow security labels (PUBLIC..SECRET) and declassification barriers      │
│ • ProcessTreeDriver confinement and bounded termination                                │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ DISPATCH
                                           ▼
                                 PHYSICAL EFFECT EXECUTION
```

---

## 3. Mandatory Remediation Specifications

### DR-01: The Intent Envelope & Cryptographic Identity Anchor

#### 1. Flaw in Previous Design
Hashing only `RootMission.goalSpec` protected textual summary integrity but failed to anchor operational constraints, budgets, data policies, or risk ceilings. An attacker could alter the constraint context while retaining a matching goal hash.

#### 2. Hardened Specification
We define the canonical, immutable **`IntentEnvelope`**:
```typescript
interface IntentEnvelope {
  schemaVersion: 1;
  rootMissionId: MissionId;
  rootGoal: {
    summary: string;
    description: string;
  };
  successCriteria: Array<{
    criterionId: CriterionId;
    description: string;
    completionVerifier: {
      type: "command" | "test_suite" | "file_hash" | "schema" | "regex";
      target: string;
      expectedOutputHash?: Sha256Hex;
    };
  }>;
  constraints: {
    riskCeiling: "read" | "write" | "admin";
    allowedOutputClasses: string[];
    bannedPatterns: string[];
    maxTotalWallClockMs: number;
    maxTotalTokens: number;
    dataPolicy: "isolated" | "airgapped" | "restricted_egress";
  };
  policyEngineVersion: string;
}
```

The immutable cryptographic intent fingerprint is derived via Canonical JSON (RFC 8785):
$$\text{intentHash} = \text{SHA256}(\text{CanonicalJSON}(\text{IntentEnvelope}))$$

#### 3. Inheritance Rule
Every child, grandchild, and recovered mission inherits the exact `intentHash` in its genesis record. If a child genesis record contains an `intentHash` differing by even 1 bit from its parent, the Authority Gate rejects initialization with `IntentHashMismatchError`.

---

### DR-02: Mechanical Criterion Binding & Subsumption

#### 1. Flaw in Previous Design
The design claimed "Criterion Subsumption Proof" but evaluated natural language rationale strings. An LLM could generate plausible prose claiming a task contributes to a criterion when it actually diverged or diluted the goal.

#### 2. Hardened Specification
Criteria are transformed from prose into **machine-addressable state machines**:
```typescript
interface Criterion {
  criterionId: CriterionId;
  intentHash: Sha256Hex;
  parentCriterionId: CriterionId | null;
  status: "pending" | "in_progress" | "satisfied" | "failed" | "invalidated";
  allowedContributionTypes: Array<"code_mutation" | "test_verification" | "artifact_generation" | "analysis_report">;
  requiredEvidenceSchema: string; // JSON Schema ref for evidence artifact
  completionVerifier: {
    type: "test_exit_code" | "schema_validation" | "sha256_match" | "ast_query";
    harnessPath: string;
    expectedExitCode?: number;
    expectedHash?: Sha256Hex;
  };
  immutableVersion: number;
}
```

When a parent planner proposes delegation, it must provide a **structural delegation spec**:
```typescript
interface DelegationProposalArgs {
  targetCriterionId: CriterionId;
  criterionVersion: number;
  contributionType: "code_mutation" | "test_verification" | "artifact_generation" | "analysis_report";
  requestedEnvelope: EffectiveAuthorityEnvelope;
  allocatedBudget: DelegationBudget;
}
```

#### 3. Gate Mechanical Verification
The Tier 1 Intent Gate mechanically evaluates:
1. `parentCriterionId` exists in parent's active stage criteria set.
2. `criterion.intentHash === parent.intentHash`.
3. `criterion.status === "pending"` or `"in_progress"`.
4. `proposal.criterionVersion === criterion.immutableVersion` (blocks TOCTOU modification).
5. `proposal.contributionType ∈ criterion.allowedContributionTypes`.
6. Child goal does NOT create new sub-criteria that mutate parent criteria semantics. Task decomposition is allowed; **semantic criterion mutation is mechanically impossible**.

---

### DR-03: Decoupled Budget Proof & Serialized Transaction

#### 1. Flaw in Previous Design
Claimed that a 10,000-token floor capped delegations to $\le 100$ without bounding total budget. Furthermore, concurrent planner turns could read available budget simultaneously and over-allocate tokens.

#### 2. Hardened Specification
We decouple and independently prove:
1. **Topology Bound:** $D \le 2$, $F \le 3$, $N \le 10$.
2. **Budget Bound:** $\text{sum}(\text{Escrow}) + \text{sum}(\text{Consumed}) + \text{Available} = \text{TotalLimit} \land \text{Available} \ge 0$.
3. **Minimum Escrow Floor:** $\text{Tokens}_{\text{min}} = 10,000$.

#### 3. Serialized Authorization Transaction (`reserveTransaction`)
Budget reservation, topology slot acquisition, and plan epoch validation are unified into a single atomic critical section protected by cross-process mutex:
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

### DR-04: Information Security Labels & Governed Declassification

#### 1. Flaw in Previous Design
Hashing output artifacts provided integrity but zero confidentiality or flow control. The parent broker acted as a universal declassification oracle, allowing Child A's private secrets to be passed to Child B.

#### 2. Hardened Specification
We define a 6-level **Security Lattice** for all data and evidence artifacts:
$$\text{PUBLIC} < \text{WORKSPACE} < \text{MISSION\_PRIVATE} < \text{CHILD\_PRIVATE} < \text{SECRET} < \text{EXTERNAL}$$

```typescript
type SecurityLabel =
  | "PUBLIC"          // Unrestricted documentation / logs
  | "WORKSPACE"       // Mission workspace code and test files
  | "MISSION_PRIVATE" // Mission configuration and plan state
  | "CHILD_PRIVATE"   // Child-local intermediate scratchpads and private logs
  | "SECRET"          // API keys, credentials, tokens
  | "EXTERNAL";       // Untrusted data ingested from internet/git
```

#### 3. Information Flow Policy Rules
Information may only flow upwards or within equal labels ($L_1 \le L_2$):
1. **CHILD_PRIVATE Isolation:** Artifacts labeled `CHILD_PRIVATE` cannot be mounted into sibling workspaces or ingested into parent prompts.
2. **SECRET Confinement:** Secrets cannot flow into artifacts or model prompts without redaction.
3. **Declassification Authority:** The parent cannot declassify `CHILD_PRIVATE` to `WORKSPACE` unless the artifact passes an explicit **Mechanical Declassification Filter** (verifying zero secrets, regex credential scan, and output schema validation).
4. **EXTERNAL Tainting:** Any data ingested from web/network is labeled `EXTERNAL` (tainted). Tainted data cannot be written to executable files without passing an AST sanitizer.

---

### DR-05: Dual Intent & Authority Verification (Prompt Injection Defense)

#### 1. Flaw in Previous Design
Assuming Authority Gate protection prevents prompt injection attacks is false. An injection can trick the planner into executing an action that is *authorized* by the gate but *contrary to intent* (e.g. wiping the repository when `fs: write` is authorized).

#### 2. Hardened Specification
Every proposal undergoes **Dual Verification**:
1. **Tier 1 (Intent Policy Verifier):**
   - Is this capability action authorized for this specific active `Criterion`?
   - Example: If active criterion is `C_lint`, an action proposing `fs: rm` on `package.json` is rejected by the Intent Gate because file deletion is not in `C_lint.allowedActions`.
   - Structural AST diff checking: Mutations must match the criterion's declared contribution scope.
2. **Tier 2 (Authority Gate):**
   - Does the agent possess the cryptographic capability grant within its closed-world envelope?
3. **Tagged Untrusted Observation Wrapper:**
   - Child outputs are ingested into parent prompts as inert data blocks. Ingestion filters strip system directive syntax (`SYSTEM:`, `[ADMIN]`, `BEGIN INSTRUCTION`).

---

### DR-06: Unified Dispatch Race Model

#### 1. Flaw in Previous Design
Validating plan epoch during planning allows a scheduler delay to dispatch a stale task after the plan has revised.

#### 2. Hardened Specification
Plan epoch and revocation status are validated **inside the dispatch transaction immediately before physical execution**:
```
Scheduler selects Task T2
          │
          ▼
┌──────────────────────────────────────────────┐
│ ATOMIC DISPATCH TRANSACTION (Under Lock)     │
│ 1. Current Plan Epoch == T2.planEpoch?       │
│    NO  ──▶ INVALIDATE T2 (Abort dispatch)    │
│    YES ──▶ Continue                          │
│ 2. Delegation Status == "active"?            │
│    NO  ──▶ REJECT (Delegation revoked/dead)  │
│    YES ──▶ Continue                          │
│ 3. Prerequisite Receipts Still Valid?        │
│    NO  ──▶ REJECT (Dependency tainted)       │
│    YES ──▶ DISPATCH EXECUTION                │
└──────────────────────────────────────────────┘
          │
          ▼
Physical Execution inside Jail
```

---

### DR-07: Lifecycle Creation Closure (Covering All Paths)

#### 1. Flaw in Previous Design
Topology bounds were checked on `delegate` proposals, but could be bypassed during crash recovery, state resurrection, checkpoint restore, or retries.

#### 2. Hardened Specification
Every code path that transitions an agent to `active` or `authorized` must call `TopologyGovernor.assertCapacity()`:
1. `delegate` proposal dispatch $\rightarrow$ asserts $D \le 2, F \le 3, N \le 10$.
2. Task retry dispatch $\rightarrow$ asserts $D \le 2, F \le 3, N \le 10$.
3. Crash recovery boot sweep $\rightarrow$ asserts global $N \le 10$; if $N > 10$, lowest-priority tasks are placed in `paused`.
4. Checkpoint resume $\rightarrow$ asserts $D \le 2, F \le 3, N \le 10$.
5. **Non-Resurrection Invariant:** Terminal statuses (`completed`, `failed`, `revoked`, `cancelled`) are permanently immutable. No recovery daemon or checkpoint can resurrect a terminated child.

---

### DR-08: The Dedicated Cross-Vector Race Suite (P2C-RACE-001 through P2C-RACE-010)

In addition to the 20 functional vectors (`P2C-001` through `P2C-020`), Phase 2C defines **10 dedicated adversarial race test vectors**:

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

## 4. Formal Review Verdict & Gate Posture

```text
STEP 8 MULTI-AGENT AUTHORITY ARCHITECTURE
│
├── Phase 1 — Delegation Kernel
│   └── CLOSED ✅
│
├── Phase 2A — Delegation Lifecycle
│   └── CLOSED ✅
│
├── Phase 2B — Host Supervisor / Physical Boundary
│   └── CLOSED — TESTED EXECUTION SURFACE ✅ (390 tests)
│
└── Phase 2C — Autonomous Multi-Agent Planner Loops
    ├── Architecture Specification ................ REVISED (3-Tier Pipeline)
    ├── Threat Model .............................. REVISED (Dual Verification)
    ├── Goal Drift Protocol ....................... REVISED (Machine-Addressable Criteria)
    ├── Topology Governance ....................... REVISED (Creation Path Closure)
    ├── Budget Amplification Defense .............. REVISED (Decoupled CAS Proof)
    ├── Information Flow Control .................. REVISED (Lattice Security Labels)
    ├── Invalidation Engine ....................... REVISED (Atomic Dispatch Epoch Barrier)
    ├── Design Review Specification ............... COMPLETE (DR-01 through DR-08)
    ├── Acceptance Matrix (30 Vectors) ............ EXPANDED (P2C-001..020 + RACE-001..010)
    └── Implementation Gate ....................... STRICTLY LOCKED 🔒
```

**Design Gate Signoff:**  
The architectural ambiguities have been resolved. Semantic assumptions have been replaced with mechanical data models, security lattices, and serialized atomic transactions. Phase 2C is ready for design freeze. **Implementation remains strictly locked.**
