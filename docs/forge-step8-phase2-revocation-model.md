# FORGE STEP 8 PHASE 2 — REVOCATION MODEL
## Cascade Revocation & Physical Execution Containment Model

**Document:** Cascade Revocation Specification — Step 8 Phase 2  
**Status:** SPECIFICATION COMPLETE  
**Version:** FORGE v1.4-step8-phase2-revocation-model  
**Date:** 2026-10-07  
**Scope:** Multi-Tier Revocation Propagation, Process-Tree Annihilation, and Physical Execution Boundary Containment  

---

## 1. MULTI-TIER CASCADE REVOCATION HIERARCHY

Consider a multi-agent delegation tree:

$$\text{Root} \longrightarrow A \longrightarrow B \longrightarrow C$$

Where $A$ is a direct child of Root, $B$ is a grandchild, and $C$ is a great-grandchild.

### 1.1 The Revocation Rule
$$\text{Revoke}(A) \implies \text{Revoked}(A) \land \text{Revoked}(B) \land \text{Revoked}(C)$$

When $A$ is revoked by the Root Supervisor:
1. $A$ status transitions to `REVOKED`.
2. All descendants discovered via `ancestorPath` ($B$ and $C$) immediately transition to `REVOKED`.
3. In `MultiAgentProjection`:
   $$\forall d \in \text{Registry}: \text{if } A \in d.\text{ancestorPath} \implies \text{isLineageActive}(d.\text{delegationId}) = \mathbf{false}$$

---

## 2. PHYSICAL EXECUTION SURFACE CONTAINMENT & SECURITY BOUNDARY

Revocation operates on two complementary planes:
1. **The Security Boundary (Authority Gate):** The mechanical fail-closed barrier that prevents any future proposal dispatch.
2. **The Containment Mechanism (Host Supervisor):** Best-effort bounded process-tree termination via OS Job Object (`taskkill /T /F` on Windows) or container kill.

| Execution Surface | Status Upon Revocation | Action Taken by Runtime / Supervisor | Mechanical Guarantee |
|---|---|---|---|
| **Pending Proposal** | **DENIED** | Authority Gate intercepts proposal; checks `projection.isLineageActive()`. Emits `type: "reject"`, `reasonCode: "delegation-revoked"`. | Zero dispatch to Host. Authority Gate is the absolute security boundary. |
| **Queued Proposal** | **CANCELLED** | Proposal queue in Planner / Host is flushed and discarded. | Never evaluated. |
| **Running OS Process** | **KILLED** | Host Supervisor executes bounded process-tree termination via Windows Job Object (`taskkill /T /F`) or container kill. | Best-effort bounded termination (< 100ms). |
| **Child Subprocesses** | **KILLED** | OS Job Object guarantees that any grandchild or detached background process in the job is terminated. | Process group cleanup; zero unmanaged daemons. |
| **Active Network Sockets** | **ABORTED** | Host proxy or sandbox network namespace forcibly closes TCP sockets with `RST`. In-flight payloads severed. | Connection severed; no further transmission. |
| **Child Container** | **STOPPED** | Host container driver executes `docker kill <containerId>`. Rootfs unmounted. | Complete environment containment. |
| **Grandchild Agent** | **REVOKED** | Grandchild Authority Gate rejects all proposals (`reasonCode: "delegation-revoked"`). Process tree terminated. | Descendant lineage revoked and contained. |
| **In-Flight Dispatched Call** | **EFFECT_UNKNOWN** | If revocation arrives while a capability is mid-execution, execution cannot be magically "undone". Classified as `POST_EFFECT_UNKNOWN`. | Fails closed; escalated to audit. |

---

## 3. EXPLICIT POLICY: DOES A GRANDCHILD CONTINUE READ-ONLY WORK?

### Policy Statement: STRICT FAIL-CLOSED (NO READ-ONLY CONTINUATION)
An ambiguous design might ask: *"Can Grandchild C finish its read-only query while Parent B is being revoked?"*

In FORGE Step 8 Phase 2, the answer is an unambiguous **NO**:
1. When an ancestor is revoked, the entire lineage has lost its mandate of trust.
2. An agent performing "read-only" work still consumes token budget, model calls, and compute resources.
3. Reading confidential files or exfiltrating data under a revoked parent represents an unacceptable security vulnerability.
4. Therefore:
   $$\forall \text{proposal } P: \quad \text{LineageActive}(dId) = \mathbf{false} \implies \text{GateVerdict} = \mathbf{REJECT}$$
   No distinction is made between mutating and read-only proposals. All proposals fail closed immediately.

---

## 4. NO MAGIC ATOMIC UNDO: PHYSICAL REALITY BOUNDARY

A critical architectural principle of FORGE is honesty regarding physical side effects:
* **We DO NOT claim atomic cancellation of real-world effects.**
* If an HTTP POST request has already left the network interface card and reached an external server before the revocation signal arrived, software cannot "un-send" the TCP packets.
* The system handles this boundary with mathematical rigor:
  1. The proposal was dispatched.
  2. The revocation arrives before observation capture.
  3. The task is classified as `POST_EFFECT_UNKNOWN`.
  4. The escrowed budget is quarantined in `UNCERTAIN`.
  5. The parent DAG task is marked `FAILED` or `ESCALATED`.
  6. The operator is notified of the exact boundary seam.
