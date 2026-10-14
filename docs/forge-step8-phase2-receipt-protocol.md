# FORGE STEP 8 PHASE 2 — RECEIPT PROTOCOL
## Content-Addressed Delegation Receipt Protocol & Ingestion Pipeline

**Document:** Cryptographic Receipt Protocol Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-receipt-protocol  
**Date:** 2026-10-07  
**Scope:** Receipt Schema, Signing, Transport, 6-Point Verification Pipeline, and Ingestion  

---

## 1. THE DELEGATION RECEIPT SPECIFICATION

A `DelegationReceipt` is a content-addressed, cryptographically bound artifact produced by a child agent upon task completion or failure. It serves as the sole mechanical proof upon which the parent runtime can acknowledge task completion, settle escrowed budgets, and advance its DAG.

```typescript
export interface DelegationReceipt {
  /** Unique receipt identifier (ULID Crockford-32) */
  readonly receiptId: string;
  /** Delegation identifier authorizing this execution */
  readonly delegationId: DelegationId;
  /** Parent mission identifier */
  readonly parentMissionId: string;
  /** Child mission identifier */
  readonly childMissionId: string;
  /** Parent plan identifier */
  readonly planId: string;
  /** Parent task identifier */
  readonly taskId: string;
  /** Child agent identity tuple hash */
  readonly childAgentId: string;
  /** Child incarnation epoch at receipt generation */
  readonly childIncarnationEpoch: number;
  /** Tip of the child's mission journal */
  readonly childLedgerTip: {
    readonly recordIndex: number;
    readonly sha256: string;
  };
  /** Content-addressed evidence artifacts produced by child */
  readonly evidenceArtifacts: ReadonlyArray<{
    readonly relativePath: string;
    readonly sha256: string;
    readonly byteSize: number;
  }>;
  /** Verified budget consumed during child execution */
  readonly budgetConsumed: DelegationBudget;
  /** Final child task status */
  readonly status: "success" | "failure" | "partial";
  /** Single-use cryptographic nonce */
  readonly nonce: string;
  /** ISO-8601 creation timestamp */
  readonly createdAt: string;
  /** HMAC-SHA256 or asymmetric signature over RFC 8785 canonical JSON */
  readonly signature: string;
}
```

---

## 2. RECEIPT LIFECYCLE: CHILD TO PARENT

```text
       CHILD RUNTIME HOST                                 PARENT RUNTIME / SUPERVISOR
               │                                                       │
 1. Task Execution Complete                                            │
               │                                                       │
 2. Flush Child Journal & fsyncSync                                    │
    Tip: <index, sha256>                                               │
               │                                                       │
 3. Hash Evidence Artifacts on Disk                                    │
               │                                                       │
 4. Calculate Verified Budget Consumed                                 │
               │                                                       │
 5. Generate Nonce & Sign Receipt                                      │
               │                                                       │
 6. Atomic Write: receipt.json                                         │
               │                                                       │
 7. Transmit via IPC Control Channel ─────────────────────────────────>│
                                                                       │
                                                         8. Ingest Receipt Payload
                                                                       │
                                                         9. Run 6-Point Verification
                                                            - Nonce & Replay Check
                                                            - Replay Child Journal
                                                            - Verify Disk Artifacts
                                                            - Authority Compliance
                                                            - Budget Sum Check
                                                            - Signature Check
                                                                       │
                                                        10. If All Pass:
                                                            Commit delegation.receipt_verified
                                                            Settle Budget (Consumed/Refund)
                                                            Advance Parent DAG
                                                                       │
                                                        11. If Any Fails:
                                                            Commit delegation.receipt_rejected
                                                            Mark UNCERTAIN if torn
                                                            Fail Closed Parent Task
```

---

## 3. THE 6-POINT MECHANICAL VERIFICATION PIPELINE

A parent agent **never trusts a receipt based on hash equality or child claims alone**. When a receipt arrives, the parent `ReceiptVerifier` executes a strict 6-stage mechanical audit:

### Stage 1: Context & Nonce Binding Verification
1. `receipt.parentMissionId` must match the parent's current mission ID.
2. `receipt.delegationId` must match an active delegation currently in `AUTHORIZED` or `ACTIVE` state.
3. `receipt.childIncarnationEpoch` must equal `MultiAgentProjection.getAuthoritativeEpoch(delegationId)`.
4. The `receipt.nonce` must not exist in the parent's seen-nonce database (prevents replay attacks).

### Stage 2: Child Ledger Hash-Chain Verification
1. The parent opens `missions/<childMissionId>/journal.jsonl`.
2. Replays the child ledger from record 0 (genesis) to `receipt.childLedgerTip.recordIndex`.
3. Verifies that every record's `prevHash` correctly chains to the preceding record's SHA-256 digest.
4. Asserts that the computed SHA-256 of the tip record exactly equals `receipt.childLedgerTip.sha256`.
5. If any record is missing, out of order, or tampered, the check throws `JournalCorruptionError`.

### Stage 3: Evidence Artifact Integrity Verification
1. For every entry in `receipt.evidenceArtifacts`:
   - Parent resolves real disk path: `missions/<childMissionId>/workspace/<relativePath>`.
   - Asserts file exists and is a regular file (not a symlink escaping the jail).
   - Reads file bytes and computes SHA-256 digest.
   - Compares computed hash to `entry.sha256` and byte size to `entry.byteSize`.
2. Verifies that every evidence file is referenced by an `observation.created` record in the child's verified journal.
3. If any file is missing, size differs, or hash does not match, verification fails closed.

### Stage 4: Authority Compliance Audit
1. Verifies that every `proposal.dispatched` record in the child ledger was authorized by a valid `GateVerdict`.
2. Verifies that all operations, touched paths, argv, and hosts in the child ledger strictly fall within the `EffectiveAuthorityEnvelope` authorized in the parent's `delegation.authorized` record.
3. If an ungoverned or out-of-bounds record is discovered in the child ledger, the receipt is rejected as compromised.

### Stage 5: Budget Consumption Reconciliation
1. Verifies that `receipt.budgetConsumed` matches the exact sum of all consumed tokens, model calls, capability calls, and execution time recorded in the child ledger's observations.
2. Verifies that `budgetConsumed` does not exceed the escrowed limit in any dimension.
3. If claimed budget is less than journaled observations, or exceeds escrow, verification fails.

### Stage 6: Cryptographic Signature Verification
1. Serializes the receipt body (excluding `signature`) using RFC 8785 canonical JSON.
2. Verifies `receipt.signature` against the child agent's ephemeral public key or HMAC secret established during `delegation.activated`.

---

## 4. DISTINGUISHING CONTENT INTEGRITY FROM ORIGIN AUTHENTICITY

A content hash proves only:
> *"This content has this hash."*

It does NOT prove:
> *"This specific authorized child, executing during this authoritative incarnation epoch under this parent delegation, generated this content."*

Relying solely on "does the hash match?" is a critical security vulnerability. FORGE Stage 8 Phase 2 explicitly separates **Integrity** from **Authenticity**:

### 4.1 Threat Scenarios & Authenticity Defenses
* **Attack Scenario A (Field Mutation / Tampered Receipt):**
  - An attacker takes a valid receipt and modifies individual fields:
    - Altering `childMissionId` or `delegationId` to credit a different agent.
    - Altering `childIncarnationEpoch` to spoof a newer or older incarnation.
    - Altering `childLedgerTip` to mask uncommitted operations.
    - Altering `evidenceArtifacts` to point to unverified files.
    - Altering `budgetConsumed` to under-report resource usage.
  - **Defense:** RFC 8785 canonical JSON serialization binds all fields under `signature`. Mutating any field breaks signature verification. In addition, Stage 1 cross-references all IDs against the parent's authoritative journal state.
* **Attack Scenario B (Legitimate-Looking Rogue Ledger):**
  - An attacker generates a syntactically valid `journal.jsonl` with perfect SHA-256 hash chains, matching evidence files, and internally consistent budget sums, but fabricated outside of authorized delegation.
  - **Defense:** Stage 2 asserts that the genesis record of the child journal contains the exact parent authorization hash `delegationAuthRef` committed in the parent journal, and Stage 1 confirms that `delegationId` is currently in `AUTHORIZED` or `ACTIVE` state in the parent's `MultiAgentProjection`.
* **Attack Scenario C (Fabricated Evidence with Valid Hash):**
  - A malicious child generates an arbitrary file, computes its hash, embeds both in the receipt, and claims success.
  - **Defense:** Stage 3 and Stage 4 verify that the evidence file was produced by an authorized capability execution recorded in the child ledger under a valid `GateVerdict`.
* **Attack Scenario D (Receipt Replay):**
  - A valid receipt from a previous task or sibling mission is submitted to falsely advance another task.
  - **Defense:** Stage 1 enforces single-use cryptographic nonces and exact `parentMissionId` / `taskId` binding.
* **Attack Scenario E (Uncommitted Side Effects):**
  - A child dispatches an external network effect but crashes or omits it from the receipt.
  - **Defense:** Stage 2 and Stage 5 verify ledger closure and tip continuity against real recorded observations.
