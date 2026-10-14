# FORGE STEP 8 PHASE 2 — IMPLEMENTATION BOUNDARY
## Implementation Boundary, Phasing Strategy, and Non-Regression Guarantees

**Document:** Implementation Boundary Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-implementation-boundary  
**Date:** 2026-10-07  
**Scope:** Strict Phasing Strategy, Production Code Freeze, and Non-Regression Enforcements  

---

## 1. PRODUCTION CODE FREEZE & CURRENT STATE

* **Current Baseline:**
  - Step 6 Governance: CLOSED
  - Step 7A Execution Isolation: CLOSED
  - Step 7B Persistence & Recovery: CLOSED
  - Step 8 Phase 1 Authority Kernel & Delegation Contracts: CLOSED
  - Test Suite: **343 / 343 PASSING**
  - Typecheck / Lint / Build: **ALL GREEN**
* **Strict Architecture Phase Invariant:**
  - Production code in `src/` **MUST NOT BE MODIFIED** during this architecture and specification phase.
  - Zero dependencies may be added to `package.json`.
  - Zero runtime processes, containers, or child planners may be spawned.
  - Multi-agent child execution remains completely locked.

---

## 2. PHASE 2 SUB-PHASING ROADMAP (WHEN AUTHORIZED)

To prevent another monolithic implementation failure and ensure rigorous verification at every step, Phase 2 implementation will be decomposed into **three incremental sub-phases**:

```text
PHASE 2A: SUPERVISOR & SCAFFOLDING
- Host Supervisor daemon
- Child mission directory creation
- Genesis journal.jsonl creation
- IPC control-plane transport
- Zero capability execution yet
              │
              ▼ [Verify 2A tests & audit]
PHASE 2B: ISOLATION & PROCESS BINDING
- Windows Job Object / Linux cgroup binding
- ContainerEnvironment driver integration
- Read-only rootfs mount jail
- Cascade process-tree kill primitive
- Child Authority Gate integration
              │
              ▼ [Verify 2B tests & audit]
PHASE 2C: RECEIPT & SETTLEMENT ENGINE
- Receipt generation in child
- 6-Point Parent ReceiptVerifier
- Child ledger replay verification
- Multi-dimensional budget reconciliation
- Crash Audit Daemon integration
              │
              ▼ [Full hostile audit of Phase 2]
```

### 2.1 Sub-Phase 2A: Host Supervisor & Child Mission Scaffolding
* **Components:**
  - `src/multi-agent/supervisor.ts`: Manages child mission directories (`missions/<childMissionId>/`), genesis ledgers, and IPC channels.
  - `src/multi-agent/ipc.ts`: Type-safe control plane transport over local sockets / named pipes.
* **Invariant:** Scaffolding only; child process runs an echo/init loop without capability dispatch.

### 2.2 Sub-Phase 2B: Child Execution Isolation & Process Group Binding
* **Components:**
  - `src/multi-agent/process-jail.ts`: Windows Job Object / Linux cgroup wrapper binding child PIDs and process trees.
  - `src/multi-agent/child-host.ts`: Instantiates Child Authority Gate and Capability Host inside isolation.
  - Revocation handler: Hooks `taskkill /T /F` or container kill on `delegation.revoked`.
* **Invariant:** Child can dispatch proposals to local Gate, but cannot escape mounts or survive revocation.

### 2.3 Sub-Phase 2C: Receipt Protocol, Verification, & Budget Settlement
* **Components:**
  - `src/multi-agent/receipt-generator.ts`: Hashes evidence artifacts, flushes ledger, signs receipt.
  - `src/multi-agent/receipt-verifier.ts`: Implements the 6-point verification pipeline in parent.
  - `src/multi-agent/settlement.ts`: Reconciles escrowed budget into consumed and refunded allocations.
  - `src/multi-agent/crash-audit.ts`: Implements the Crash Audit Daemon for `UNCERTAIN` spend.
* **Invariant:** End-to-end multi-agent DAG task completion.

---

## 3. NON-REGRESSION GUARANTEES

Before any future sub-phase code is merged, the following test suites must remain 100% green:
1. **Core Runtime Suite (301 tests):**
   - Step 6 Empirical Governance Suite (F-01 through F-09).
   - Step 7A Container Isolation Suite (SANDBOX-001 through SANDBOX-010, FREEZE-001 through FREEZE-004).
   - Step 7B Persistence & Recovery Suite (CRASH-001 through CRASH-030).
2. **Phase 1 Authority Kernel Suite (42 tests):**
   - 22 Base Phase 1 security tests (`test/multi-agent/phase1.test.ts`).
   - 20 Remediation tests (`test/multi-agent/remediation.test.ts`, `P1R-001` through `P1R-020`).
3. **Phase 2 Acceptance Tests (35 tests):**
   - Acceptance matrix tests `MA-001` through `MA-035`.
