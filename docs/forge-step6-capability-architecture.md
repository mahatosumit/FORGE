# FORGE STEP 6: CAPABILITY ECOSYSTEM & GOVERNANCE ARCHITECTURE

## Architectural Specification & Design Blueprint

### Executive Summary

Step 6 defines the production-grade **Capability Ecosystem and Governance Layer** for FORGE. The objective is not merely to add more tools, but to transform capabilities into a first-class, typed, versioned, permissioned, auditable, revocable, resource-bounded, and provider-neutral system.

### Non-Negotiable Core Invariant

The single execution choke point of FORGE is preserved without exception:

$$\begin{aligned}
\text{Model / Planner} &\longrightarrow \text{Structured Decision} \longrightarrow \text{Autonomy Policy (L0–L4)} \\
&\longrightarrow \mathbf{Proposal} \longrightarrow \mathbf{Authority\ Gate} \longrightarrow \mathbf{Capability\ Host} \\
&\longrightarrow \text{Evidence Capture} \longrightarrow \mathbf{Cryptographic\ Ledger} \\
&\longrightarrow \text{Mechanical Verification} \longrightarrow \text{State Update} \longrightarrow \text{Loop}
\end{aligned}$$

**Cardinal Governance Invariant:**  
A capability implementation **NEVER** receives authority merely because it is registered. Registration establishes capability metadata, schemas, and bindings; execution authority is derived **solely and exclusively** from active, unexpired, machine-checkable **Grants** evaluated at runtime by the **Authority Gate**.

---

## 1. Goals

1. **First-Class Registry**: Provide a centralized, strongly typed, immutable registry (`CapabilityRegistry`) for all capabilities (built-in, sidecars, MCP adapters, and plugins).
2. **Explicit Risk & Side-Effect Profiles**: Classify capabilities into formalized risk tiers (R0 through R4) with explicit declarations of idempotency, side effects, and concurrency requirements.
3. **Strict Versioning & Pinning**: Enforce SemVer compatibility and pin task executions to exact capability versions (`capabilityId@version`) to prevent silent runtime substitution or drift.
4. **Runtime Revocation & Circuit Breakers**: Enable instantaneous revocation via grant expiry, capability disablement, or emergency kill switches, enforced strictly at dispatch time.
5. **Unified Resource Governance**: Integrate capability execution resource boundaries (execution timeouts, output limits, artifact sizes, subprocess limits) into the existing mission budget engine without secondary budget systems.
6. **Zero-Trust Discovery**: Treat capability discovery and documentation strictly as passive data (`provenance: "runtime-framing"`), preventing prompt injection from weaponizing tool descriptions.
7. **Universal Adapter Model**: Model MCP, Web, Shell, and Document ingestion through identical governed capability contracts.

---

## 2. Non-Goals

1. **No Direct Execution**: The model is never permitted to invoke capability functions, APIs, or subprocesses directly.
2. **No Autonomous Grant Creation**: The autonomous model cannot grant itself authority, modify active grants, or widen its permissions.
3. **No Unconstrained Dynamic Imports**: Registration does not dynamically evaluate unvetted remote JavaScript or load arbitrary foreign modules into the kernel.
4. **No Parallel Authorization Plane**: The registry does not make authorization decisions; the Authority Gate remains the sole arbiter of permission.
5. **No Model-Claim Verification**: Capabilities do not report self-adjudicated success; verification remains strictly mechanical and independent.

---

## 3. Capability Model

A capability in FORGE consists of four decoupled planes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DISCOVERY PLANE (Data)                          │
│   Manifests, Argument Schemas, Output Schemas, Risk Profiles           │
│   Model Context: Passive schema documentation (INV-14 isolated)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        AUTHORITY PLANE (Policy)                        │
│   Grants, Constraints, Attenuation, Expiry, Authority Gate             │
│   Runtime Evaluation: Proposal vs Active Grants                        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Allow Verdict
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        EXECUTION PLANE (Host)                          │
│   CapabilityHost, Environments (Local/Container), Secrets Redaction   │
│   Effect Seam: Subprocess execution, Network requests, File I/O       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        AUDIT PLANE (Ledger)                            │
│   Content-Addressed Artifacts, Append-Only Records, Mechanical Checks │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Zero Ambient Authority**: Capabilities exist in a dormant state until a proposal matches an active grant issued by an operator or policy.
2. **Deterministic Inputs & Outputs**: Every capability strictly validates input arguments against a Zod schema before gate evaluation, and emits a structured, typed observation record upon execution.
3. **Execution Seam Isolation**: Capability code never directly accesses disk or network; all interactions pass through the governed `DispatchContext` and `Environment` interfaces.

---

## 4. Manifest Schema (`CapabilityManifestV2`)

Building upon the baseline in `src/contracts/grants.ts`, the capability manifest is extended to support comprehensive governance metadata:

```typescript
export interface CapabilityIdentity {
  readonly id: CapabilityId;                 // Dotted namespace (e.g. "fs.write", "web.fetch")
  readonly version: string;                  // Strict SemVer (e.g. "1.2.0")
  readonly manifestHash: Sha256Hex;          // SHA-256 of canonical manifest JSON
  readonly implementationHash: Sha256Hex;    // SHA-256 of implementation source code / bundle
}

export interface DimensionalRiskVector {
  readonly sideEffectScope: "none" | "workspace" | "external-system" | "process-lifecycle";
  readonly networkScope: "none" | "loopback" | "egress-read" | "egress-write";
  readonly resourceIntensity: "negligible" | "bounded" | "heavy-subprocess" | "long-running";
  readonly dataSensitivity: "public" | "workspace-internal" | "secret-bearer";
  readonly injectionRisk: "none" | "trusted-schema" | "untrusted-web" | "untrusted-external-doc";
}

export interface CapabilityManifestV2 {
  // Identity Quad & Versioning
  readonly identity: CapabilityIdentity;
  readonly name: string;                     // Human-readable title
  readonly description: string;              // Functional description for model prompt
  
  // Proposal & Schema Bindings
  readonly proposalKind: string;             // Proposal discriminator (e.g. "fs_write", "web_fetch")
  readonly inputSchema: z.ZodTypeAny;        // Validates Proposal.args
  readonly outputSchema: z.ZodTypeAny;       // Validates Observation record body
  
  // Dual-Layer Risk & Concurrency
  readonly riskTier: RiskTier;               // Coarse Autonomy Tier: R0, R1, R2, R3, R4
  readonly riskVector: DimensionalRiskVector;// Granular Constraint Vector
  readonly sideEffects: readonly SideEffectType[]; // ["workspace_fs", "external_network", "process_spawn"]
  readonly concurrency: "parallel" | "exclusive"; // Exclusive enforces serialization (e.g. shell, git)
  
  // Authority & Constraints
  readonly constraintsVocab: readonly string[]; // Supported constraint keys (e.g. ["paths", "argvClass"])
  readonly requiredGrants: readonly CapabilityId[]; // Pre-requisite capabilities if composed
  
  // Reliability & Idempotency
  readonly idempotency: IdempotencyClass;    // "pure_read" | "idempotent" | "conditionally_idempotent" | "non_idempotent"
  readonly timeoutMs: number;                // Default execution timeout (30,000ms - 120,000ms)
  
  // Resource Bounds
  readonly resourceLimits: {
    readonly maxOutputBytes: number;         // Cap on stdout/stderr or payload bytes
    readonly maxArtifactBytes: number;       // Upper bound on persisted artifacts per invocation
    readonly maxSubprocesses?: number;       // Max concurrent child processes spawned
  };

  // Mechanical Verification Guidance
  readonly verification: {
    readonly defaultStrategy: "exit_code" | "file_state" | "http_status" | "artifact_ref";
    readonly failureSignals: readonly string[]; // Indicators of execution failure in observation
  };

  // Integrity & Provenance
  readonly provenance: {
    readonly pack: string;                   // "core", "mcp-adapter", "community-pack"
    readonly hash: Sha256Hex;                // Cryptographic hash of pack distribution
    readonly signature?: string;             // Optional pack publisher signature
  };

  // Lifecycle Status
  readonly status: "active" | "deprecated" | "quarantined" | "disabled";
}
```

#### Why `capabilityId@version` Alone is Insufficient
Relying solely on `capabilityId@version` leaves the system vulnerable to **implementation substitution attacks** (CAP-018) and **silent dependency drift**:
1. An attacker or rogue script could modify local implementation code in `src/capabilities/*` without bumping the SemVer tag, changing runtime semantics during replay.
2. Build outputs or external dependency versions could shift, altering behavior between initial run and verification replay.
3. By binding execution to the **Cryptographic Identity Quad** `(id, version, manifestHash, implementationHash)`, the ledger and mission engine guarantee bit-exact, tamper-evident determinism across all historical replays. Any divergence triggers immediate hash quarantine.

---

## 5. Registry Architecture (`CapabilityRegistry`)

The `CapabilityRegistry` manages capability lifecycle, lookups, and version resolution:

```
┌────────────────────────────────────────────────────────┐
│                   CapabilityRegistry                   │
├────────────────────────────────────────────────────────┤
│ - registeredManifests: Map<`${id}@${version}`, Manifest│
│ - activeImplementations: Map<`${id}@${version}`, Impl> │
│ - capabilityStatus: Map<id, "active"|"disabled"|...>   │
├────────────────────────────────────────────────────────┤
│ + register(manifest, implementation): void             │
│ + resolve(capabilityId, semverRange?): Descriptor      │
│ + get(capabilityId, exactVersion): Descriptor          │
│ + setStatus(capabilityId, status): void                │
│ + list(filter?): CapabilityDescriptor[]                │
│ + exportModelCards(activeGrantCapabilities): Card[]    │
└────────────────────────────────────────────────────────┘
```

### Registry Guarantees
1. **Immutability After Registration**: Once registered, a `(capabilityId, version)` pair cannot be modified in place. Upgrades require registering a new version.
2. **Explicit Status Overrides**: A capability can be marked `disabled` or `quarantined` globally. If disabled, all proposals for that capability are immediately rejected by the Authority Gate, regardless of existing grants.
3. **Execution Decoupling**: The registry does not execute proposals. It only resolves the typed implementation and manifest to be passed to the `CapabilityHost`.

---

## 6. Risk Classification Model

### Dual-Layer Risk Architecture

A single scalar risk tier (R0–R4) is insufficient by itself because operational risk is multi-dimensional: a tool may perform read-only network egress (R2) which has zero filesystem mutation risk, but carries prompt injection or data exfiltration risks. Conversely, a local file write (R1) carries zero network egress risk but high local state mutation risk.

However, adding unbounded complexity to autonomy decisions creates operational fragility. FORGE resolves this by adopting a **Dual-Layer Risk Model**:

1. **Coarse Autonomy Layer (Scalar Tier R0–R4)**: Used exclusively by the `AutonomyPolicyEngine` (`L0` through `L4`) to determine whether a decision can proceed autonomously or requires human operator escalation.
2. **Granular Constraint Layer (Dimensional Risk Vector)**: Used exclusively by the `Authority Gate` to enforce specific mathematical constraints against active Grants (`paths`, `hosts`, `argvClass`, `secrets`, `mcpTools`).

```
┌────────────────────────────────────────────────────────────────────────┐
│                   COARSE AUTONOMY LAYER (Policy Gating)                │
│   Evaluated by AutonomyPolicyEngine (L0, L1, L2, L3, L4)               │
│   R0: Deterministic Read | R1: Workspace Mut | R2: Net Read            │
│   R3: Net Mut / RPC      | R4: Arbitrary Exec                          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Policy Verdict: PROCEED
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 GRANULAR CONSTRAINT LAYER (Gate Verification)          │
│   Evaluated by Authority Gate against Grant Constraints                │
│   ├─ sideEffectScope:    none | workspace | external | process-life    │
│   ├─ networkScope:       none | loopback | egress-read | egress-write  │
│   ├─ resourceIntensity:  negligible | bounded | heavy-subproc | long   │
│   ├─ dataSensitivity:    public | workspace-internal | secret-bearer   │
│   └─ injectionRisk:      none | trusted-schema | web | external-doc    │
└────────────────────────────────────────────────────────────────────────┘
```

#### Coarse Autonomy Risk Tiers

| Tier | Name | Capabilities | Characteristics | Autonomy Policy Default |
|---|---|---|---|---|
| **R0** | Deterministic Read | `search`, `doc_parse`, `artifact` | Local, deterministic, read-only. Zero state modification. Zero external network egress. | Auto-approved under `L2_SAFE_AUTONOMOUS`, `L3`, `L4` |
| **R1** | Bounded Workspace Mutation | `fs_write`, `fs_patch` | Mutates files strictly confined to workspace root. Governed by `paths` constraints. Reversible via Git. | Requires approval under `L2`; Auto under `L3`, `L4` if granted |
| **R2** | External Network Read | `web_search`, `web_fetch`, `http (GET)` | Reads external web data. Guarded by per-hop `hosts` constraints and SSRF mitigations. | Auto under `L2`, `L3`, `L4` if granted |
| **R3** | External Mutation / RPC | `mcp_call`, `http (POST/PUT/DELETE)` | Causes side effects in external third-party services or MCP servers. Non-idempotent. | Requires operator escalation unless explicit grant active |
| **R4** | Arbitrary Execution / High-Impact | `shell`, `git commit/push` | Executes argv vectors or commits VCS history. Highest risk of system impact. Exclusive concurrency. | Requires explicit argv/path constraints; Operator approval required under `L0`-`L2` |

#### Granular Dimensional Risk Vector Mapping

| Risk Dimension | Possible Values | Constraint Mapping in Authority Gate |
|---|---|---|
| `sideEffectScope` | `none`, `workspace`, `external-system`, `process-lifecycle` | Enforces `paths` constraint (must resolve within `workspaceRoot`). Rejects path traversal. |
| `networkScope` | `none`, `loopback`, `egress-read`, `egress-write` | Enforces `hosts` constraint per redirect hop. Enforces private IP / loopback / metadata block. |
| `resourceIntensity`| `negligible`, `bounded`, `heavy-subprocess`, `long-running` | Checks `timeoutMs` and `maxOutputBytes` against remaining `MissionBudget`. |
| `dataSensitivity` | `public`, `workspace-internal`, `secret-bearer` | Enforces `secretNames` constraint. Pre-registers secrets with redaction engine. |
| `injectionRisk` | `none`, `trusted-schema`, `untrusted-web`, `untrusted-external-doc` | Tags observation with `provenance` ("workspace-content" or "untrusted-web") for INV-14. |

---

## 7. Grant & Authority Gate Interaction

The Authority Gate evaluates proposals against active grants using the manifest's declared constraint vocabulary:

```
[Proposal Received]
        │
        ▼
[Resolve Capability & Version in Registry]
        ├─► (Not Found or Disabled) ──► Gate Verdict: REJECT ("unknown-capability" / "capability-disabled")
        │
        ▼
[Validate Input Arguments against Manifest.inputSchema]
        ├─► (Schema Invalid) ────────► Gate Verdict: REJECT ("rejected-schema")
        │
        ▼
[Match Proposal against Active Grants]
        ├─► (No matching grantId) ────► Gate Verdict: ESCALATE ("out-of-grant")
        │
        ▼
[Evaluate Machine-Checkable Constraints]
   - paths: normalized via pathResolver.resolveReal (checks workspace escape)
   - argvClass: matches prefix or argument vectors
   - hosts: matches authorized domain patterns (guards SSRF / redirect hops)
   - secretNames: verifies secret resolution permissions
   - mcpTools: matches namespaced tool identifiers
        │
        ├─► (Constraint Violated) ────► Gate Verdict: REJECT ("rejected-gate")
        │
        ▼
[Verify Capability Resource Limits <= Mission Remaining Budget]
        ├─► (Budget Insufficient) ───► Gate Verdict: ESCALATE ("budget-insufficient")
        │
        ▼
[Gate Verdict: ALLOW(grantId, verifiedConstraints)]
```

---

## 8. Capability Versioning & Mission Pinning

To prevent silent capability drift or breaking schema changes during long-running missions:

1. **Strict Semantic Versioning**:
   - `PATCH` (e.g. `1.0.0` $\to$ `1.0.1`): Bug fixes, parser hardening, internal optimizations. Schema unchanged.
   - `MINOR` (e.g. `1.0.0` $\to$ `1.1.0`): Backwards-compatible additions (optional parameters).
   - `MAJOR` (e.g. `1.0.0` $\to$ `2.0.0`): Breaking changes (argument removal, type changes, constraint changes).
2. **Mission Plan Pinning**:
   - When a plan is proposed and confirmed (`plan.confirmed`), each task pins the exact capability ID and version:
     ```json
     {
       "taskId": "tsk_01J9...",
       "capability": "shell",
       "capabilityVersion": "1.0.0",
       "args": { "argv": ["npm", "test"] }
     }
     ```
   - If the registry registers `shell@2.0.0` while a mission is executing, running tasks continue to resolve `shell@1.0.0`.
   - Silent upgrades during mission execution are forbidden. Upgrades require an explicit replan turn (`replan` decision).

---

## 8. Capability Versioning & Mission Pinning

To prevent silent capability drift, unvetted breaking changes, or code tampering during long-running missions:

1. **Strict Semantic Versioning**:
   - `PATCH` (e.g. `1.0.0` $\to$ `1.0.1`): Bug fixes, parser hardening, internal optimizations. Schema unchanged.
   - `MINOR` (e.g. `1.0.0` $\to$ `1.1.0`): Backwards-compatible additions (optional parameters).
   - `MAJOR` (e.g. `1.0.0` $\to$ `2.0.0`): Breaking changes (argument removal, type changes, constraint changes).
2. **Deterministic Mission Plan Pinning**:
   - When a plan is proposed and confirmed (`plan.confirmed`), each task pins the full **Capability Identity Quad**:
     ```json
     {
       "taskId": "tsk_01J9...",
       "capability": "shell",
       "capabilityVersion": "1.0.0",
       "manifestHash": "a1b2c3d4...",
       "implementationHash": "e5f6a7b8...",
       "args": { "argv": ["npm", "test"] }
     }
     ```
3. **Lifecycle Scenarios & Determinism Guarantees**:
   - **Scenario A: Capability v1 is pinned and v2 is installed**:
     The registry registers `shell@2.0.0` alongside `shell@1.0.0`. The executing mission continues resolving `shell@1.0.0` and executing against the pinned v1 implementation. Silent upgrades during mission execution are strictly forbidden. Upgrading requires an explicit replan turn (`replan` decision) with operator or policy review.
   - **Scenario B: Pinned capability v1 is disabled**:
     If an operator or security policy disables `shell@1.0.0` while a mission is running, the Authority Gate immediately rejects the next proposal for v1 with `reasonCode: "capability-disabled"`. The engine will **NEVER** silently fallback to v2. The mission transitions to `interrupted_pending_escalation` awaiting operator intervention.
   - **Scenario C: Implementation changes without version change (Tampering / Code Drift)**:
     If the underlying implementation code or manifest schema is modified on disk or in memory without incrementing SemVer, the registry or host detects that `sha256(implementation) != implementationHash` or `sha256(manifest) != manifestHash`. The capability is automatically moved to `quarantined` status, dispatch is rejected with `reasonCode: "tampered-implementation"`, and the mission halts closed (CAP-018).

---

## 9. Runtime Revocation & Circuit Breakers

Revocation can occur at any moment: an operator revokes a grant (`grant.revoked`), disables a capability in the registry (`capability.disabled`), or triggers an emergency kill switch (`emergency.halt`). 

To eliminate race conditions between planning, gate evaluation, dispatch, and physical execution, FORGE defines exact deterministic semantics across all **six execution failure windows**:

```
[Window 1]       [Window 2]          [Window 3]           [Window 4]          [Window 5]         [Window 6]
Before Proposal ──► After Proposal ──► After Gate Allow ──► Pre-Dispatch ──► Active Exec ──► Post-Exec Commit
```

### Revocation Failure Window Matrix

| Window | Timing Window | System State When Revocation Arrives | Exact Engine & Gate Behavior | Ledger Record Emitted | Downstream Mission State |
|---|---|---|---|---|---|
| **Window 1** | **Before Proposal** | Mission is reasoning or assembling prompt context. | Revoked capability or grant is excluded from prompt context cards. If model outputs proposal anyway, Gate rejects it. | None (proposal not generated yet) | Model replans or selects alternative granted capability. |
| **Window 2** | **After Proposal, Before Gate** | Proposal generated and enqueued for Authority Gate evaluation. | Authority Gate checks active grant set. Grant is absent/revoked. Verdict: `REJECT("grant-revoked")` or `REJECT("capability-disabled")`. | `gate.verdict` (verdict: "reject") | Task marked `failed`. Autonomy loop halts or triggers replan. Zero side effects occur. |
| **Window 3** | **After Gate Approval, Before Host Dispatch** | Gate issued `allow` verdict; proposal waiting in dispatch queue. | **Atomic Pre-Dispatch Re-check**: `CapabilityHost.execute()` re-verifies grant status immediately prior to taking lock or writing dispatch record. Verdict invalidated. | `dispatch.aborted` (reason: "revoked-prior-to-dispatch") | Task marked `failed`. No physical side effect initiated. |
| **Window 4** | **Pre-Dispatch Record Commit** | Host acquired dispatch lock, preparing to spawn subprocess/network call. | Pre-execution check validates capability status before triggering `environment.exec()`. If revoked, cancels without invoking environment. | `proposal.dispatched` followed immediately by `execution.aborted` | Task marked `failed`. Zero external side effect occurred. |
| **Window 5** | **During Active Subprocess Execution** | Subprocess, network fetch, or MCP RPC is running in `Environment`. | **Active Cancellation Signal**: Revocation aborts the active `AbortController`. `Environment` sends `SIGKILL` to subprocess process tree or destroys TCP socket. | `observation` with `status: "aborted"` or `EFFECT_UNKNOWN` | Mission transitions to `interrupted_pending_escalation` or `post_effect_unknown`. Safe auto-retry prohibited. |
| **Window 6** | **After Execution, Before Ledger Commit** | Process completed with output, but observation record not yet committed to cryptographic ledger. | **Pre-Commit Verification Check**: Ledger commit hook checks revocation register. The uncommitted output is quarantined. Marked as `revocation-after-effect`. | `observation` with `revoked: true`, status `EFFECT_UNKNOWN` | Mission marked `post_effect_unknown` because external side effect may have persisted. Requires operator manual acknowledgment. |

### Elimination of Authorization Race Conditions
1. **Time-of-Check to Time-of-Use (TOCTOU)**: Eliminated by enforcing an atomic check inside `CapabilityHost.executeAllowed()` directly inside the dispatch boundary mutex: `verifyGrantActive(verdict.grantId) && verifyCapabilityActive(manifest.identity)`.
2. **Multi-Task Concurrent Revocation**: When `grant.revoked` or `emergency.halt` is processed, all concurrently running task abort signals fire simultaneously, and in-flight dispatch queues are purged before acquiring execution slots.

---

## 10. Idempotency & Crash Recovery Integration

Capabilities declare their idempotency profile, directly governing how `RecoveryCenter` and `MissionRecovery` classify post-crash states:

| Idempotency Class | Capabilities | Behavior During Post-Effect-Unknown Crash Recovery |
|---|---|---|
| `pure_read` | `search`, `doc_parse`, `artifact` | Safe to re-execute automatically upon mission restart. |
| `idempotent` | `fs_write` (atomic replace), `fs_mkdir` | Safe to re-execute with identical arguments. State convergence is guaranteed. |
| `conditionally_idempotent` | `git status`, `git diff`, `git add` | Safe if state inspection proves no divergence occurred. |
| `non_idempotent` | `shell`, `git commit`, `http POST`, `mcp_call` | **NEVER re-executed automatically**. Recovery classifies as `post-effect-unknown`, fails closed, and requires explicit operator acknowledgment before resumption. |

---

## 11. Resource Governance

Resource governance integrates seamlessly into the multidimensional `MissionBudget` model:

1. **Timeout Enforcement**:
   - Manifest declares `timeoutMs`.
   - `CapabilityHost` passes `timeoutMs` to the environment executor with hard cancellation signals.
2. **Output & Artifact Bounds**:
   - `OUTPUT_MAX_BYTES` (2MB) caps in-memory stdout/stderr buffers, setting `truncated: true` on overflow.
   - `maxArtifactBytes` is checked prior to persisting blobs in `capture(bytes)`, preventing disk exhaustion attacks.
3. **Budget Accounting**:
   - Every execution increments `mission.budgetConsumed.capabilityCalls`.
   - Artifact byte size is added to `mission.budgetConsumed.artifactBytes`.
   - Consumed metrics are audited via `budget.updated` ledger records.

---

## 12. MCP Adapter Governance

Model Context Protocol (MCP) servers are treated strictly as **capability adapters**, not an alternative governance plane:

```
[Discovered MCP Tool] (e.g. "github.create_issue")
         │
         ▼
[Wrapped in Canonical Capability Identifier]
   id: "mcp_call"
   args: { "serverId": "github", "toolName": "create_issue", "arguments": { ... } }
         │
         ▼
[Authority Gate Evaluates Proposal]
   Constraint Check: grant.constraints.mcpTools includes "mcp.github.create_issue"
         │
         ▼ (Allow)
[CapabilityHost Dispatches to McpClient stdio JSON-RPC]
         │
         ▼
[Evidence Capture (SHA-256 resultRef)] ──► [Ledger Observation: observation.mcp]
```

* **Zero Direct Access**: The model cannot talk directly to an MCP server socket or stdio stream.
* **Granular Grants**: Operators issue grants scoped to specific tools (`mcp.server.tool`), wildcards per server (`mcp.server.*`), or specific argument shapes.

---

## 13. Shell Capability Governance

Shell capability (`shellImpl`) represents risk tier R4 and follows strict security constraints:

1. **Vector-Only Execution (No Shell Interpreters)**: 
   - The proposal schema accepts `argv: string[]`. 
   - Subprocesses are spawned directly via `child_process.spawn(argv[0], argv.slice(1), { shell: false })`.
   - String shell interpreters (`cmd.exe /c`, `powershell.exe`, `bash -c`, `sh -c`, `zsh -c`) are strictly banned from `argv[0]` in standard `shell` capability. Shell metacharacters (`|`, `&`, `;`, `>`, `<`, `$()`, `` ` ``) have zero syntactic meaning because no shell parser is invoked.
   - Any script-interpreting capability must be explicitly implemented as a separately authorized capability (e.g., `shell.script`), with dedicated schema constraints and operator approval under all autonomy levels.
2. **Argv Class Attenuation**:
   - `argv-exact`: Matches exact argument vectors (e.g. `["npm", "test"]`).
   - `argv-prefix`: Matches allowed command prefixes (e.g. `["git", "status"]`).
3. **Workspace Anchoring**: `cwd` is validated via `LocalEnvironment.resolveReal` and must remain strictly within `workspaceRoot`. Directory traversals (`../../`) are blocked.
4. **Environment Isolation & Secret Redaction**: Subprocesses inherit a sterile environment. Ungranted secrets are never resolved; granted secrets are registered with `SecretRedactor` and automatically scrubbed from stdout and stderr buffers before capture.
5. **Fault Mechanical Verification**: Process spawn failures (`exit: null`) or non-zero exits mechanically fail task verification.

---

## 14. Web & Network Governance

Separates read-only research from mutating network actions:

1. **`web_search`**: Scrapes or queries search indexes. Emits clean search items. Read-only risk tier R2.
2. **`web_fetch`**: Fetches URLs and converts HTML to Markdown. Enforces:
   - **Per-hop `urlAuthority` validation**: Evaluates every HTTP 3xx redirect against the active grant's `hosts` constraint before dispatching the next request. Unauthorized cross-host redirects fail closed.
   - **Hop Limit**: Absolute limit of 5 redirect hops to prevent infinite redirect loops.
   - **SSRF & Private IP Blocking**: Strictly rejects requests targeting loopback (`127.0.0.0/8`), private RFC 1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), cloud metadata services (`169.254.169.254`), and IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`).
   - **DNS Rebinding Mitigation**: IP address validation performed prior to socket connection.
   - **Method Constraint**: `web_fetch` is strictly constrained to HTTP GET. GET requests are never assumed to be zero-risk.
   - **HTTP Status Mechanical Verification**: HTTP response status codes $\ge 400$ are mechanically verified as execution failures.
3. **`http`**: Mutating HTTP client (`POST`, `PUT`, `DELETE`, `PATCH`). Classified as risk tier R3, requiring explicit host, path, and method grants with operator approval.

---

## 15. Document & Multimodal Ingestion Governance

1. **Supported Formats**: PDF, DOCX, PPTX, XLSX, CSV, JSON, XML, images.
2. **Passive Untrusted Data Principle (INV-14)**:
   - Ingested content from documents, web pages, MCP tools, and workspace files is treated strictly as **passive data**.
   - Content is stored content-addressed in the artifact store and stamped with `provenance: "workspace-content"` or `provenance: "untrusted-web"`.
   - In prompt assembly, external content is encapsulated within distinct, untrusted data block delimiters. System prompt instructions establish that data blocks have zero instruction authority and cannot execute tools, modify grants, or alter autonomy policies.
3. **Bomb & Inflation Protections**: Decompression ratio limits (max 100x), recursion depth limits (max 10), output byte limits, and parser timeouts prevent zip bombs and memory amplification attacks.

---

## 16. Discovery & Prompt Architecture

How the model learns about available capabilities without creating prompt-injection attack vectors:

1. **Schema as Data**: Capability descriptors are formatted as structured JSON schema cards in prompt assembly:
   ```json
   {
     "capability": "fs_write",
     "version": "1.0.0",
     "description": "Writes or overwrites a file in the workspace",
     "requiredConstraints": ["paths"],
     "risk": "R1"
   }
   ```
2. **INV-14 Framing**: Capability documentation carries `provenance: "runtime-framing"`.
3. **Active Grant Filtering**: Prompts only expose capabilities covered by active mission grants or escalation policies, minimizing model confusion and token overhead.

---

## 17. Security & Failure Model

1. **Defense-in-Depth Hierarchy**:
   - *Layer 1 (Policy)*: `AutonomyPolicyEngine` checks autonomy tier (L0–L4).
   - *Layer 2 (Gate)*: `Authority Gate` verifies grants and constraints.
   - *Layer 3 (Host)*: `CapabilityHost` isolates execution and injects secrets.
   - *Layer 4 (Ledger)*: Evidence captured in immutable SHA-256 hash chain.
   - *Layer 5 (Verifier)*: Mechanical verification evaluates outcomes independently.
2. **Standardized Failure Categories**:
   - `security_violation`: Non-retryable gate rejections.
   - `resource_exhaustion`: Budget limit halts.
   - `execution_error`: Subprocess or tool execution failures.
   - `timeout`: Exceeded execution time limits.
   - `model_error`: Malformed proposal schemas.

---

## 18. Migration Plan

```
Phase 1: Contracts & Registry
  - Implement CapabilityManifestV2 schema in src/contracts/
  - Implement CapabilityRegistry with validation and lookup in src/capabilities/registry.ts
  - 100% backwards-compatible with existing CapabilityManifest

Phase 2: Adapter Registration
  - Register core built-ins (fs, shell, git, search, patch, http)
  - Register web capabilities (web_search, web_fetch)
  - Register MCP adapter (mcp_call)
  - Register document ingestion (doc_parse)

Phase 3: Host & Router Integration
  - Update CapabilityHost to resolve implementations via CapabilityRegistry
  - Update ContextBuilder to generate dynamic capability cards from registry

Phase 4: Verification & Benchmarking
  - Full regression test execution (all 217+ tests)
  - 10/10 benchmark verification
```

---

## 19. Open Risks & Trade-Offs

1. **Registry Overhead**: Querying registry on every proposal must remain sub-millisecond in-memory lookups.
2. **Tool Schema Token Costs**: Ingesting extensive MCP tool schemas can inflate prompt context. Mitigation: Filter capability cards strictly to granted tools.
3. **Exclusive Concurrency Serialization**: R4 exclusive capabilities serialize, limiting throughput for multi-task missions. This is an intentional security trade-off.
