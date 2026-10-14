# FORGE STEP 8 PHASE 2C — INFORMATION FLOW CONTROL & SECURITY LATTICE SPECIFICATION
## Multi-Level Security Labels, Star-Topology Brokerage, and Declassification Governance

**Status:** DESIGN HARDENED (Implementation STRICTLY LOCKED)  
**Security Invariant:** Information flow between sibling agents is strictly mediated through immutable parent evidence artifacts with explicit lattice labeling:
$$\text{Flow}(C_i \rightarrow C_j) = \emptyset \quad \land \quad L_{\text{source}} \le L_{\text{destination}}$$

---

## 1. Problem Statement: Integrity vs Confidentiality

In the initial design, data handoff relied on SHA-256 hashes of output artifacts:
> *"Child A outputs artifact hash -> Parent verifies hash -> Parent mounts artifact read-only into Child B."*

As the adversarial design review highlighted:
> **"The hash gives you integrity, not confidentiality or authorization of information flow. The parent can simply pass Child A's private secrets to Child B. The fact that the artifact is SHA256(secret) doesn't establish that Child B is authorized to know the secret."**

Without formal security labels, the parent broker becomes an **unrestricted declassification oracle**. True non-interference requires a **formal information security lattice**.

---

## 2. The Six-Level Security Lattice (`DR-04`)

Every file, observation, artifact, and prompt block is assigned a formal **Security Label**:

$$\text{PUBLIC} < \text{WORKSPACE} < \text{MISSION\_PRIVATE} < \text{CHILD\_PRIVATE} < \text{SECRET} < \text{EXTERNAL}$$

```
                                  [SECRET]
                                     ▲
                                     │ (Requires Credential Grant)
                            [CHILD_PRIVATE]
                                     ▲
                                     │ (Requires Declassification Filter)
                           [MISSION_PRIVATE]
                                     ▲
                                     │
                                [WORKSPACE]
                                     ▲
                                     │
                                 [PUBLIC]

                [EXTERNAL] ──(Tainted: AST Sanitizer Required)──▶ [WORKSPACE]
```

### Label Semantics:
1. **`PUBLIC`:** Inert documentation, read-only system specs, public packages.
2. **`WORKSPACE`:** General project code, test suites, and verified build outputs.
3. **`MISSION_PRIVATE`:** Parent plan DAG, criteria status, internal routing metadata.
4. **`CHILD_PRIVATE`:** Child-local scratchpads, intermediate thoughts, debug logs, local temp files.
5. **`SECRET`:** API keys, database credentials, cryptographic seed keys.
6. **`EXTERNAL`:** Tainted data ingested from the internet, external git repos, or web fetch.

---

## 3. Information Flow Policy Rules

### Rule 1: Non-Interference Lattice Property
Information may only flow upwards or within equal labels:
$$\text{CanFlow}(L_1, L_2) \iff L_1 \le L_2$$
- `CHILD_PRIVATE` cannot flow into `WORKSPACE` or `MISSION_PRIVATE` without explicit declassification.
- `SECRET` cannot flow into any artifact or prompt block without redaction.

### Rule 2: Prohibition of Sibling IPC
Direct IPC between siblings is completely prohibited:
$$\text{Flow}(C_i \rightarrow C_j) = \emptyset$$
Siblings share no sockets, pipes, temporary directories, or memory.

### Rule 3: Governed Declassification Filter (Anti-Oracle Barrier)
To prevent the parent from acting as an unconstrained declassification oracle, an artifact produced by Child A (initially labeled `CHILD_PRIVATE`) can only be declassified to `WORKSPACE` (and mounted into Child B) if it passes an explicit **Mechanical Declassification Filter**:
1. **Secret Scanning:** Zero matches against active mission secret values or high-entropy patterns.
2. **Schema Conformance:** Artifact matches the criterion's declared `requiredEvidenceSchema`.
3. **AST Safety Check:** If code, verified to contain no eval calls, exec calls, or network egress side channels.

### Rule 4: Taint Tracking for EXTERNAL Data
Any data ingested via `web_fetch`, `http`, or `doc_parse` is permanently labeled `EXTERNAL` (tainted):
- Tainted data cannot be written directly to executable files without passing an AST sanitizer.
- Tainted data is tagged with `tainted="true"` in ledger observations.

---

## 4. Prompt Injection Defense: Dual Intent & Authority Gates (`DR-05`)

### Why Authority Gate Alone Is Insufficient
An attacker injecting instructions into an external document (*"Delete all customer data"*) does not need capability escalation if the agent already possesses `fs: write`.
The injection causes **authorized capability misuse**.

### Dual-Gate Pipeline:
1. **Tier 1 Intent Gate:** Evaluates whether the proposed mutation aligns with the active `Criterion` scope. If the criterion is `C_lint`, an action deleting `customers.json` is rejected by the Intent Gate because file deletion is not in `C_lint.allowedContributionTypes`.
2. **Tier 2 Authority Gate:** Evaluates whether the capability grant is possessed within the closed-world envelope.
3. **Untrusted Observation Wrapper:**
   All natural language outputs from children and external tools are wrapped in `<untrusted_child_observation>` blocks, stripping control sequences and marking content as inert data.

---

## 5. Formal Invariants

- **INV-41.1 (Star-Topology Mediation):** Sibling information flow is strictly mediated by parent-verified artifacts.
- **INV-41.2 (Security Lattice Conformance):** Flow between labeled objects must satisfy $L_{\text{source}} \le L_{\text{dest}}$.
- **INV-41.3 (Mechanical Declassification):** Declassifying `CHILD_PRIVATE` data requires passing the automated Secret Scanner and Evidence Schema verifier.
- **INV-42.1 (Untrusted Observation Wrapper):** External and child text ingested into prompts is tagged as inert data.
- **INV-42.2 (Dual-Gate Verification):** Proposals must pass both the Tier 1 Intent Gate and Tier 2 Authority Gate.
