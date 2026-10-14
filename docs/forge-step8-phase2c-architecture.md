# FORGE STEP 8 PHASE 2C — ARCHITECTURE SPECIFICATION
## Autonomous Multi-Agent Planner Loops & Governed Task Scheduling

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Baseline:** Step 8 Phase 1 (CLOSED), Phase 2A (CLOSED), Phase 2B (CLOSED — TESTED EXECUTION SURFACE, 390/390 PASS)  
**Security Invariant:** Governance precedes autonomy at every recursive level:
$$\text{PLANNER} \rightarrow \text{INTENT GATE} \rightarrow \text{AUTHORITY GATE} \rightarrow \text{HOST} \rightarrow \text{JAIL} \rightarrow \text{EVIDENCE} \rightarrow \text{LEDGER} \rightarrow \text{VERIFICATION} \rightarrow \text{STATE UPDATE} \rightarrow \text{PLANNER}$$

---

## 1. Mission & Architectural Problem Statement

Phase 2A established the formal delegation kernel and lifecycle registry. Phase 2B established the physical execution boundary, child host supervisor, and jail containment.

Phase 2C addresses the execution of **autonomous planner loops** across hierarchical agents:
- The parent agent runs an autonomous loop decomposing mission objectives into task DAGs.
- Sub-tasks are delegated to children, which instantiate their own independent autonomous loops.
- Children decompose sub-tasks, execute capability proposals inside physical jails, react to observations, and deliver receipts back to the parent.

To prevent cognitive divergence, runaway execution, economic laundering, and cross-agent poisoning, Phase 2C establishes a **Three-Tier Governance Architecture**:

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

## 2. Core Architectural Subsystems

### 2.1 Intent Envelope & Cryptographic Identity (`DR-01`)
The root mission intent is captured in an immutable, canonical **`IntentEnvelope`**:
- Encapsulates root goals, success criteria, verified harnesses, constraints, risk ceilings, and data policies.
- Derived via Canonical JSON (RFC 8785):
  $$\text{intentHash} = \text{SHA256}(\text{CanonicalJSON}(\text{IntentEnvelope}))$$
- Every child and grandchild inherits `intentHash` in its genesis record (`mission.opened`).
- Any mutation of intent hashes across the lineage is rejected closed.

### 2.2 Machine-Addressable Criteria State Machines (`DR-02`)
Criteria are machine-addressable objects rather than natural language prose:
- Explicit properties: `criterionId`, `intentHash`, `parentCriterionId`, `status`, `allowedContributionTypes`, `requiredEvidenceSchema`, `completionVerifier`, `immutableVersion`.
- Delegation proposals must specify `targetCriterionId`, matching `criterionVersion`, and a contribution type in `allowedContributionTypes`.
- Goal semantics are immutable; task decomposition is constrained within criterion boundaries.

### 2.3 Unified Concurrency Coordinator (`DR-03` & `DR-06`)
Delegation reservation is a **single atomic serialized transaction** under cross-process lock:
1. Validates parent delegation status (`active`).
2. Validates topology capacity ($D \le 2, F \le 3, N \le 10$).
3. Validates current plan epoch matches task epoch.
4. Validates target criterion status (`in_progress`) and version.
5. Executes multi-dimensional CAS budget reservation.
6. Commits delegation entry to registry.

### 2.4 Information Security Lattice & Declassification (`DR-04`)
Data and evidence artifacts are governed by a 6-level security lattice:
$$\text{PUBLIC} < \text{WORKSPACE} < \text{MISSION\_PRIVATE} < \text{CHILD\_PRIVATE} < \text{SECRET} < \text{EXTERNAL}$$
- Information flow is restricted: $L_{\text{source}} \le L_{\text{dest}}$.
- Child-private data cannot flow to sibling workspaces.
- Declassification of child data requires passing an explicit Mechanical Declassification Filter (credential regex scan + schema check).
- Direct IPC between siblings is prohibited; all flow transits through parent-verified read-only artifact mounts.

### 2.5 Dual-Check Prompt Injection Defense (`DR-05`)
- Authorization $\neq$ Goal Correctness.
- Prompt injections attempting authorized misuse are stopped at the **Tier 1 Intent Gate** before reaching the Authority Gate.
- All child natural language outputs are wrapped in `<untrusted_child_observation>` tags and treated as inert data, stripped of system instructions.

### 2.6 Comprehensive Planner Runaway Controls (`DR-09`)
Beyond turn limits, autonomous loops are bounded by objective operational ceilings:
- `maxPlannerTurns` (e.g. 25 turns)
- `maxTaskActions` (e.g. 50 actions)
- `maxProposalCount` (e.g. 100 proposals)
- `maxVerificationAttempts` (e.g. 5 attempts)
- `maxRetriesPerTask` (e.g. 3 retries)
- `maxReplans` (e.g. 3 plan revisions)
- `maxModelTokens` & `maxWallClockMs`
- Monotonic progress metric: 3 consecutive turns without capability proposals or criterion evaluation triggers forced escalation or task termination.

### 2.7 Atomic Dispatch Epoch Barrier (`DR-10`)
Plan epoch and revocation status are validated **inside the dispatch transaction immediately before physical execution**. If the plan epoch was incremented while a task was queued, the task is immediately invalidated and aborted.

### 2.8 Lifecycle Creation Closure (`DR-07`)
Topology bounds ($D \le 2, F \le 3, N \le 10$) are enforced across **all agent creation vectors**:
- `planner -> delegate`
- `planner -> retry`
- `recovery -> boot sweep`
- `checkpoint -> restore`
Terminal delegations (`completed`, `failed`, `revoked`, `cancelled`) are permanently immutable and cannot be resurrected.

---

## 3. Implementation Gate

This architecture represents the **Design Gate Specification** for Step 8 Phase 2C.
**Implementation in `src/` remains STRICTLY LOCKED** pending formal operator review.
