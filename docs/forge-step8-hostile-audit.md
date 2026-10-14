# FORGE STEP 8 HOSTILE ARCHITECTURE AUDIT

**Document:** Adversarial Security Architecture Audit & Boundary Attack Report  
**Target:** Step 8 Multi-Agent Authority Architecture Specifications (Docs 1–9)  
**Status:** **NOT READY**  
**Engine Version:** FORGE v1.3-audit  
**Date:** 2026-10-07  
**Auditor:** Principal Hostile Security Auditor  
**Production Code Status:** `src/` Untouched & Frozen (301/301 tests pass, typecheck PASS, lint PASS)

---

## 1. Executive Verdict

$$\mathbf{STEP\ 8\ ARCHITECTURE\ STATUS:\ NOT\ READY}$$

The Step 8 architecture documents articulate strong philosophical principles regarding authority attenuation, budget conservation, and execution isolation. However, an adversarial boundary audit reveals that the architecture relies on unproven prose assumptions, contains critical specification gaps, suffers from structural contradictions between isolation and governance, and exhibits severe attack vectors where authority can be widened through omitted fields, receipts can be forged via evidence theft, and orphan grandchild processes can escape revocation.

The claim of **READY** is rejected. Implementation must remain **BLOCKED** until all critical and high findings documented below are resolved at the specification and data contract level.

---

## 2. Findings Catalog

### FINDING-S8-01 (CRITICAL)
- **Severity:** CRITICAL
- **Claim Tested:** $A_{\text{child}} \subseteq A_{\text{parent}} \subseteq A_{\text{root}}$ is mechanically guaranteed across all constraints. No child may ever widen authority through defaults or omitted fields.
- **Attack:** Child agent submits a `DelegationProposal` where optional constraint fields (such as `paths`, `hosts`, `methods`, or `secretNames`) are omitted (`undefined`).
- **Why It Fails:** In the underlying constraints comparator (`constraintsSubsetOf` in `src/grants/grants.ts`), constraints are only checked if the child explicitly provides them (`if (child.paths)`, `if (child.hosts)`). If a parent has `parent.hosts = ["api.github.com"]`, but the child delegation specification omits `hosts` (`child.hosts === undefined`), `constraintsSubsetOf(parent, child)` evaluates to `true`. When the child grant is issued with `hosts: undefined`, the Proposal Gate evaluation for capabilities like `web_fetch` evaluates `if (c.hosts && c.hosts.length > 0)`; since `c.hosts` is undefined, the Gate permits the child to query **any host on the Internet**, completely bypassing the parent's restriction.
- **Required Design Change:** Attenuation must enforce closed-world inheritance: any constraint dimension present on the parent **must** be present on the child and strictly contained within the parent domain. If a child omits a constraint that the parent specifies, the child must automatically inherit the parent's exact constraint, or the proposal must fail closed with `OmittedConstraintError`.
- **Affected Invariant:** INV-21, INV-9.

---

### FINDING-S8-02 (CRITICAL)
- **Severity:** CRITICAL
- **Claim Tested:** 12-Dimensional Attenuation mechanically governs MCP servers/tools, execution isolation profiles, and host execution rights.
- **Attack:** A child agent running under a restricted parent requests dangerous MCP tools (e.g. `execute_sql` on `db_server`), requests `isolationProfile: "host"`, or requests `allowHostExecution: true`.
- **Why It Fails:** `constraintsSubsetOf` in `src/grants/grants.ts` completely omits checks for `mcpTools`, `mcpServers`, `allowHostExecution`, and `isolationProfile`. Furthermore, in `src/gate/gate.ts`, if `c.mcpServers` is omitted, the Gate allows starting/stopping *any* MCP server. A child can widen its MCP privileges and escape sandbox isolation because the attenuation comparator never evaluates these dimensions.
- **Required Design Change:** Update `constraintsSubsetOf` specification to include strict subset comparison for `mcpTools` and `mcpServers`, prohibit widening `isolationProfile` from `sandboxed` to `host`, and reject `allowHostExecution: true` unless parent possesses an active `allowHostExecution` grant.
- **Affected Invariant:** INV-21, INV-16.

---

### FINDING-S8-03 (CRITICAL)
- **Severity:** CRITICAL
- **Claim Tested:** Receipts prove execution authenticity; parent advances task DAG only upon mechanical verification of execution evidence (INV-27).
- **Attack (Evidence Citation Theft):** Child Agent B fails its task or hallucinates completion. Sibling Agent A or Parent previously executed a capability that produced artifact `art_abc123` with SHA-256 hash `H_art`. Child Agent B crafts a `DelegationReceipt` citing `evidenceRefs: ["H_art"]` and delivers it to the parent.
- **Why It Fails:** In `docs/forge-step8-receipt-protocol.md` §3.1 Step 3, the parent verification procedure states: *"For every hash in receipt.evidenceRefs: Assert file exists in artifacts/<hash>. Read bytes, compute SHA-256, assert matches hash."* The parent **never checks whether Child B's journal contains an `observation.*` record that actually emitted `H_art`!** Because artifacts are content-addressed on disk, Child B can cite any artifact previously created by any other agent, and the parent will accept it. Furthermore, `DelegationReceiptSchema` omits `incarnationId`, `parentGrantId`, `planId`, `capabilityIdentityQuad`, and `isolationProfile`.
- **Required Design Change:** Parent receipt verification must prove that every hash in `evidenceRefs` was emitted by an `observation.*` record *within the child's own journal*. `DelegationReceiptSchema` must be expanded to bind `incarnationId`, `parentGrantId`, `planId`, `isolationProfile`, and `nonce`.
- **Affected Invariant:** INV-27, INV-18.

---

### FINDING-S8-04 (CRITICAL)
- **Severity:** CRITICAL
- **Claim Tested:** Revoking a parent grant recursively and monotonically revokes all descendant grants and terminates child containers (INV-25).
- **Attack (Option B Grandchild Zombie Escape):** Child Agent C delegates to Grandchild G. Parent P revokes Child C. Grandchild G continues executing in the background as an unmanaged orphan process.
- **Why It Fails:** Under Option B (Independent Child Sub-Ledgers), Child C writes delegation records for Grandchild G strictly to Child C's private journal (`dataDir/missions/mis_child/journal.jsonl`). The parent ledger has zero knowledge of Grandchild G's existence, delegation ID, or container ID until receipt time. When Parent P revokes Child C, Parent P's cascade revocation traverses only the parent ledger. Parent P cannot discover or terminate Grandchild G without mounting and parsing every descendant's private disk journal. If Child C was terminated or its directory locked, Grandchild G becomes a rogue zombie process executing outside governance.
- **Required Design Change:** Option B must be augmented with an authoritative, cross-mission **Durable Process & Lineage Registry** maintained by `ForgeRuntime` on the host. All delegation authorizations and container spawns must register in the root supervisor's lineage table so cascade revocation can terminate all descendants regardless of sub-ledger partitioning.
- **Affected Invariant:** INV-25, INV-22.

---

### FINDING-S8-05 (HIGH)
- **Severity:** HIGH
- **Claim Tested:** Ephemeral incarnation UUIDs prevent credential replay and authority resurrection after process restart (Stop Condition 4).
- **Attack:** Adversary replays tokens, proposals, or receipts from a previous incarnation after a crash and restart.
- **Why It Fails:** The architecture relies on an ephemeral `incarnationId: UUID` and claims it is "destroyed on process exit". An in-memory UUID has zero durable monotonic ordering. If the runtime crashes and recovers, in-memory state is wiped. Without a durable monotonic generation/epoch counter committed to the ledger, the runtime cannot distinguish between a message from the current incarnation and a replayed message from an earlier incarnation.
- **Required Design Change:** Replace UUID-only identity with a durable 2-tuple: `⟨epoch: number, incarnationUuid: string⟩`. The `epoch` must be a strictly monotonic integer incremented and committed to `journal.jsonl` on every restart. Any proposal, receipt, or dispatch with `epoch < currentEpoch` must be rejected mechanically.
- **Affected Invariant:** INV-29, INV-30.

---

### FINDING-S8-06 (HIGH)
- **Severity:** HIGH
- **Claim Tested:** Hierarchical Budget Conservation Law holds across crashes and process terminations (INV-23).
- **Attack:** Child Agent C is allocated 50,000 tokens in escrow. Child C executes 3 model turns consuming 20,000 tokens, then crashes or is killed by an unhandled signal before generating a receipt.
- **Why It Fails:** In the architecture, escrow reconciliation is triggered exclusively by `DelegationReceiptSchema.budgetConsumed`. If Child C crashes without generating a receipt, Parent P has no specified mechanism to determine `ChildActualConsumed`. If Parent P refunds the full 50,000 tokens to `Parent.Unallocated`, the 20,000 tokens physically consumed are not added to `Parent.Consumed`, enabling total system consumption to exceed the hard mission limit. If Parent P refunds 0 tokens, the remaining 30,000 tokens are permanently leaked.
- **Required Design Change:** The recovery model must define a **Crash Audit Daemon** that inspects the dead child's journal upon abnormal termination, tallies actual tokens and capability calls recorded in `proposal.dispatched` / `observation.*` records, commits a synthetic `delegation.terminated_unclean` record, and reconciles the exact difference.
- **Affected Invariant:** INV-23, INV-29.

---

### FINDING-S8-07 (HIGH)
- **Severity:** HIGH
- **Claim Tested:** Every capability execution permanently logs the 5-tuple $\langle \text{capabilityId}, \text{grantId}, \text{delegationId}, \text{agentId}, \text{missionId} \rangle$ in the cryptographic hash chain (INV-30).
- **Attack:** Audit the cryptographic ledger records produced by capability dispatches.
- **Why It Fails:** `docs/forge-step8-implementation-boundary.md` §2.2 explicitly declares: *"Constraint: Existing record schemas (task.*, proposal.*, observation.*) remain 100% untouched."* However, `ProposalDispatchedBody` and `Observation*Body` in `src/contracts/records.ts` **do not have `delegationId`, `agentId`, or `incarnationId` fields!** If existing record schemas cannot be modified, logging the 5-tuple into the cryptographic hash chain is structurally impossible.
- **Required Design Change:** Resolve the implementation boundary contradiction. Update `ProposalDispatchedBody` schema in `src/contracts/records.ts` to include optional `delegationId`, `agentId`, and `incarnationEpoch` fields.
- **Affected Invariant:** INV-30.

---

### FINDING-S8-08 (HIGH)
- **Severity:** HIGH
- **Claim Tested:** Capability Host executes an atomic pre-dispatch check against the parent ledger to catch revocation races (§3.3) while child agents maintain absolute state isolation (INV-26).
- **Attack:** Child agent dispatches capability; parent revokes delegation simultaneously.
- **Why It Fails:** Structural contradiction. INV-26 mandates that child agents and child containers possess zero object references or file mounts to parent mission stores or parent journals. If the child container is isolated, the child's Capability Host cannot synchronously query parent ledger for `grant.revoked`. If it can access the parent ledger, INV-26 is violated.
- **Required Design Change:** Clarify the physical execution seam: the Capability Host runs on the **host runtime (supervisor)** outside the container, intercepting container capability requests via the host IPC socket. The host supervisor verifies parent ledger revocation before executing the effect on the host or inside the container.
- **Affected Invariant:** INV-25, INV-26.

---

### FINDING-S8-09 (MEDIUM)
- **Severity:** MEDIUM
- **Claim Tested:** All child actions and delegations pass through the Authority Gate via structured proposals (INV-15, INV-21).
- **Attack:** Parent agent attempts to propose a subagent delegation.
- **Why It Fails:** `ProposalSchema` in `src/contracts/proposals.ts` is a closed discriminated union supporting only the 12 existing capabilities (`fs`, `shell`, `http`, etc.). It contains no schema for `delegate`. Furthermore, `docs/forge-step8-implementation-boundary.md` does not list `proposals.ts` for modification. A parent agent cannot propose a delegation through the Proposal Gate because the schema will reject it with `rejected-schema`.
- **Required Design Change:** Add `delegate` capability variant to `ProposalSchema` in `src/contracts/proposals.ts` with strict Zod validation binding `DelegationSpec`. Add `src/contracts/proposals.ts` to the `MODIFIED MODULES` list in the boundary specification.
- **Affected Invariant:** INV-15, INV-21.

---

### FINDING-S8-10 (MEDIUM)
- **Severity:** MEDIUM
- **Claim Tested:** Sibling budget escrow and fanout bounds ($F_{\max} \le 3$) are mechanically enforced without races across concurrent tasks.
- **Attack:** Two concurrent parent tasks simultaneously evaluate delegation proposals when remaining budget is 10 and active children = 2.
- **Why It Fails:** While `MissionStore` provides serialized append behind a file lock, budget and fanout projections are maintained in memory. Two tasks evaluating proposals concurrently in asynchronous event loop turns both read stale in-memory budget (10) and fanout (2). Both pass Gate validation, both commit `delegation.authorized`, resulting in escrow overdraw (16 > 10) and fanout violation (4 > 3).
- **Required Design Change:** Implement an atomic Compare-And-Swap (CAS) or hold the parent ledger lock during the entire proposal validation $\to$ authorization $\to$ escrow commit sequence.
- **Affected Invariant:** INV-22, INV-23.

---

### FINDING-S8-11 (MEDIUM)
- **Severity:** MEDIUM
- **Claim Tested:** Receipt verification cryptographically proves child execution history (INV-27).
- **Attack:** A compromised child fabricates a journal where the last record matches `receipt.childLedgerTip`, but prior records are forged, truncated, or disconnected from the initial genesis block.
- **Why It Fails:** `docs/forge-step8-receipt-protocol.md` §3.1 Step 2 states: *"Read last line and verify hash equals receipt.childLedgerTip."* Reading only the last line does not verify the integrity of the prior chain. A child could synthesize a truncated or corrupt journal that terminates with the claimed tip.
- **Required Design Change:** Step 2 must execute `verifyChain()` over the entire child journal from genesis (seq 1) to tip, verifying all hashes and schema versions before accepting the receipt.
- **Affected Invariant:** INV-27, INV-5.

---

### FINDING-S8-12 (LOW)
- **Severity:** LOW
- **Claim Tested:** Checkpoint recovery never resurrects revoked authority (INV-29).
- **Attack:** Parent mission restores from a checkpoint created at milestone $M_1$, when delegation $D$ was active, after delegation $D$ was subsequently revoked.
- **Why It Fails:** The 15-scenario recovery matrix in `docs/forge-step8-recovery-model.md` completely omits checkpoint restoration under revoked or expired delegation grants. The interaction between checkpoint state reconstitution and the active grant store is unspecified.
- **Required Design Change:** Explicitly define Scenario F-16 in the recovery model: upon checkpoint resume, all reconstituted delegation grants must be cross-checked against the immutable ledger's revocation set; any grant marked revoked must remain in the `revoked` terminal state.
- **Affected Invariant:** INV-29, INV-24.

---

## 3. Authority Attenuation Table

| Dimension | Parent Domain | Child Domain | Attenuation Operation | Widening Attack | Machine-Checkable? | Status |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **Capabilities** | Set of active Capability IDs | Set of requested Capability IDs | $C_{\text{child}} \subseteq C_{\text{parent}}$ | Child requests ungranted capability (e.g. `shell`) | YES | 🟢 VALID |
| **Shell Commands** | `ArgvClass` (exact, prefix, regex) | `ArgvClass` | `argvClassCovers(P, C)` | Exact widens to prefix, or unconstrained | YES | 🟢 VALID |
| **Filesystem Paths** | Array of `WorkspacePath` | Array of `WorkspacePath` | Literal prefix containment & realpath | Omitted `child.paths` allows arbitrary workspace access | YES | 🔴 **FINDING-S8-01** |
| **Network Endpoints** | Array of `HostPattern` | Array of `HostPattern` | Substring/wildcard domain containment | Omitted `child.hosts` allows all Internet domains | YES | 🔴 **FINDING-S8-01** |
| **MCP Servers/Tools** | Arrays of `mcpServers`, `mcpTools` | Arrays of `mcpServers`, `mcpTools` | Set subset inclusion | Omitted from `constraintsSubsetOf`; any tool allowed | YES | 🔴 **FINDING-S8-02** |
| **Risk Tier** | `RiskClass` (read $\dots$ secret) | `RiskClass` | $\text{Rank}(C) \le \text{Rank}(P)$ | Child requests higher risk than parent ceiling | YES | 🟡 UNCHECKED |
| **Isolation Profile** | `sandboxed` \| `host` | `sandboxed` \| `host` | Strictness monotonicity ($\text{host} \not\leftarrow \text{sandboxed}$) | Omitted from comparator; child escalates to `host` | YES | 🔴 **FINDING-S8-02** |
| **Execution Provider** | Host Docker Driver | Host Docker Driver | Monotonic profile inheritance | Child modifies cgroup limits or mount flags | YES | 🟢 VALID |
| **Time (Lifetime)** | `expiresAt: Iso8601 \| null` | `expiresAt: Iso8601 \| null` | $T_{\text{child}} \le T_{\text{parent}}$ | Child specifies `null` or $T_C > T_P$ | YES | 🟢 VALID |
| **Tokens** | `maxTokens` integer | `maxTokens` integer | Escrow subtraction $\le \text{Unallocated}$ | Concurrent sibling double-spend race | YES | 🟡 **FINDING-S8-10** |
| **Model Calls** | `maxModelCalls` integer | `maxModelCalls` integer | Escrow subtraction $\le \text{Unallocated}$ | Sibling overdraw | YES | 🟡 **FINDING-S8-10** |
| **Cost / Currency** | Monotonic budget bounds | Monotonic budget bounds | Escrow subtraction $\le \text{Unallocated}$ | In-flight leak on child crash | YES | 🟡 **FINDING-S8-06** |
| **Artifact Bytes** | `maxArtifactBytes` | `maxArtifactBytes` | Escrow subtraction $\le \text{Unallocated}$ | Child exceeds quota without check | YES | 🟢 VALID |
| **Subprocesses** | Cap on subprocess concurrency | Cap on subprocess concurrency | $N_{\text{sub, child}} \le N_{\text{sub, parent}}$ | Recursive process fork bomb | YES | 🟢 VALID |
| **Concurrency** | `maxConcurrentTasks` | `maxConcurrentTasks` | $K_{\text{child}} \le K_{\text{parent}}$ | Child sets higher concurrent tasks | YES | 🟢 VALID |
| **Delegation Depth** | $\text{depth} \in [0, D_{\max}]$ | $\text{depth} = \text{parent}.\text{depth} + 1$ | Strict increment $\le D_{\max}$ | Cycle creation ($A \to B \to A$) | YES | 🟢 VALID |
| **Child Fanout** | $F_{\max} \le 3$ | $F_{\max} \le 3$ | Active children count $\le F_{\max}$ | Concurrent tasks spawn 4 children | YES | 🟡 **FINDING-S8-10** |
| **Process Lifetime** | Process timeout (ms) | Process timeout (ms) | $T_{\text{proc, child}} \le T_{\text{proc, parent}}$ | Subprocess hangs past parent timeout | YES | 🟢 VALID |

---

## 4. Budget Conservation Model

### 4.1 Equations & Invariants
At all times $t$, for every resource dimension $m$:

$$\text{InitialBudget}(m) = \text{Consumed}_{\text{parent}}(t) + \sum_{c \in \text{Children}} \text{Escrow}_c(t) + \text{Unallocated}_{\text{parent}}(t)$$

$$\text{Unallocated}_{\text{parent}}(t) \ge 0$$

$$\forall c: \quad 0 \le \text{Consumed}_c(t) \le \text{Escrow}_c(t)$$

### 4.2 State Transitions & Attack Analysis

1. **Simultaneous Reservations ($A \to B, A \to C$):**
   - *Attack:* Parent has $\text{Unallocated} = 10$. Task 1 proposes Child B with 8. Task 2 simultaneously proposes Child C with 8.
   - *Vulnerability:* If evaluated in memory concurrently, both see 10, both authorize. Total escrowed = 16 > 10.
   - *Fix:* Atomic CAS on budget escrow inside serialized ledger append lock (**FINDING-S8-10**).
2. **Reserve $\to$ Crash $\to$ Recover:**
   - *Attack:* Parent commits `delegation.authorized` (escrow deducted), then crashes before spawning child.
   - *Resolution:* Recovery detects `delegation.authorized` without `delegation.activated`. Parent either spawns the child or rolls back the reservation via `delegation.cancelled` and returns escrow to unallocated.
3. **Reserve $\to$ Child Starts $\to$ Child Crashes $\to$ Refund:**
   - *Attack:* Child consumes 20 tokens, then crashes abruptly.
   - *Vulnerability:* No receipt is generated. Parent does not know actual consumption. Full refund causes under-reporting (**FINDING-S8-06**).
   - *Fix:* Crash recovery daemon audits child journal and emits `delegation.terminated_unclean` with exact audited consumption.
4. **Reserve $\to$ Child Partially Consumes $\to$ Parent Crashes $\to$ Recover:**
   - *Attack:* Child is running actively; parent process crashes and recovers.
   - *Resolution:* Parent inspects child lock. Child lock is held. Parent re-attaches to child lock without modifying escrow.
5. **Receipt Arrives Twice:**
   - *Attack:* Child submits receipt $R$. Parent accepts. Rogue agent or network retry resubmits $R$.
   - *Resolution:* Parent records `receiptHash` in projection index. Duplicate receipt is rejected immediately with `DuplicateReceiptError`.
6. **Refund + Replayed Spend:**
   - *Attack:* Delegation completes, unused budget refunded to parent. Child process attempts to dispatch another capability.
   - *Resolution:* Terminal state `completed` invalidates grant. Child Capability Host rejects dispatch with `TerminalGrantError`.

---

## 5. Revocation Race Matrix (12 Windows)

| Window | Revocation Timing | Authoritative State | Recheck Mechanism | Abort Mechanism | Evidence Behavior | Post-Effect-Unknown? |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: |
| **W-01** | Before proposal | Grant revoked in ledger | Gate fetches active grants | Proposal rejected: `GrantRevoked` | Zero evidence recorded | NO |
| **W-02** | After proposal, before Gate eval | Proposal in-flight | Gate evaluates `checkGrantActive()` | Gate verdict: `reject` | Proposal logged as rejected | NO |
| **W-03** | During Gate evaluation | In-memory evaluation | Pre-verdict lock recheck | Gate discards draft verdict | Zero records appended | NO |
| **W-04** | After Gate approval, before dispatch | Verdict = `allow` | Pre-dispatch atomic hook | Capability Host aborts dispatch | Dispatch aborted cleanly | NO |
| **W-05** | Immediately before subprocess spawn | Host preparing spawn | Synchronous CAS on grant status | Host skips execve/spawn | Zero side effects occurred | NO |
| **W-06** | During process startup | Container booting | Container lifecycle interceptor | Host sends `SIGKILL` | Container destroyed | NO |
| **W-07** | During active execution | Process running | OS / Docker API signal hook | Host issues `docker kill -s SIGKILL` | Partial stdout/stderr captured | **YES** (if non-idempotent) |
| **W-08** | During child delegation | Child proposing grandchild | Host supervisor intercepts | Grandchild spawn blocked | Delegation rejected | NO |
| **W-09** | After effect, before evidence capture | World effect completed | Post-execution evidence loop | Host captures error artifact | Evidence marked interrupted | **YES** |
| **W-10** | After evidence, before ledger commit | Artifact written to disk | Pre-commit ledger lock | Commit cancelled or marked unknown | Artifact preserved | **YES** |
| **W-11** | During recovery sweep | Runtime rebooting | `bootRecoverySweep()` scan | Revoked state preserved | Replay blocked | NO |
| **W-12** | During checkpoint restore | Checkpoint state loading | Re-validate against ledger | Revoked grant stays revoked | Replay blocked | NO |

---

## 6. Identity / Incarnation Model

### 6.1 Attack Analysis: Replay of Old Credentials
- **Attack:** An attacker captures an old `agentId`, `delegationId`, or `incarnationId` from a prior run or disk artifact and replays it after restart to submit unauthorized proposals or receipts.
- **Flaw in Current Design:** The architecture relies exclusively on UUID generation and assumes UUIDs are "destroyed on process exit". This is ephemeral and unverifiable across crashes (**FINDING-S8-05**).

### 6.2 Required Durable Monotonic Epoch Model
Every agent identity must incorporate a monotonically increasing epoch:

$$\text{AgentIdentity} = \langle \text{agentId}, \text{missionId}, \text{delegationId}, \text{epoch}, \text{incarnationUuid}, \text{parentAgentId} \rangle$$

1. **Epoch Persistence:** When an agent is spawned or restarted, the host supervisor reads the parent mission journal, increments `currentEpoch`, and appends `agent.incarnated { agentId, epoch, incarnationUuid }` with `fsyncSync()`.
2. **Strict Epoch Comparison:** The Authority Gate rejects any proposal or receipt where:
   $$\text{request}.\text{epoch} \ne \text{activeEpoch}(\text{request}.\text{agentId})$$
3. **Old Credential Invalidation:** An old incarnation possessing `epoch = 1` cannot submit proposals when `activeEpoch = 2`. Stale credentials fail authentication deterministically.

---

## 7. Receipt Binding Matrix

Every `DelegationReceipt` must cryptographically bind all 14 execution dimensions:

| Field | Bound Entity | Purpose | Replay / Tamper Defense |
| :--- | :--- | :--- | :--- |
| `receiptId` | Unique ULID | Primary key of receipt | Checked against processed receipt set |
| `delegationId` | Specific Delegation | Binds receipt to exact grant | Cannot apply to sibling delegation |
| `parentMissionId` | Parent Mission | Binds receipt to parent | Cannot be copied to another mission |
| `childMissionId` | Child Mission | Identifies execution journal | Verifies matching journal directory |
| `childAgentId` | Child Agent | Identifies executing agent | Verifies against agent registration |
| `epoch` | Durable Epoch | Binds to process run | Rejects receipts from dead incarnations |
| `parentGrantId` | Parent Grant Revision | Binds to grant version | Rejects if grant revision changed |
| `planId` | Parent Mission Plan | Binds to target plan | Cannot be used across plan revisions |
| `parentTaskId` | Target Task ID | Binds to specific DAG task | Cannot fulfill a different task |
| `isolationProfile` | Execution Isolation | Proves sandbox execution | Cannot pass host execution as sandboxed |
| `childLedgerTip` | Final Journal Hash | Anchors child journal | Full hash chain verified to genesis |
| `evidenceRefs` | Array of Artifact Hashes | Content-addressed artifacts | Must exist in child journal observations |
| `budgetConsumed` | Audited Token / Cap Calls | Reconciles parent escrow | Prevents under/over-spend |
| `nonce` | Sequential Counter | Single-use execution token | Nonce reuse rejected |

$$\mathbf{RECEIPT \ne AUTHORITY}$$
A receipt is an immutable, historical record of past execution. Receipt verification **never** grants new capabilities, extends lifetimes, or widens authority. It only marks a DAG task fulfilled and reclaims unused budget.

---

## 8. Ledger Trust Model (Critique of Option B)

### 8.1 Parent Verification of Child Ledger Evidence
The architecture selected Option B (Independent Sub-Ledgers Anchored via Receipt Tips). Under adversarial scrutiny, Option B introduces critical trust verification requirements:

1. **Fabricated Ledger Tip Attack:** Child submits forged tip $T$.
   - *Mitigation:* Parent opens `dataDir/missions/<childMissionId>/journal.jsonl` and runs `verifyChain()` across **all** records. If hash verification fails or tip does not match, receipt is rejected (**FINDING-S8-11**).
2. **Evidence Theft Attack:** Child cites valid artifact produced by another agent.
   - *Mitigation:* Parent verifies that every hash in `receipt.evidenceRefs` appears in an `observation.*` record in *that specific child's verified journal* (**FINDING-S8-03**).
3. **Cross-Mission Contamination:** Child writes to parent directory.
   - *Mitigation:* Container driver mounts only child sub-workspace. Parent directory is completely unmounted.
4. **Ledger Rollback / Fork Attack:** Child truncates its journal after committing side effects.
   - *Mitigation:* Single-writer file lock held on child journal; torn tail recovery truncates only uncommitted records. Receipts record total record count (`childRecordCount`).

---

## 9. Adversarial Recovery Matrix (15 Scenarios)

| Scenario ID | Precondition & Failure Point | Ledger State | Recovery Procedure | Replay Permitted? | Operator Ack Needed? |
| :---: | :--- | :--- | :--- | :---: | :---: |
| **ADV-REC-01** | Valid checkpoint + revoked parent grant | Checkpoint exists; `grant.revoked` logged | Restore checkpoint; mark all grants terminal `revoked` | NO | No |
| **ADV-REC-02** | Valid checkpoint + expired delegation grant | Checkpoint exists; wall clock $> \text{expiresAt}$ | Restore checkpoint; mark delegation `expired` | NO | No |
| **ADV-REC-03** | Valid checkpoint + old incarnation token | Stale epoch in checkpoint request | Reject restore with `InvalidEpochError` | NO | No |
| **ADV-REC-04** | Valid checkpoint + deleted child directory | Parent references missing child journal | Mark child task `failed`; quarantine sub-mission | NO | **YES** |
| **ADV-REC-05** | Valid checkpoint + parent revoked | Parent mission cancelled | Quarantine entire tree; terminate all containers | NO | No |
| **ADV-REC-06** | Valid checkpoint + descendant revoked | Child active; grandchild revoked | Reconcile child state; terminate grandchild | NO | No |
| **ADV-REC-07** | Valid checkpoint + spent budget | Budget exhausted during checkpoint | Restore into `halted_budget_exhausted` | NO | No |
| **ADV-REC-08** | Valid checkpoint + stale receipt replay | Replayed receipt hash in restore | Reject receipt; preserve DAG state | NO | No |
| **ADV-REC-09** | Crash during escrow deduction | `delegation.proposed` without `authorized` | Re-evaluate proposal; zero escrow deducted | Yes (pure state) | No |
| **ADV-REC-10** | Crash during cascade revocation | Parent revoked; 1 of 3 children killed | Recovery daemon resumes cascade; kills remaining 2 | Yes (kill idempotency)| No |
| **ADV-REC-11** | Crash during receipt verification | Receipt verified; DAG not advanced | Idempotent replay of DAG advance from receipt | Yes (DAG advance) | No |
| **ADV-REC-12** | Child container dies with stale lock | Lock mtime $> 30\text{s}$; dead PID | Steal lock; audit journal; reconcile budget | Yes (lock theft) | No |
| **ADV-REC-13** | Child crashed mid non-idempotent action | Action dispatched; 0 observations | Fail closed as `post-effect-unknown` | **NO** | **YES** |
| **ADV-REC-14** | Mid-journal corruption in child ledger | Hash broken at seq 4 | Quarantine child sub-mission; fail parent task | **NO** | **YES** |
| **ADV-REC-15** | Crash during budget refund commit | Child completed; refund unlogged | Re-calculate from verified child ledger; commit refund | Yes (reconciliation)| No |

---

## 10. Concurrency & Race Matrix (15 Races)

| Race ID | Competing Operations | Shared Resource | Resolution Boundary | Winner / Loser Outcome |
| :---: | :--- | :--- | :--- | :--- |
| **RACE-01** | Simultaneous child creation | Fanout counter ($F_{\max}$) | Parent ledger append lock | Winner spawned; Loser gets `MaxFanoutExceeded` |
| **RACE-02** | Simultaneous budget reservation | Parent `Unallocated` | Atomic CAS on budget escrow | Winner escrows; Loser gets `InsufficientBudget` |
| **RACE-03** | Proposal dispatch vs Revocation | Active grant state | Host supervisor pre-dispatch check | Dispatch aborted; returns `GrantRevokedError` |
| **RACE-04** | Concurrent task claim | Parent DAG task $T_1$ | Atomic CAS task lock | Winner claims `running`; Loser gets `AlreadyClaimed` |
| **RACE-05** | Receipt submission vs Expiration | Delegation lifetime | Wall clock at receipt ingestion | If expired, receipt rejected as `GrantExpired` |
| **RACE-06** | Checkpoint creation vs Revocation | Mission grant state | State machine transition mutex | Revocation commits first; checkpoint reflects revoked |
| **RACE-07** | Sibling A write vs Sibling B write | Workspace disk path | Sub-directory volume isolation | Zero conflict (disjoint physical mount paths) |
| **RACE-08** | Sibling A read vs Sibling B write | Shared artifact | Content-addressed storage | Immutability: read sees complete SHA-256 file |
| **RACE-09** | Child spawn vs Parent mission abort | Mission state | Supervisor process table | Abort terminates child spawn immediately |
| **RACE-10** | Receipt arrival vs Child kill signal | Child completion | Supervisor IPC socket | If receipt committed before kill, receipt stands |
| **RACE-11** | Lock theft vs Delayed child write | Child `.lock` | Host PID alive check + mtime | Dead process stolen; active process respected |
| **RACE-12** | Duplicate receipt submission | Parent receipt index | In-memory Set + Ledger index | First commits; second fails `DuplicateReceipt` |
| **RACE-13** | Grandchild spawn vs Child revocation | Lineage table | Supervisor lineage mutex | Revocation blocks grandchild authorization |
| **RACE-14** | Concurrent model call retries | Child escrow pool | Router retry counter | All consumed tokens debited to child escrow |
| **RACE-15** | Parent DAG advance vs Child sub-task | Parent plan queue | Single-writer parent engine | Only parent engine advances parent DAG |

---

## 11. Topology Correctness & Machine Enforcement

### 11.1 Tree Constraints
1. **Depth Limit:** $\text{depth} \le D_{\max} = 2$ (hard max 3).
2. **Fanout Limit:** $\text{activeChildren} \le F_{\max} = 3$.
3. **Descendant Limit:** $\text{totalDescendants} \le N_{\max} = 10$.
4. **Acyclicity:** No agent may delegate to an ancestor.

### 11.2 Mechanical vs. In-Memory Enforcement
- **Vulnerability:** If tree limits are checked only in memory, crashes, restarts, and concurrent tasks bypass them (**FINDING-S8-10**).
- **Mandatory Enforcement:** Topology state must be projected directly from `journal.jsonl`. At proposal time:
  1. `getAncestors(agentId)` traverses the parent grant chain back to root. If target agent exists in chain, throw `CycleDetectedError`.
  2. Active children are counted by querying `delegation.authorized` records without corresponding terminal records (`completed`, `failed`, `revoked`).
  3. The check is performed under the parent ledger write lock.

---

## 12. Claim Calibration & Overclaim Corrections

| Original Prose Claim | Flaw / Risk | Calibrated Engineering Reality |
| :--- | :--- | :--- |
| *"Authority attenuation proven"* | Code in `src/grants/grants.ts` ignores omitted fields, MCP, and isolation. | **DESIGN RULE SPECIFIED; MECHANICALLY INCOMPLETE.** |
| *"Budget double-spending is mathematically impossible"* | Concurrency races in asynchronous turns can overdraw unallocated balance. | **CONSERVATION EQUATIONS DEFINED; CAS PRIMITIVE REQUIRED.** |
| *"Revocation instantly invalidates entire sub-tree"* | Option B sub-ledgers hide grandchildren from parent ledger. | **CASCADE DESIGNED; HOST LINEAGE REGISTRY REQUIRED.** |
| *"Old incarnation tokens cannot execute"* | Ephemeral UUIDs lack durable monotonically increasing persistence. | **IN-MEMORY SPEC; DURABLE MONOTONIC EPOCH REQUIRED.** |
| *"Parent advances strictly on cryptographic proofs"* | Verifier only checks file existence; evidence citation theft possible. | **RECEIPT PROTOCOL DESIGNED; PROVENANCE VERIFICATION REQUIRED.** |
| *"All 15 Stop Conditions resolved"* | Multiple stop conditions fail under adversarial boundary attacks. | **STOP CONDITIONS UNRESOLVED; ARCHITECTURE NOT READY.** |

---

## 13. Implementation Readiness

$$\mathbf{IMPLEMENTATION\ READY:\ NO}$$

Step 8 remains strictly in the architecture and security specification phase. No production implementation in `src/` may begin until the 4 Critical and 4 High findings documented in this audit are fully remediated in the specification documents and data contracts.

---

STEP 8 HOSTILE AUDIT: NOT READY  
CRITICAL FINDINGS: 4  
HIGH FINDINGS: 4  
MEDIUM FINDINGS: 3  
LOW FINDINGS: 1  
ARCHITECTURE READY: NO  
IMPLEMENTATION READY: NO  
PRODUCTION CODE MODIFIED: NO  
