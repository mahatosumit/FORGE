# FORGE STEP 8 PHASE 2C — GOAL DRIFT & INTENT ENVELOPE SPECIFICATION
## Machine-Addressable Criteria State Machines & Cryptographic Intent Anchoring

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Security Invariant:** Sub-goals must be mechanically anchored to immutable parent criteria:
$$\forall c \in \text{Children}, \quad c.\text{parentCriterionId} \in P.\text{activeCriteria} \land c.\text{intentHash} = P.\text{intentHash}$$

---

## 1. Problem Statement: Why Prose Rationale Is Not a Proof

In multi-agent systems where LLMs autonomously plan and decompose tasks, semantic drift cannot be prevented by asking the planner to "prove" or "explain" how a sub-task contributes to a parent goal.

If an LLM planner is asked:
> *"Does task 'research competitor X' contribute to criterion C3 'Identify three commercially viable alternatives'?"*

The LLM will invariably respond: *"Yes, researching competitor X contributes directly to identifying viable alternatives."*
Such text provides **zero mechanical guarantee** of semantic subsumption. It is merely a plausible linguistic justification.

To make goal anchoring mechanically enforceable:
1. Criteria must be **typed, machine-addressable state machines**, not prose strings.
2. The entire mission context must be anchored in a canonical **`IntentEnvelope`**, not just a single `goalSpec` string.
3. The Authority Gate must evaluate structural properties under lock, completely independent of planner-generated explanations.

---

## 2. The Canonical Intent Envelope (`DR-01`)

The root mission intent is encapsulated in a formal, canonical structure:
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

The cryptographic identity of the mission lineage is derived via Canonical JSON (RFC 8785):
$$\text{intentHash} = \text{SHA256}(\text{CanonicalJSON}(\text{IntentEnvelope}))$$

### Immutable Inheritance
- Every child, grandchild, and recovered agent inherits the identical `intentHash`.
- Genesis records (`mission.opened`) must include `intentHash`.
- Any mismatch between child `intentHash` and parent `intentHash` triggers immediate rejection with `IntentHashMismatchError`.

---

## 3. Machine-Addressable Criteria State Machines (`DR-02`)

Criteria are machine-addressable objects maintaining their own lifecycle:
```typescript
interface Criterion {
  criterionId: CriterionId;
  intentHash: Sha256Hex;
  parentCriterionId: CriterionId | null;
  status: "pending" | "in_progress" | "satisfied" | "failed" | "invalidated";
  allowedContributionTypes: Array<"code_mutation" | "test_verification" | "artifact_generation" | "analysis_report">;
  requiredEvidenceSchema: string;
  completionVerifier: {
    type: "test_exit_code" | "schema_validation" | "sha256_match" | "ast_query";
    harnessPath: string;
    expectedExitCode?: number;
    expectedHash?: Sha256Hex;
  };
  immutableVersion: number;
}
```

### Delegation Proposal Structural Spec
When a parent planner proposes to delegate a task, the proposal must provide exact machine keys:
```typescript
interface DelegationProposalArgs {
  targetCriterionId: CriterionId;
  criterionVersion: number;
  contributionType: "code_mutation" | "test_verification" | "artifact_generation" | "analysis_report";
  requestedEnvelope: EffectiveAuthorityEnvelope;
  allocatedBudget: DelegationBudget;
}
```

### Tier 1 Intent Gate Mechanical Verification
Before evaluating capability grants, the Intent Gate verifies under lock:
1. `parentCriterionId` exists in parent's active criteria set.
2. `criterion.intentHash === parent.intentHash`.
3. `criterion.status === "in_progress"`.
4. `proposal.criterionVersion === criterion.immutableVersion` (blocks TOCTOU modification).
5. `proposal.contributionType ∈ criterion.allowedContributionTypes`.
6. Child goal specification does NOT define criteria that re-interpret or weaken parent criteria.

### Semantic Immutability vs Task Decomposition
- **Goal Semantics:** Immutable throughout the mission hierarchy.
- **Task Decomposition:** Allowed only within the strict boundaries defined by `allowedContributionTypes` and verified by `completionVerifier`.

---

## 4. Mechanical Outcome Verification Over Planner Opinion

A child planner's belief that it succeeded is inadmissible:
1. When a child claims task completion, the parent runtime invokes the criterion's `completionVerifier`.
2. The verifier executes externally (e.g. running test harness, parsing schema, checking hashes) against the output artifacts cited in the receipt.
3. Only if the verifier returns exit code 0 / pass does the parent engine transition the criterion to `satisfied`.
4. If the check fails, the task is marked `failed` regardless of planner claims.

---

## 5. Formal Invariants

- **INV-39.1 (Intent Envelope Invariance):**
  $$\forall d \in \text{Descendants}(M_{\text{root}}), \quad d.\text{intentHash} = \text{SHA256}(\text{CanonicalJSON}(M_{\text{root}}.\text{IntentEnvelope}))$$
- **INV-39.2 (Criterion Lineage Monotonicity):** Every child delegation must bind directly to an active parent criterion with matching version.
- **INV-39.3 (Zero Self-Certified Success):** Success is certified exclusively by the host verification harness.
