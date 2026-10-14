# FORGE STEP 8 — MULTI-AGENT AUTHORITY ARCHITECTURE
## Master Architectural Specification

**Status:** ARCHITECTURE DESIGN & FORMAL SPECIFICATION  
**Version:** FORGE v1.3-spec  
**Authors:** Principal Systems Architect & Security Engineering  
**Prerequisites:** Step 6 (Governance), Step 7A (Execution Isolation), Step 7B (Persistence & Crash Recovery) — ALL FROZEN  

---

## 1. EXECUTIVE SUMMARY & ARCHITECTURAL FOUNDATION

FORGE Step 8 extends the single-agent governed execution engine into a **hierarchical multi-agent authority system**.

### 1.1 What Step 8 Is NOT
- It is **NOT** "agent chat", peer-to-peer conversational LLM swarms, or collaborative brainstorming boards.
- It is **NOT** an operationalization of unconstrained delegation where an agent can spawn unlimited subagents.
- It is **NOT** an execution bypass around the Authority Gate, Capability Host, Container Sandboxing, or Cryptographic Ledger.

### 1.2 What Step 8 IS
Step 8 is a **formally governed, attenuated, crash-safe, multi-agent authority engine**. It treats multi-agent delegation strictly as **an authorization and resource partitioning problem**.

```text
                             ROOT MISSION AUTHORITY (A_root)
                                           │
                                  PARENT AGENT (A_P)
                                           │
                         [Delegation Proposal & Attenuation]
                                           │
                                  AUTHORITY GATE
                                           │
                      ┌────────────────────┴────────────────────┐
                      ▼                                         ▼
             CHILD AGENT 1 (A_C1)                      CHILD AGENT 2 (A_C2)
                      │                                         │
             [Isolated Sub-Mission]                    [Isolated Sub-Mission]
                      │                                         │
             [Content-Addressed Receipt]               [Content-Addressed Receipt]
                      │                                         │
                      └────────────────────┬────────────────────┘
                                           ▼
                               PARENT VERIFICATION GATE
                                           │
                               [Budget Reconciliation]
                                           │
                             PARENT STATE UPDATE & DAG ADVANCE
```

### 1.3 The Central Authority Invariant
$$\mathbf{A}_{\text{child}} \subseteq \mathbf{A}_{\text{parent}} \subseteq \mathbf{A}_{\text{root}} \quad \land \quad \mathbf{A}_{\text{child}} \not\supset \mathbf{A}_{\text{parent}}$$

**Fundamental Rule:** No child agent may ever obtain, request, execute, or inherit authority greater than its parent. Any attempt to widen capability envelopes, expand risk tiers, lengthen expiration, escape sandbox isolation, or exceed remaining budgets is mechanically rejected at the Authority Gate before any execution occurs.

---

## 2. THE NON-NEGOTIABLE ARCHITECTURAL PIPELINE

The core execution invariant of FORGE remains mathematically inviolate across all agents at all delegation depths:

$$\text{MODEL} \to \text{PROPOSAL} \to \text{AUTHORITY GATE} \to \text{CAPABILITY HOST} \to \text{ISOLATION} \to \text{EVIDENCE} \to \text{LEDGER} \to \text{VERIFICATION} \to \text{STATE}$$

1. **Child Agents Are Untrusted Principals:** A child agent is an autonomous software entity driven by untrusted model outputs. The fact that a child was spawned by FORGE gives it zero baseline authority.
2. **Delegation Is Authorization, Not Communication:** Spawning an agent or sending an instruction is an authorization transaction. Messages never implicitly confer authority.
3. **Plan & State Non-Interference:** Child agents possess their own isolated sub-missions and sub-plans. A child agent **cannot directly mutate parent mission state, parent plans, parent grants, or the parent ledger**.
4. **Verifiable Receipts Only:** Parent progress advances solely upon ingestion of cryptographically bound, mechanically verified **Delegation Receipts**. Textual claims of task completion from child agents are ignored.

---

## 3. CONTROL PLANE VS. DATA PLANE SEPARATION

To eliminate authority laundering, prompt injection privilege escalation, and confused deputy vulnerabilities, FORGE strictly bifurcates multi-agent operations into two orthogonal planes:

```mermaid
flowchart TD
    subgraph ControlPlane ["CONTROL PLANE (Governed & Ledger-Backed)"]
        DP[Delegation Proposal] --> AG[Authority Gate / Attenuation]
        AG --> DG[Delegation Grant Escrow]
        DG --> MA[Child Mission Activation]
        MA --> CR[Cascade Revocation]
        MA --> DR[Delegation Receipt Verification]
    end

    subgraph DataPlane ["DATA PLANE (Untrusted Content)"]
        Msg[Agent-to-Agent Findings] --> Context[Model Context Ingestion]
        Art[Shared Read-Only Artifacts] --> Input[Task Input Data]
    end

    ControlPlane -.->|Establishes Grants & Boundaries| DataPlane
    DataPlane -.x|CANNOT Grant Authority or Mutate State| ControlPlane
```

### 3.1 Control Plane
- Governs lifecycle, authorization, budget escrow, revocation, and receipt verification.
- Every control plane event is an immutable, hash-chained record in the cryptographic ledger:
  - `delegation.proposed`
  - `delegation.authorized`
  - `delegation.activated`
  - `delegation.revoked`
  - `delegation.receipt_verified`
  - `delegation.closed`
- Processed strictly by mechanical code; models have zero ability to alter control plane logic.

### 3.2 Data Plane
- Encompasses informational findings, intermediate research documents, parse trees, and structured data passed between agents.
- **Untrusted by default:** Ingested into agent model prompts inside untrusted data envelopes (`<untrusted_child_data>` per INV-14) to prevent prompt injection from turning data into control instructions.

---

## 4. TOPOLOGY: STRICT TREE TOPOLOGY (NO DAGS, NO CYCLES)

FORGE strictly constrains multi-agent delegation to a **finite rooted tree**:

$$T = (V, E), \quad r = \text{RootAgent}, \quad |E| = |V| - 1$$

1. **Single Parent Monogamy:** Every non-root agent $C \in V \setminus \{r\}$ has exactly one parent $P \in V$ such that $(P, C) \in E$.
2. **Acyclic Guarantee:** Paths are strictly directed away from the root. If $(u, v) \in E$, there is no directed path from $v$ to $u$. Cycle creation ($A \to B \to A$) is structurally impossible.
3. **Bounded Depth:** The length of any path from $r$ to a leaf agent is bounded by $\text{depth}(v) \le D_{\max}$ (default: 2, hard max: 3).
4. **Bounded Fanout:** Any agent $P$ may spawn at most $F_{\max}$ concurrent active children (default: 3).
5. **Bounded Total Descendants:** The total number of active descendant agents across the mission tree cannot exceed $N_{\max}$ (default: 10).

---

## 5. CAPABILITY GOVERNANCE IN MULTI-AGENT EXECUTION

When a child agent executes a capability (e.g. `fs.read`, `shell`, `http`), it must pass through the exact same Authority Gate and Capability Host as root agents.

### 5.1 Full 5-Tuple Ledger Attribution
Every capability execution record in the ledger permanently binds 5 cryptographic identifiers:
$$\text{Attribution} = \langle \text{capabilityId}, \text{grantId}, \text{delegationId}, \text{agentId}, \text{missionId} \rangle$$

There is no execution path where an action is attributed merely to "an agent" or where a child executes under its parent's grant directly.

### 5.2 Isolation Profile Inheritance & Monotonicity
- If Parent requires `sandboxed` (container isolation), Child **MUST** run in `sandboxed` isolation.
- A child cannot request or receive `host` execution unless the parent possesses an active `allowHostExecution` grant AND explicitly passes it down through the Authority Gate.
- A sandboxed child container has separate workspace mounts, separate tempfs, and zero access to peer containers or host control sockets.

---

## 6. LEDGER ARCHITECTURE: CHILD SUB-LEDGERS ANCHORED VIA RECEIPT TIPS

We evaluated three potential ledger topologies for multi-agent execution:

| Ledger Architecture | Crash Recovery | Isolation | Tamper Detection | Assessment |
| :--- | :--- | :--- | :--- | :--- |
| **A. Single Shared Ledger** | Poor (writers lock contend) | Zero (cross-agent write hazard) | Monolithic | ❌ **Rejected:** Concurrent child writes cause mutex serialization bottlenecks and torn-tail cascading across agents. |
| **B. Sub-Ledgers Anchored via Receipt Tips** | Excellent (independent crash domains) | Absolute (each mission has separate journal) | Cryptographically linked via SHA-256 tips | 🟢 **SELECTED:** Child maintains private journal; parent ledger stores cryptographic receipt binding child tip. |
| **C. Event Journal + CQRS Projections** | Complex | Moderate | Weak audit | ❌ **Rejected:** Excessive layer complexity without additional security guarantees. |

### 6.1 Selected Architecture: Option B
1. **Child Sub-Mission Journal:** Child mission $M_C$ possesses its own isolated `dataDir/missions/mis_child/journal.jsonl` with independent `fsyncSync()` durability and single-host mutex locking.
2. **Parent Anchoring:** When Child $M_C$ completes, it generates a `DelegationReceipt` containing:
   $$\text{receipt}.\text{childLedgerTip} = \text{hash of child journal's final record}$$
3. **Parent Ledger Commit:** Parent stores `delegation.receipt_verified` containing `receipt.childLedgerTip` and all content-addressed evidence hashes.
4. **Zero-Contention Durability:** Child crashes, journal replays, or torn tail truncations in Child $M_C$ are strictly quarantined within $M_C$'s directory and never corrupt or stall the parent journal.

---

## 7. SYSTEM INVARIANTS INTRODUCED IN STEP 8

- **INV-21 (Authority Attenuation):** $\forall C, P: A_C \subseteq A_P \subseteq A_{root} \land A_C \not\supset A_P$.
- **INV-22 (Delegation Non-Escalation):** No grant parameter in a child grant may exceed the parent's active grant.
- **INV-23 (Budget Conservation & Escrow):** Parent unallocated budget is strictly decremented upon child authorization and held in escrow. Total consumed + escrowed $\le$ Total allocated.
- **INV-24 (Delegation Lifetime Bound):** $\text{child}.\text{expiresAt} \le \text{parent}.\text{expiresAt}$.
- **INV-25 (Revocation Monotonicity):** Revocation of parent grant $G_P$ instantly cascades to invalidate all descendant grants $G_C \in \text{Descendants}(G_P)$.
- **INV-26 (Parent/Child Plan & State Isolation):** Child agents cannot directly mutate parent DAG state, tasks, or budgets.
- **INV-27 (Receipt Authenticity & Verification):** Parent state advances solely upon mechanical verification of content-addressed receipts binding the child ledger tip.
- **INV-28 (No Authority From Messages):** Data plane messages convey zero authority and are treated as untrusted input.
- **INV-29 (Crash-Safe Delegation Recovery):** Recovery never resurrects revoked delegations, never un-escrows spent budgets, and preserves post-effect-unknown status.
- **INV-30 (Multi-Agent Capability Attribution):** Every capability execution permanently records agent, delegation, mission, and grant identities in the hash chain.

---

*Authored by Principal Systems Architect & Security Engineering.*
