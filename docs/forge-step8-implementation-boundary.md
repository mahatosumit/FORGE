# FORGE STEP 8 — IMPLEMENTATION BOUNDARY SPECIFICATION

**Status:** IMPLEMENTATION ROADMAP & SEAM ANALYSIS  
**Version:** FORGE v1.3-boundary  
**Authors:** Principal Systems Architect & Security Engineering  
**Rule:** ZERO PRODUCTION CODE IS MODIFIED DURING THE DESIGN PHASE.  

---

## 1. MODULE CLASSIFICATION OVERVIEW

To ensure absolute preservation of Step 6, 7A, and 7B invariants and prevent regressions, all files in the FORGE repository are partitioned into three immutable categories:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          MODULE BOUNDARY MAP                           │
├──────────────────────────┬──────────────────────┬──────────────────────┤
│       NEW MODULES        │   MODIFIED MODULES   │  READ-ONLY / FROZEN  │
│  (To be built in Step 8) │ (Surgical additions) │(Zero changes allowed)│
├──────────────────────────┼──────────────────────┼──────────────────────┤
│ src/multi-agent/         │ src/contracts/       │ src/codec/           │
│ src/contracts/delegation │   records.ts         │ src/ledger/          │
│ src/contracts/receipts   │ src/gate/            │ src/environments/    │
│ test/multi-agent/        │   gate.ts            │ src/security/        │
│                          │ src/mission-engine/  │ src/capabilities/    │
│                          │   runner.ts          │ test/execution/      │
│                          │ src/runtime/         │ test/capabilities/   │
│                          │   runtime.ts         │ test/persistence/    │
└──────────────────────────┴──────────────────────┴──────────────────────┘
```

---

## 2. DETAIL SPECIFICATIONS

### 2.1 NEW MODULES (To be created during Step 8 implementation)

1. **`src/contracts/delegation.ts`**:
   - Declares `DelegationGrantSchema`, `DelegationStateSchema`, `DelegationSpecSchema`.
   - Pure typed data contracts with Zod validation.
2. **`src/contracts/receipts.ts`**:
   - Declares `DelegationReceiptSchema` and validation helpers.
3. **`src/multi-agent/manager.ts`**:
   - The `DelegationAuthorityManager` class.
   - Evaluates the 12-dimensional attenuation theorem ($A_C \subseteq A_P$).
   - Manages budget escrow locks and hierarchical unallocated accounting.
   - Enforces tree topology ($D_{\max} \le 2$, $F_{\max} \le 3$, $N_{\max} \le 10$, cycle rejection).
4. **`src/multi-agent/receipt-verifier.ts`**:
   - Implements the 7-step receipt verification procedure.
   - Cryptographically inspects child ledger tip, verifies artifact hashes, triggers parent mechanical verifiers.
5. **`src/multi-agent/revocation.ts`**:
   - Manages cascade revocation tree traversal.
   - Dispatches process/container termination signals to child execution providers.
   - Reclaims unused escrowed budgets to parent unallocated balance.
6. **`src/multi-agent/index.ts`**:
   - Clean public facade exporting multi-agent authority interfaces.
7. **`test/multi-agent/multi-agent-acceptance.test.ts`**:
   - Implementation of all 32 adversarial tests (`MA-001` through `MA-032`).

---

### 2.2 MODIFIED MODULES (Surgical additions to existing contracts & engines)

1. **`src/contracts/records.ts`**:
   - Add new record kind schemas for multi-agent authority:
     - `delegation.proposed`
     - `delegation.authorized`
     - `delegation.activated`
     - `delegation.revoked`
     - `delegation.receipt_verified`
     - `delegation.receipt_rejected`
     - `delegation.budget_reconciled`
   - **Constraint:** Existing record schemas (`task.*`, `proposal.*`, `observation.*`) remain 100% untouched.
2. **`src/gate/gate.ts`**:
   - Enhance Authority Gate pre-dispatch check to support `delegationId` and evaluate delegation grant validity alongside base grant.
3. **`src/mission-engine/runner.ts`**:
   - Connect parent mission execution loop to `DelegationAuthorityManager` when a task delegates to a subagent.
   - Replace in-memory legacy `src/mission-engine/delegation.ts` with the new governed multi-agent subsystem.
4. **`src/runtime/runtime.ts`**:
   - Update `ForgeRuntime.bootRecoverySweep()` to perform tree-ordered recovery sweeps (recovering child sub-missions before resolving parent delegations).

---

### 2.3 READ-ONLY / FROZEN MODULES (Zero changes permitted)

The following components are **STRICTLY FROZEN**:
- **`src/codec/hashChain.ts` & `src/codec/canonicalJson.ts`:** Core cryptographic SHA-256 hash chaining is unchanged.
- **`src/ledger/ledger.ts`, `src/ledger/lock.ts`, `src/ledger/index.ts`:** Single-host mutex leasing and synchronous `fsyncSync()` persistence remain unchanged.
- **`src/environments/container.ts` & `src/environments/local.ts`:** Container isolation, `CAP_DROP_ALL`, read-only rootfs drivers are unchanged.
- **`src/capabilities/registry.ts`, `src/capabilities/host.ts`:** Capability registration, version pinning, implementation hash binding are unchanged.
- **`test/execution/sandbox-escapes.test.ts`:** Step 7A isolation suite remains frozen (18/18 passing).
- **`test/capabilities/step6-*.test.ts`:** Step 6 empirical gate suite remains frozen (27/27 passing).
- **`test/persistence/persistence-recovery.test.ts` & `test/persistence/adversarial-persistence.test.ts`:** Step 7B persistence suites remain frozen (30/30 passing).

---

*Authored by Principal Systems Architect & Security Engineering.*
