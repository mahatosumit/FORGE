# FORGE STEP 8 — REMEDIATED AUTHORITY & EFFECTIVE ATTENUATION MODEL

**Document:** Formal Specification — Remediated Effective Authority & Closed-World Attenuation  
**Status:** REMEDIATED ARCHITECTURAL SPECIFICATION  
**Version:** FORGE v1.3-remediated-authority  
**Date:** 2026-10-07  
**Remediates:** Finding S8-01 (Critical), Finding S8-02 (Critical)  
**Authors:** Principal Security Architect & Adversarial Engineering  

---

## 1. THE EFFECTIVE AUTHORITY THEOREM

In a governed multi-agent architecture, authority cannot be evaluated based on raw, partial user or model requests. Authority is determined strictly by calculating the **Child Effective Authority Domain** from the **Parent Effective Authority Domain** and the **Child Requested Domain**:

$$\mathbf{A}_{\text{child}}^{\text{eff}} = \mathbf{A}_{\text{parent}}^{\text{eff}} \sqcap \mathbf{A}_{\text{child}}^{\text{req}}$$

Where:
- $\sqcap$ is the formal **Attenuation Intersection Operator**.
- For every dimension $d$, the relation $\mathbf{A}_{\text{child}}^{\text{eff}}[d] \subseteq \mathbf{A}_{\text{parent}}^{\text{eff}}[d]$ is mechanically verified.
- **Closed-World Constraint Rule:** An omitted, null, or undefined field in $\mathbf{A}_{\text{child}}^{\text{req}}$ **NEVER** means "unlimited" or "unconstrained". Absence of an explicit constraint in a child request causes the child to either **strictly inherit the parent's constraint** or **collapse to the empty set ($\emptyset$)**, depending on the safety profile of the dimension.

```text
       Parent Effective Authority Domain (A_parent)
                         │
                         ▼
        Child Requested Domain (A_child_req)
                         │
                         ▼
             [ATTENUATION INTERSECTION (⊓)]
         Closed-World Inheritance & Narrowing
                         │
                         ▼
       Child Effective Authority Domain (A_child_eff)
         └── MUST SATISFY: A_child_eff ⊆ A_parent
```

---

## 2. FORMAL ATTENUATION RULES ACROSS ALL 20 AUTHORITY DIMENSIONS

Every authority dimension has an explicit parent domain, child requested domain, ordering relation, and attenuation operation.

### 2.1 Capabilities
- **Parent Domain:** Set of active capability IDs $C_P \subseteq \text{CapabilityRegistry}$.
- **Child Request:** Set of requested capability IDs $C_{\text{req}}$.
- **Attenuation Operation:** $C_C^{\text{eff}} = C_P \cap C_{\text{req}}$.
- **Rule:** If $C_{\text{req}} \not\subseteq C_P$, the delegation proposal is rejected with `CapabilityEscalationError`.
- **Omitted / Undefined:** If omitted, $C_C^{\text{eff}} = \emptyset$ (fail-closed; zero capabilities granted).

### 2.2 Shell Commands (`argvClass`)
- **Parent Domain:** `ArgvClass` ($P_{\text{argv}}$: exact, argv-prefix, argv-regex).
- **Child Request:** `ArgvClass` ($C_{\text{argv}}$).
- **Attenuation Operation:** Exact covers identical or longer exact; prefix covers longer prefix; regex covers identical regex anchors.
- **Rule:** Widening from exact to prefix or regex is forbidden.
- **Omitted / Undefined:** If parent has `argvClass` and child omits it, child inherits parent's exact $P_{\text{argv}}$.

### 2.3 Filesystem Paths (`paths`)
- **Parent Domain:** Set of authorized canonical workspace prefixes $Paths_P$.
- **Child Request:** Set of requested prefixes $Paths_{\text{req}}$.
- **Attenuation Operation:**
  $$\forall p_c \in Paths_{\text{req}}, \quad \exists p_p \in Paths_P : \text{PathPrefix}(p_c) \subseteq \text{PathPrefix}(p_p)$$
  $$Paths_C^{\text{eff}} = Paths_{\text{req}}$$
- **Traversals:** `..`, symlinks, and absolute paths are resolved against realpath before evaluation.
- **Omitted / Undefined (Remediates S8-01):** If parent defines $Paths_P$ and child omits `paths`, child **inherits** $Paths_P$ (or defaults to designated sub-workspace jail `/workspace/subtasks/del_<id>/`). An omitted path field **never** defaults to full workspace access.

### 2.4 Network Endpoints (`hosts` & `methods`)
- **Parent Domain:** $Hosts_P \subseteq \text{HostPattern}$, $Methods_P \subseteq \{ \text{"GET"}, \text{"HEAD"} \}$.
- **Child Request:** $Hosts_{\text{req}}$, $Methods_{\text{req}}$.
- **Attenuation Operation:**
  $$Hosts_C^{\text{eff}} = Hosts_{\text{req}} \cap Hosts_P, \quad Methods_C^{\text{eff}} = Methods_{\text{req}} \cap Methods_P$$
- **Wildcards:** `*.domain.com` covers subdomains `sub.domain.com`. A parent with `api.example.com` **blocks** a child request for `*.example.com` (widening).
- **Omitted / Undefined (Remediates S8-01):** If parent defines $Hosts_P$ and child omits `hosts`, child **inherits** $Hosts_P$. If parent has `hosts = []`, child cannot request network access. For `web_fetch` and `http`, an omitted `hosts` constraint in active grant evaluates as **zero network access allowed** ($\emptyset$).

### 2.5 MCP Servers (`mcpServers`) (Remediates S8-02)
- **Parent Domain:** Set of permitted MCP server identifiers $Servers_P$.
- **Child Request:** Set of requested server identifiers $Servers_{\text{req}}$.
- **Attenuation Operation:** $Servers_C^{\text{eff}} = Servers_P \cap Servers_{\text{req}}$.
- **Rule:** If $Servers_{\text{req}} \not\subseteq Servers_P$, reject proposal with `McpServerNotCoveredError`.
- **Omitted / Undefined:** Inherits $Servers_P$, or if parent has none, $Servers_C^{\text{eff}} = \emptyset$.

### 2.6 MCP Tools (`mcpTools`) (Remediates S8-02)
- **Parent Domain:** Set of permitted tool names $Tools_P$ formatted as `serverId.toolName` or `serverId.*`.
- **Child Request:** Set of requested tool names $Tools_{\text{req}}$.
- **Attenuation Operation:** Every tool in $Tools_{\text{req}}$ must match an exact tool or wildcard pattern in $Tools_P$.
- **Rule:** $Tools_C^{\text{eff}} = Tools_{\text{req}} \cap Tools_P$. Widening from `server.toolA` to `server.*` is blocked.
- **Omitted / Undefined:** Inherits parent tool set.

### 2.7 Risk Tier (`riskCeiling`)
- **Parent Domain:** Maximum risk ceiling $R_P \in \{ \text{read}, \text{write}, \text{execute}, \text{network}, \text{secret} \}$.
- **Child Request:** $R_{\text{req}}$.
- **Attenuation Operation:**
  $$R_C^{\text{eff}} = \min(R_P, R_{\text{req}}) \quad \text{under order } \text{read} < \text{write} < \text{execute} < \text{network} < \text{secret}$$
- **Omitted / Undefined:** Inherits parent's $R_P$.

### 2.8 Isolation Profile (`isolationProfile`) (Remediates S8-02)
- **Parent Domain:** $Iso_P \in \{ \text{"sandboxed"}, \text{"sandboxed-network"}, \text{"host"} \}$.
- **Strictness Order:** $\text{sandboxed} > \text{sandboxed-network} > \text{host}$.
- **Child Request:** $Iso_{\text{req}}$.
- **Attenuation Operation:**
  $$\text{Strictness}(Iso_C^{\text{eff}}) \ge \text{Strictness}(Iso_P)$$
- **Rule:** If parent is `sandboxed`, child **MUST** be `sandboxed`. Any child request for `host` when parent is `sandboxed` is rejected with `IsolationMonotonicityError`.
- **Omitted / Undefined:** Inherits parent's isolation profile.

### 2.9 Host Execution Right (`allowHostExecution`) (Remediates S8-02)
- **Parent Domain:** $HostExec_P \in \{ \text{true}, \text{false} \}$.
- **Child Request:** $HostExec_{\text{req}} \in \{ \text{true}, \text{false} \}$.
- **Attenuation Operation:** $HostExec_C^{\text{eff}} = HostExec_P \land HostExec_{\text{req}}$.
- **Rule:** If $HostExec_P = \text{false}$, child request for `true` is rejected immediately.
- **Omitted / Undefined:** Defaults to `false`.

### 2.10 Execution Provider
- **Parent Domain:** Fixed runtime execution environment (`docker`, `podman`).
- **Child Request:** Child has **zero control** over execution provider.
- **Rule:** Fixed by host supervisor; immutable and unrequestable.

### 2.11 Model Calls
- **Parent Domain:** Remaining unallocated model calls $N_{\text{parent}}$.
- **Child Request:** Requested escrow $N_{\text{child}}$.
- **Attenuation Operation:** $N_C^{\text{eff}} \le N_{\text{parent}}$. Deducted into escrow.
- **Omitted / Undefined:** Defaults to $\min(10, N_{\text{parent}})$.

### 2.12 Tokens (`maxTokens`)
- **Parent Domain:** Remaining unallocated tokens $T_{\text{parent}}$.
- **Child Request:** Requested tokens $T_{\text{child}}$.
- **Attenuation Operation:** $T_C^{\text{eff}} \le T_{\text{parent}}$. Atomic CAS escrow deduction.
- **Omitted / Undefined:** Defaults to $\min(50000, T_{\text{parent}})$.

### 2.13 Monetary Cost / Budget
- **Parent Domain:** Remaining monetary units $M_{\text{parent}}$.
- **Child Request:** $M_{\text{child}} \le M_{\text{parent}}$. Escrowed atomically.

### 2.14 Execution Time (`maxExecutionTimeMs`)
- **Parent Domain:** Remaining mission execution window $Time_P$.
- **Child Request:** $Time_{\text{req}}$.
- **Attenuation Operation:** $Time_C^{\text{eff}} = \min(Time_P, Time_{\text{req}})$.

### 2.15 Artifact Bytes (`maxArtifactBytes`)
- **Parent Domain:** Remaining disk quota $Bytes_P$.
- **Child Request:** $Bytes_{\text{req}}$.
- **Attenuation Operation:** $Bytes_C^{\text{eff}} = \min(Bytes_P, Bytes_{\text{req}})$.

### 2.16 Subprocess Count (`maxSubprocesses`)
- **Parent Domain:** Max subprocess concurrency limit $K_P$.
- **Child Request:** $K_{\text{req}}$.
- **Attenuation Operation:** $K_C^{\text{eff}} = \min(K_P, K_{\text{req}})$.

### 2.17 Task Concurrency (`maxConcurrentTasks`)
- **Parent Domain:** Concurrency limit $Conc_P$.
- **Child Request:** $Conc_{\text{req}}$.
- **Attenuation Operation:** $Conc_C^{\text{eff}} = \min(Conc_P, Conc_{\text{req}})$.

### 2.18 Delegation Depth (`depth`)
- **Parent Domain:** $Depth_P \in [0, D_{\max}-1]$.
- **Child Value:** $Depth_C = Depth_P + 1 \le D_{\max}$ (hard limit: 2).
- **Rule:** Fixed arithmetic increment; child cannot request or set its own depth.

### 2.19 Child Fanout (`maxChildren`)
- **Parent Domain:** Maximum concurrent child delegations $F_{\max} \le 3$.
- **Rule:** Enforced under parent ledger lock against active delegation count.

### 2.20 Process Lifetime (`expiresAt`)
- **Parent Domain:** $Exp_P \in \text{Iso8601} \cup \{ \text{null} \}$.
- **Child Request:** $Exp_{\text{req}}$.
- **Attenuation Operation:**
  $$\text{If } Exp_P \ne \text{null}: \quad Exp_C^{\text{eff}} \le Exp_P \quad (\text{child cannot be null or later than parent})$$
  $$\text{If } Exp_P = \text{null}: \quad Exp_C^{\text{eff}} = Exp_{\text{req}}$$

---

## 3. UPDATED MACHINE-CHECKABLE DELEGATION SCHEMAS

```typescript
import { z } from "zod";
import {
  CapabilityIdSchema,
  ConstraintsSchema,
  GrantIdSchema,
  Iso8601Schema,
  MissionIdSchema,
  RiskClassSchema,
  Sha256HexSchema,
} from "./base.js";

export const EffectiveAuthorityEnvelopeSchema = z.object({
  capabilities: z.array(CapabilityIdSchema).min(1).max(32),
  constraints: ConstraintsSchema.strict(),
  riskCeiling: RiskClassSchema,
  isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]),
  allowHostExecution: z.boolean(),
  budgetEscrow: z.object({
    maxPlannerTurns: z.number().int().min(1).max(50),
    maxModelCalls: z.number().int().min(1).max(100),
    maxTokens: z.number().int().min(1000).max(2_000_000),
    maxCapabilityCalls: z.number().int().min(1).max(100),
    maxRetries: z.number().int().min(0).max(20),
    maxExecutionTimeMs: z.number().int().min(1000).max(3600_000),
    maxArtifactBytes: z.number().int().min(1024).max(100 * 1024 * 1024),
    maxConcurrentTasks: z.number().int().min(1).max(5),
  }).strict(),
  expiresAt: Iso8601Schema.nullable(),
}).strict();

export type EffectiveAuthorityEnvelope = z.infer<typeof EffectiveAuthorityEnvelopeSchema>;
```

---

## 4. RESOLUTION OF HOSTILE AUDIT FINDINGS

- **S8-01 (Closed):** Closed-world inheritance is mathematically defined. Any omitted field in child requested constraints is either strictly inherited from the parent or assigned $\emptyset$. Undefined hosts/paths evaluate to zero network/workspace access at the Gate.
- **S8-02 (Closed):** MCP servers, MCP tools, risk tiers, isolation profiles, and `allowHostExecution` are formally integrated into the Effective Authority Envelope and evaluated during attenuation.

---

*Authored by Principal Security Architect & Adversarial Engineering.*
