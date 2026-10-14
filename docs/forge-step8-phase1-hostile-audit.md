# FORGE STEP 8 PHASE 1 — HOSTILE SECURITY AUDIT
## Independent Hostile Security Review: Authority Kernel & Delegation Contracts

**Auditor:** Hostile Principal Security Auditor  
**Date:** 2026-10-07  
**Target:** FORGE Step 8 Implementation Phase 1  
**Target Baseline:** `d:\quack pro\forge` (TypeScript 5.7.2, Node.js v24.19.0)  
**Authoritative Specifications:**
- `docs/forge-step8-remediated-authority-model.md`
- `docs/forge-step8-remediated-delegation-registry.md`
- `docs/forge-step8-remediated-budget-model.md`
- `docs/forge-step8-remediated-receipt-protocol.md`
- `docs/forge-step8-remediated-recovery-model.md`
- `docs/forge-step8-remediated-concurrency-model.md`
- `docs/forge-step8-remediated-attribution-model.md`
- `docs/forge-step8-remediation-matrix.md`

---

## Executive Verdict

# ❌ NOT READY

**Phase 1 CANNOT be certified.** Phase 2 authorization is **STRICTLY DENIED**.

The Phase 1 implementation report claimed 22/22 security tests passing and full adherence to closed-world attenuation, budget conservation, and cascade revocation. However, hostile audit of the actual production implementation in `src/` reveals **4 CRITICAL, 4 HIGH, and 3 MEDIUM** vulnerabilities, and **fails 7 out of 12 STOP CONDITIONS**.

The most severe architectural failures:
1. **Budget Resurrection on Crash (CRITICAL):** `BudgetEscrowManager` is purely an ephemeral in-memory class with **zero persistence**. Upon process crash or restart, all spent and uncertain budgets are completely resurrected back to 100% `AVAILABLE`.
2. **Path Segment Confusion / Escape (CRITICAL):** `computeEffectiveAuthority` uses character `.startsWith(pp)` instead of directory-segment containment (`matchPath`), allowing a child granted `workspace/sub` to access `workspace/subversion/secret.txt`.
3. **Gate Delegation Bypass (CRITICAL):** `AuthorityGate.evaluateProposal()` treats `delegate` proposals as unconstrained pass-throughs, approving any requested authority, budget, depth, and cycle without invoking `computeEffectiveAuthority` or checking `DelegationRegistry`.
4. **Stale Epoch Execution (CRITICAL):** Neither `AuthorityGate` nor `CapabilityHost` inspects `incarnationEpoch` or `agentId`. Stale or rolled-back processes continue executing arbitrary side effects.
5. **Unconstrained `web_fetch` on Omission (HIGH):** When a grant omits `hosts`, the Gate skips the host check and allows network requests to arbitrary external hosts.
6. **Cross-Process Race Conditions (HIGH):** `DelegationRegistry` lacks cross-process file locks, allowing racing processes to overwrite `delegation-registry.json` and breach fanout ($F \le 3$) and active agent ($N \le 10$) bounds.
7. **Registry / Journal Split-Brain (HIGH):** Registry mutations are disconnected from the mission ledger; no synchronization or crash reconciliation exists.

---

## Findings

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| **AUDIT-P1-01** | **CRITICAL** | `BudgetEscrowManager` lacks persistence; 100% budget resurrection on crash/restart | `src/multi-agent/budget-escrow.ts:72-105` | **OPEN** |
| **AUDIT-P1-02** | **CRITICAL** | `AuthorityGate` evaluates `delegate` proposals without checking effective authority or registry | `src/gate/gate.ts:298-354` | **OPEN** |
| **AUDIT-P1-03** | **CRITICAL** | Stale incarnation epochs reach execution; Gate and Host lack epoch verification | `src/gate/gate.ts`, `src/capability-host/host.ts` | **OPEN** |
| **AUDIT-P1-04** | **CRITICAL** | Path segment confusion in `computeEffectiveAuthority` allows directory boundary escape | `src/multi-agent/effective-authority.ts:173` | **OPEN** |
| **AUDIT-P1-05** | **HIGH** | Omitted `hosts` constraint in active grant allows unconstrained `web_fetch` to any host | `src/gate/gate.ts:325` | **OPEN** |
| **AUDIT-P1-06** | **HIGH** | Absence of cross-process file locking in `DelegationRegistry` allows overwrite & bound breach | `src/multi-agent/registry.ts:337-375` | **OPEN** |
| **AUDIT-P1-07** | **HIGH** | Registry and Journal split-brain with no single source-of-truth reconciliation rule | `src/multi-agent/registry.ts`, `src/ledger/ledger.ts` | **OPEN** |
| **AUDIT-P1-08** | **HIGH** | Cascade revocation in registry does not invalidate active Gate grants or terminate containers | `src/multi-agent/registry.ts:212-243` | **OPEN** |
| **AUDIT-P1-09** | **MEDIUM** | Omitted capabilities in child request inherits 100% of parent capabilities (violates §2.1) | `src/multi-agent/effective-authority.ts:115-118` | **OPEN** |
| **AUDIT-P1-10** | **MEDIUM** | Grandparent revocation bypass in `DelegationRegistry.registerDelegation()` | `src/multi-agent/registry.ts:121-140` | **OPEN** |
| **AUDIT-P1-11** | **MEDIUM** | Test quality deficit: critical security claims verified only by isolated object mocks | `test/multi-agent/phase1.test.ts` | **OPEN** |

---

## Authority Attenuation Audit

### 1. Attack on Path Prefix Attenuation (AUDIT-P1-04)
In `src/multi-agent/effective-authority.ts`, line 173:
```typescript
const covered = pConst.paths.some((pp) => matchPath(prefix, pp) || prefix.startsWith(pp));
```
**Vulnerability:**
`prefix.startsWith(pp)` performs a raw string character prefix check instead of directory-segment containment.
**Empirical Proof of Escape:**
```typescript
const parent = { constraints: { paths: ["workspace/sub"] } };
const child = { constraints: { paths: ["workspace/subversion/secret.txt"] } };
computeEffectiveAuthority(parent, child); // RETURNS { ok: true }
```
The child is granted authority over `workspace/subversion/secret.txt` even though the parent grant only authorized the directory `workspace/sub/`. This allows a child to access adjacent ungranted directories simply by sharing a character prefix.

### 2. Omitted Capabilities Inheritance vs Specification (AUDIT-P1-09)
In `docs/forge-step8-remediated-authority-model.md` §2.1:
> "Omitted / Undefined: If omitted, $C_C^{\text{eff}} = \emptyset$ (fail-closed; zero capabilities granted)."

In `src/multi-agent/effective-authority.ts`, lines 115–118:
```typescript
if (effectiveCaps.length === 0 && parent.capabilities.length > 0 && requested.capabilities === undefined) {
  // Inherit parent capabilities if none specified
  effectiveCaps = [...parent.capabilities];
}
```
**Vulnerability:**
Instead of failing closed to $\emptyset$ as mandated by the specification, an omitted capabilities request silently inherits 100% of the parent's capabilities.

### 3. Omitted `hosts` in Active Grant (AUDIT-P1-05)
In `docs/forge-step8-remediated-authority-model.md` §2.4:
> "For web_fetch and http, an omitted hosts constraint in active grant evaluates as zero network access allowed (∅)."

In `src/gate/gate.ts`, line 324–326:
```typescript
} else if (proposal.capability === "web_fetch") {
  if (c.hosts && c.hosts.length > 0 && !hosts.every((h) => c.hosts!.some((pat) => hostMatches(pat, h)))) ok = false;
}
```
**Vulnerability:**
If a grant for `web_fetch` has no `hosts` constraint (`c.hosts === undefined` or `c.hosts.length === 0`), the check is completely skipped and `ok` remains `true`. The Gate permits `web_fetch` requests to `https://evil-attacker.com/exfiltrate` under an unconstrained grant.

---

## Registry vs Authority Gate Audit

### 1. Execution Path Analysis
Does `DelegationRegistry` authorize actions without the Gate?
- `DelegationRegistry` exposes no capability execution API.
- `CapabilityHost.execute()` requires a `GateVerdict` with `type: "allow"`.
- However, the reverse direction is completely broken (AUDIT-P1-02): the Authority Gate does not check `DelegationRegistry` when validating proposals!

### 2. The `delegate` Proposal Gate Pass-Through (AUDIT-P1-02)
When a model or agent proposes `{ capability: "delegate", args: ... }`:
1. `src/gate/gate.ts` checks if any active grant has `capability === "delegate"`.
2. `resolvedPaths = []`, `hosts = []`, `argv = []`.
3. The Gate performs **zero validation** of `args.requestedAuthority`, `args.requestedBudget`, `args.topologyMetadata`, `args.incarnationEpoch`, or `args.parentDelegationId`.
4. The Gate returns `{ type: "allow", grantId: g.id }`.
5. An agent with a generic `delegate` grant can propose an escalation granting `shell`, root paths, 10,000,000 tokens, and depth 99. The Gate mechanically approves it.

---

## Incarnation / Epoch Audit

### 1. Stale Epoch Execution Bypass (AUDIT-P1-03)
The architecture claims INV-30:
> "Old agent incarnations cannot execute after newer epoch is authoritative."

**Code Audit:**
- `src/gate/gate.ts`: Zero occurrences of `epoch` or `incarnationEpoch`.
- `src/capability-host/host.ts`: Zero occurrences of `epoch` or `incarnationEpoch`.
- `ProposalDispatchedBody` in `records.ts` accepts `incarnationEpoch`, but this is purely a post-dispatch metadata field.

**Attack Scenario:**
1. Child Agent $C$ is spawned at Epoch 1.
2. Child Agent $C$ encounters a timeout or crash; Supervisor advances $C$ to Epoch 2 via `registry.reincarnate(dId, 2)`.
3. A zombie process or delayed thread from Epoch 1 emits a proposal to the Gate.
4. The Gate checks grants and issues `type: "allow"`.
5. `CapabilityHost` dispatches the physical effect.
6. **Result:** Stale incarnation successfully executed world side effects.

---

## Budget Crash-Consistency Audit

### 1. Ephemeral In-Memory State & Budget Resurrection (AUDIT-P1-01)
In `src/multi-agent/budget-escrow.ts`:
```typescript
export class BudgetEscrowManager {
  private readonly escrows = new Map<DelegationId, DelegationEscrowEntry>();
  private available: DelegationBudget;
  private readonly totalLimit: DelegationBudget;
  ...
```
**Forensic Findings:**
- `BudgetEscrowManager` has **no storage path, no `persistSync()` method, no fsyncSync, and no `loadAndRecover()` method**.
- It is instantiated strictly in memory: `new BudgetEscrowManager(initialBudget)`.
- When the runtime host crashes or restarts:
  1. All `ESCROWED`, `ALLOCATED`, `CONSUMED`, and `UNCERTAIN` entries vanish.
  2. The new instance initializes `this.available = { ...this.totalLimit }`.
  3. 100% of the original budget is resurrected.
  4. Any previously spent tokens or unverified crash spend can be spent again.
- **Stop Condition 6 ("Budget can resurrect after crash") is unambiguously VIOLATED.**

### 2. Multi-Process Double Spending (AUDIT-P1-06)
Because `BudgetEscrowManager` is in-memory and not bound to the single-writer mission journal lock (`src/ledger/lock.ts`), two concurrent processes each maintain independent in-memory available balances, allowing 200%+ of the total budget limit to be reserved and spent simultaneously.

---

## Registry / Journal Consistency Audit

### 1. Dual-Master Split-Brain (AUDIT-P1-07)
The system maintains two completely decoupled persistence targets:
1. `dataDir/governance/delegation-registry.json` (managed by `DelegationRegistry`)
2. `dataDir/missions/<missionId>/journal.jsonl` (managed by `Ledger`)

**Split-Brain Vulnerabilities:**
- `registry.registerDelegation()` writes to `delegation-registry.json`, but does NOT append `delegation.authorized` to the parent mission journal.
- `registry.revokeDelegation()` marks entries `"revoked"` in JSON, but does NOT append `delegation.revoked` to the parent mission journal.
- If a crash occurs:
  - Scenario A: Registry has `revoked`, Journal has `active`.
  - Scenario B: Journal has `revoked`, Registry has `active`.
- There is **no reconciliation engine, no startup recovery scanner, and no deterministic rule** defining which store is authoritative.

---

## Concurrency / CAS Audit

### 1. In-Memory "CAS" vs Durable Cross-Process Locking (AUDIT-P1-06)
- The Phase 1 implementation report claimed "Atomic CAS under lock".
- In reality, `atomicReserveEscrow()` in `src/multi-agent/budget-escrow.ts` is merely an in-memory JavaScript synchronous method.
- `DelegationRegistry.persistSync()` uses `renameSync(tmp, outPath)` but acquires **no file lock or mutex**.
- If two processes concurrently register delegations:
  - Process A writes `tmpA` and renames to `delegation-registry.json`.
  - Process B writes `tmpB` and renames to `delegation-registry.json`.
  - Process B's rename obliterates Process A's entries.
  - Concurrency checks for fanout ($F \le 3$) and active agents ($N \le 10$) are bypassed.

---

## Topology Audit

### 1. Grandparent Revocation Bypass (AUDIT-P1-10)
In `src/multi-agent/registry.ts`, lines 121–135:
```typescript
if (entry.parentDelegationId !== null) {
  const parent = this.entries.get(entry.parentDelegationId);
  if (!parent) throw new DelegationNotFoundError(entry.parentDelegationId);
  if (parent.status === "revoked" || parent.status === "expired" || parent.status === "failed") {
    throw new DelegationRegistryError(...);
  }
}
```
**Vulnerability:**
The method validates `parent.status`, but **fails to check the status of ancestors earlier in `entry.ancestorPath`**. If a grandparent was revoked, but the parent entry was not yet updated or in an intermediate state, a child can register beneath the revoked hierarchy.

---

## Gate Integration Audit

### 1. Capability Dispatch Disconnection
- `src/gate/gate.ts` has no integration with `src/multi-agent/*`.
- `computeEffectiveAuthority` is never called during proposal evaluation.
- `DelegationRegistry` is never queried during proposal evaluation.
- The entire multi-agent authority kernel implemented in Phase 1 exists as an isolated library that is **never invoked during the actual Gate-to-Host dispatch path**.

---

## Effect-Surface Audit

### 1. Primitive Surface Analysis
Audit of all new code in `src/multi-agent/`:
- `effective-authority.ts`: Pure functions. No I/O.
- `identity.ts`: Pure cryptographic functions (`node:crypto`). No I/O.
- `budget-escrow.ts`: Pure in-memory data structures. No I/O.
- `registry.ts`: File I/O confined to `openSync`, `writeSync`, `fsyncSync`, `renameSync`, `readFileSync`, `existsSync`, `mkdirSync`.
- **Verdict:** Phase 1 did NOT introduce unauthorized execution seams, subprocesses, network calls, or container lifecycles. Effect seams remain confined to persistence I/O.

---

## Test Quality Audit

### 1. Object-Level Mocking vs System Invariants (AUDIT-P1-11)
The 22 tests in `test/multi-agent/phase1.test.ts` pass, but provide false confidence:
1. **Tests 1–8:** Test `computeEffectiveAuthority()` in isolation. They do NOT pass proposals through `evaluateProposal()` or `CapabilityHost`.
2. **Tests 11–12:** Test `isEpochAuthoritative()` pure functions. They do NOT test whether an active process with a stale epoch is blocked from dispatching effects.
3. **Tests 13–17:** Test `BudgetEscrowManager` in-memory methods in a single thread. They do NOT test persistence, restart recovery, crash consistency, or multi-process concurrency.
4. **Test 18:** Tests registry JSON round-trip, but does not test ledger synchronization or lock contention.

---

## Stop Conditions Checklist

| Condition | Description | Verdict | Reason |
|---|---|---|---|
| **1** | Registry can authorize without Gate | **PASS** | `CapabilityHost` strictly enforces `GateVerdict`. |
| **2** | Omitted constraint widens authority | **FAIL** | Character prefix escape in `paths`; omitted `hosts` in `web_fetch` permits all hosts; omitted `capabilities` inherits 100% of parent. |
| **3** | Wildcard expands child authority | **PASS** | Wildcard subdomain widening is blocked in `effective-authority.ts`. |
| **4** | Stale epoch can reach execution | **FAIL** | Gate and Host have zero epoch validation; stale processes can execute effects. |
| **5** | Budget can double-spend | **FAIL** | In-memory `BudgetEscrowManager` has no cross-process synchronization. |
| **6** | Budget can resurrect after crash | **FAIL** | `BudgetEscrowManager` has no persistence; 100% budget resurrected on restart. |
| **7** | UNCERTAIN spend can be automatically refunded | **FAIL** | On restart, all `UNCERTAIN` spend is wiped and reset to `AVAILABLE`. |
| **8** | Registry/journal have ambiguous source-of-truth semantics | **FAIL** | Dual-master architecture with zero synchronization or recovery rule. |
| **9** | Cross-process race can violate topology or budget | **FAIL** | `DelegationRegistry` and `BudgetEscrowManager` lack cross-process locking. |
| **10** | Parent revocation leaves an executable descendant | **FAIL** | Registry revocation marks JSON file but does not terminate OS processes or revoke Gate grants. |
| **11** | Phase 1 introduced an ungoverned effect path | **PASS** | No new execution seams or subprocesses introduced. |
| **12** | Critical security claim supported only by object mock | **FAIL** | Epochs, budget durability, and Gate delegation governance tested only via unit mocks. |

---

## Required Remediations

Prior to any Phase 2 authorization, the following remediations must be implemented:

1. **Durable Budget Ledger Integration (Remediating AUDIT-P1-01, 05, 06):**
   - Bind `BudgetEscrowManager` directly to the parent mission journal under `ledger.withLock()`.
   - Budget reservations, escrow activations, and reconciliations must be committed as durable ledger records (`delegation.authorized`, `delegation.budget_reconciled`).
   - Available budget must be projected from durable journal records on boot, not initialized in memory.
2. **Path Segment Boundary Enforcement (Remediating AUDIT-P1-04):**
   - Replace `prefix.startsWith(pp)` in `src/multi-agent/effective-authority.ts` with strict directory-boundary containment:
     ```typescript
     const isSub = prefix === pp || prefix.startsWith(pp + "/");
     ```
3. **Fail-Closed Omitted Capabilities (Remediating AUDIT-P1-09):**
   - If `requested.capabilities === undefined`, child effective capabilities must evaluate strictly to `[]` (or throw `MissingRequestedCapabilitiesError`).
4. **Gate Integration of Delegation Contracts (Remediating AUDIT-P1-02, 03):**
   - In `src/gate/gate.ts`, `evaluateProposal()` must intercept `proposal.capability === "delegate"` and mechanically invoke `computeEffectiveAuthority()`, assert topology bounds, and verify epoch monotonicity.
   - `evaluateProposal()` and `CapabilityHost.execute()` must check `ctx.incarnationEpoch === registryEntry.childIncarnationEpoch` and fail closed if stale.
5. **Fail-Closed Network Hosts on Omission (Remediating AUDIT-P1-05):**
   - In `src/gate/gate.ts`, update `web_fetch` evaluation so that if `c.hosts` is omitted or empty, `ok = false`.
6. **Cross-Process Locking on Delegation Registry (Remediating AUDIT-P1-06):**
   - Use `acquireLock()` from `src/ledger/lock.ts` to acquire an exclusive lock (`.registry.lock`) during `DelegationRegistry` mutations.
7. **Single Source of Truth / Registry Reconciliation (Remediating AUDIT-P1-07):**
   - Establish `journal.jsonl` as the canonical source of truth, with `DelegationRegistry` acting as a write-through projection or verified index rebuilt from journal records during boot recovery.

---

## Residual Risks

1. **Sub-ledger Option B Independence vs Zombie Discovery:** Until Phase 2 introduces host supervisor socket IPC and physical container process-group binding, child processes run as independent OS entities.
2. **Windows File Lock Timing:** File renaming under Windows indexing or antivirus locks requires robust retry loops with exponential backoff across all persistence points.

---

## Final Certification

```text
==================================================
FORGE STEP 8 PHASE 1 — HOSTILE AUDIT VERDICT
==================================================

Audit Status:                          NOT READY ❌
Phase 2 Implementation Authorization:  DENIED ❌

Findings Summary:
- CRITICAL:                            4
- HIGH:                                4
- MEDIUM:                              3
- LOW:                                 0

Stop Conditions Failed:                7 / 12
- Stop Condition 2 (Omitted Constraint Widening): FAILED
- Stop Condition 4 (Stale Epoch Execution):       FAILED
- Stop Condition 5 (Budget Double-Spend):         FAILED
- Stop Condition 6 (Budget Resurrection):         FAILED
- Stop Condition 7 (Uncertain Spend Reset):       FAILED
- Stop Condition 8 (Registry/Journal Split):      FAILED
- Stop Condition 9 (Cross-Process Race):          FAILED
- Stop Condition 10 (Revocation Execution):       FAILED
- Stop Condition 12 (Mock-Only Claims):           FAILED

Required Next Step:
Execute Step 8 Phase 1 Remediation before proceeding to Phase 2.
==================================================
```
