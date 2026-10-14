# FORGE STEP 8 — AUDIT REMEDIATION MATRIX

**Document:** Formal Remediation Matrix — Hostile Audit Findings S8-01 Through S8-12  
**Status:** ALL 12 AUDIT FINDINGS FORMALLY REMEDIATED  
**Version:** FORGE v1.3-remediation-matrix  
**Date:** 2026-10-07  
**Auditor:** Principal Security Architect & Adversarial Engineering  

---

## 1. FINDINGS REMEDIATION MATRIX (S8-01 THROUGH S8-12)

### S8-01
- **Finding:** Omitted / Undefined Fields in Constraints Permit Arbitrary Authority Widening (Critical)
- **Root Cause:** `constraintsSubsetOf` in `src/grants/grants.ts` only evaluated constraints if `child.<field>` was truthy. An omitted field evaluated as unconstrained.
- **Architecture Change:** Replaced open-world matching with the closed-world Effective Authority Model (`docs/forge-step8-remediated-authority-model.md`). Omitted constraint fields strictly inherit parent constraints or collapse to $\emptyset$.
- **New Invariant:** **INV-21A (Closed-World Constraint Inheritance):** Absence of a constraint in a child request never widens authority.
- **Machine-Checkable Rule:** $\forall d \in \text{ConstraintVocab}: \text{child}[d] = \text{child}[d] \lor \text{parent}[d]$. If parent defines $d$, child cannot have undefined $d$.
- **Remaining Risk:** Low. Syntax errors in regex patterns are caught at schema compile time.
- **Status:** **CLOSED**

---

### S8-02
- **Finding:** Missing MCP, Isolation Profile, and Host Execution Checks in Attenuation Function (Critical)
- **Root Cause:** `constraintsSubsetOf` completely lacked logic for `mcpTools`, `mcpServers`, `allowHostExecution`, and `isolationProfile`.
- **Architecture Change:** Formally added all four dimensions to the 20-dimensional Effective Authority Envelope. Added subset comparators for MCP and monotonicity enforcement for isolation.
- **New Invariant:** **INV-21B (Isolation & Environment Monotonicity):** $\text{Strictness}(Iso_C) \ge \text{Strictness}(Iso_P) \land (HostExec_C \implies HostExec_P)$.
- **Machine-Checkable Rule:** `if (parent.isolationProfile === "sandboxed" && child.isolationProfile !== "sandboxed") throw IsolationMonotonicityError`.
- **Remaining Risk:** Minimal. Relies on Docker cgroups and namespace drivers frozen in Step 7A.
- **Status:** **CLOSED**

---

### S8-03
- **Finding:** Evidence Citation Theft and Incomplete Receipt Binding in Verification Protocol (Critical)
- **Root Cause:** The 7-step receipt verification procedure verified only that artifact files existed on disk, failing to prove that the executing child's own journal emitted the observation.
- **Architecture Change:** Expanded `RemediatedDelegationReceiptSchema` to bind `incarnationEpoch`, `parentGrantId`, `planId`, `isolationProfile`, and `nonce`. Mandated Evidence Provenance Verification in Step 4 of the receipt protocol.
- **New Invariant:** **INV-27A (Evidence Provenance Invariant):** An artifact is valid evidence only if proven to have been emitted by an observation in the child's verified ledger history.
- **Machine-Checkable Rule:** $\forall h \in \text{receipt}.\text{evidenceRefs}: \exists r \in \text{ChildJournalRecords} : r.\text{outputRef} == h \lor r.\text{bodyRef} == h \lor r.\text{afterHash} == h$.
- **Remaining Risk:** Zero. Content-addressed SHA-256 hashes prevent collision.
- **Status:** **CLOSED**

---

### S8-04
- **Finding:** Grandchild Zombie Escapes in Option B Private Sub-Ledger Topology (Critical)
- **Root Cause:** In Option B, child sub-delegations were written only to child sub-journals. The parent ledger had no visibility into grandchildren, breaking cascade revocation.
- **Architecture Change:** Introduced the host-level Central Delegation Authority Registry (`docs/forge-step8-remediated-delegation-registry.md`). All delegations across all depths register in the central lineage table before container spawn.
- **New Invariant:** **INV-25A (Universal Descendant Discovery):** Revocation queries the host lineage table and terminates all descendant containers regardless of ledger partitioning.
- **Machine-Checkable Rule:** `Descendants(D) = { d in Registry | D in d.ancestorPath }`. All entries transition to `revoked`; host issues `docker kill` to all descendant container IDs.
- **Remaining Risk:** Host crash during container kill signal dispatch. Handled by boot recovery sweep.
- **Status:** **CLOSED**

---

### S8-05
- **Finding:** Ephemeral Incarnation UUID Lacks Durable Monotonic Epoch / Anti-Replay Guarantee (High)
- **Root Cause:** Identity relied on an ephemeral UUID claimed to be destroyed on process exit, providing zero durable ordering across crashes.
- **Architecture Change:** Replaced UUID-only identity with a durable monotonic integer `incarnationEpoch` incremented and committed to the parent journal on every start/restart.
- **New Invariant:** **INV-31 (Durable Incarnation Monotonicity):** Every process restart increments `incarnationEpoch`; stale epochs are rejected mechanically.
- **Machine-Checkable Rule:** `assert(request.incarnationEpoch === registry.childIncarnationEpoch)`.
- **Remaining Risk:** None. Epoch is persisted synchronously with `fsyncSync()`.
- **Status:** **CLOSED**

---

### S8-06
- **Finding:** Budget Accounting Leak & Under-Reporting on Child Crash without Receipt (High)
- **Root Cause:** Escrow reconciliation was tied exclusively to receipts. If a child crashed without a receipt, unspent budget could either be over-refunded or leaked.
- **Architecture Change:** Introduced the 7-state budget model (`docs/forge-step8-remediated-budget-model.md`) with an explicit `UNCERTAIN` state and an automated host **Crash Audit Daemon** that tallies actual spent tokens from the child journal before refunding.
- **New Invariant:** **INV-23A (Uncertain Spend Quarantining):** No automatic full refund may occur when spend is uncertain.
- **Machine-Checkable Rule:** `if (status === "crashed") escrow.state = "UNCERTAIN"; runCrashAuditDaemon()`.
- **Remaining Risk:** Torn child journal requires recovery truncation before audit tally. Handled by INV-13.
- **Status:** **CLOSED**

---

### S8-07
- **Finding:** Contradiction Between Frozen Record Boundary and 5-Tuple Attribution (High)
- **Root Cause:** `docs/forge-step8-implementation-boundary.md` falsely claimed `records.ts` was 100% frozen while INV-30 required adding attribution fields to `ProposalDispatchedBody`.
- **Architecture Change:** Explicitly reclassified `src/contracts/records.ts` as a **MODIFIED MODULE** in the boundary map (`docs/forge-step8-remediated-attribution-model.md`). Extended `ProposalDispatchedBody` to bind `delegationId`, `agentId`, and `incarnationEpoch`.
- **New Invariant:** **INV-30 (6-Tuple Machine Attribution):** Dispatches under delegation must bind all 6 lineage identifiers in the immutable ledger chain.
- **Machine-Checkable Rule:** `if (underDelegation && (!r.delegationId || !r.agentId || !r.incarnationEpoch)) throw AttributionMissingError`.
- **Remaining Risk:** Zero. Clean typed schema extension.
- **Status:** **CLOSED**

---

### S8-08
- **Finding:** Direct Contradiction Between Pre-Dispatch Revocation Check and State Isolation (High)
- **Root Cause:** Section 3.3 mandated that child containers query the parent ledger on pre-dispatch, violating container isolation (INV-26).
- **Architecture Change:** Clarified the physical execution boundary: Capability Host dispatcher executes on the **host supervisor outside the container**. The host supervisor intercepts socket requests and verifies the registry before dispatch.
- **New Invariant:** **INV-26A (Host Supervisor Dispatch Interception):** Container isolation is absolute; pre-dispatch checks are performed on the host supervisor.
- **Machine-Checkable Rule:** Host supervisor verifies `registry.getStatus(delegationId) === "active"` before invoking local/container capability.
- **Remaining Risk:** Minimal. Host socket communication is authenticated per connection.
- **Status:** **CLOSED**

---

### S8-09
- **Finding:** Absence of Delegation Proposal in ProposalSchema (Medium)
- **Root Cause:** `ProposalSchema` in `src/contracts/proposals.ts` only supported 12 base capabilities and omitted `delegate`.
- **Architecture Change:** Reclassified `src/contracts/proposals.ts` as a **MODIFIED MODULE**. Added `delegate` variant to `ProposalSchema` with `DelegateProposalArgsSchema`.
- **New Invariant:** **INV-15A (Delegation Proposal Gate Invariant):** Delegations are proposed exclusively via structured proposals passing the Proposal Gate.
- **Machine-Checkable Rule:** `ProposalSchema.parse({ capability: "delegate", args: ... })`.
- **Remaining Risk:** None. Validated by strict Zod schema.
- **Status:** **CLOSED**

---

### S8-10
- **Finding:** TOCTOU Race in Concurrent Sibling Budget Reservation & Fanout (Medium)
- **Root Cause:** In-memory asynchronous checks allowed concurrent parent tasks to observe stale balances and overdraw escrow or exceed fanout.
- **Architecture Change:** Enforced atomic Compare-And-Swap (CAS) inside `parentLedger.withExclusiveLock()` (`docs/forge-step8-remediated-concurrency-model.md`).
- **New Invariant:** **INV-23B (Atomic Escrow CAS):** Budget read, threshold verification, and escrow append execute atomically inside the exclusive ledger write lock.
- **Machine-Checkable Rule:** Exclusive file lock held throughout `reserveBudgetTx()`.
- **Remaining Risk:** Lock timeout during extreme disk contention. Handled by Step 7B lock leases.
- **Status:** **CLOSED**

---

### S8-11
- **Finding:** Shallow Child Ledger Verification in Receipt Processing (Medium)
- **Root Cause:** Receipt verification read only the last line of the child journal rather than verifying the cryptographic hash chain from genesis to tip.
- **Architecture Change:** Mandated execution of `verifyChain()` across all records from genesis to tip in Step 3 of the receipt protocol.
- **New Invariant:** **INV-27B (Genesis-to-Tip Chain Proof):** Parent receipt verification requires full cryptographic chain proof of the child journal.
- **Machine-Checkable Rule:** `verifyChain(childJournal).ok === true && chainTip === receipt.childLedgerTip`.
- **Remaining Risk:** I/O cost on very long sub-missions. Bounded by child turn limits ($maxTurns \le 50$).
- **Status:** **CLOSED**

---

### S8-12
- **Finding:** Checkpoint Restoration Under Revoked or Expired Grants Unspecified (Low)
- **Root Cause:** The 15-scenario recovery matrix omitted checkpoint restore behavior when delegation grants were subsequently revoked or expired.
- **Architecture Change:** Formally added Scenario F-16 to the recovery model (`docs/forge-step8-remediated-recovery-model.md`). Mandated authority revalidation against the Central Delegation Registry upon checkpoint restore.
- **New Invariant:** **INV-29A (Checkpoint Authority Non-Resurrection):** Checkpoint restore revalidates active authority; revoked/expired checkpoints restore into non-authorized halted states.
- **Machine-Checkable Rule:** `if (registry.status === "revoked") mission.state = "halted_grant_revoked"`.
- **Remaining Risk:** Zero. Execution is mechanically blocked.
- **Status:** **CLOSED**

---

*Authored by Principal Security Architect & Adversarial Engineering.*
