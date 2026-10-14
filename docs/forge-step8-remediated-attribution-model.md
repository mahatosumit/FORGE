# FORGE STEP 8 — REMEDIATED ATTRIBUTION & DELEGATION PROPOSAL MODEL

**Document:** Data Contract Specification — Remediated Multi-Agent Attribution & Delegation Proposals  
**Status:** REMEDIATED ARCHITECTURAL SPECIFICATION  
**Version:** FORGE v1.3-remediated-attribution  
**Date:** 2026-10-07  
**Remediates:** Finding S8-07 (High), Finding S8-09 (Medium)  
**Authors:** Principal Security Architect & Adversarial Engineering  

---

## 1. RESOLUTION OF S8-07: ATTRIBUTION SCHEMA SEAM RESOLUTION

In the hostile audit (**Finding S8-07**), an explicit contradiction was identified:
- The architecture mandated that every capability execution permanently binds $\langle \text{capabilityId}, \text{grantId}, \text{delegationId}, \text{agentId}, \text{missionId} \rangle$ in the hash chain (INV-30).
- Simultaneously, `docs/forge-step8-implementation-boundary.md` claimed that existing record schemas in `src/contracts/records.ts` were strictly frozen and untouched.
- However, `ProposalDispatchedBody` in `records.ts` lacked `delegationId`, `agentId`, and `incarnationEpoch`.

### 1.1 Architectural Resolution (Option A Selected)
We explicitly reject the false claim that `src/contracts/records.ts` is 100% frozen. `src/contracts/records.ts` is formally reclassified as a **MODIFIED MODULE** in the implementation boundary. 

`ProposalDispatchedBody` is surgically extended to bind the complete multi-agent attribution tuple without breaking existing single-agent records:

```typescript
export interface ProposalDispatchedBody {
  proposalId: RecordId;
  grantId: GrantId;
  capabilityId?: string;
  version?: string;
  manifestHash?: Sha256Hex;
  implementationHash?: Sha256Hex;
  environment: "local" | "container";
  isolationProfile?: "sandboxed" | "sandboxed-network" | "host";
  timeoutMs: number;
  missionId?: string;
  taskId?: string;

  // Step 8 Remediated Multi-Agent Attribution Fields (S8-07)
  delegationId?: string;       // Binds to specific DelegationRegistry entry
  agentId?: string;            // Executing agent identifier
  incarnationEpoch?: number;   // Monotonic process epoch
}
```

### 1.2 Invariant INV-30 Formal Statement
For every capability execution under delegation, `ProposalDispatchedBody` **MUST** include non-null `delegationId`, `agentId`, and `incarnationEpoch`. Omitting any of these fields for a delegated execution halts ledger append with an `AttributionMissingError`.

---

## 2. RESOLUTION OF S8-09: DELEGATION PROPOSAL CONTRACT

In the hostile audit (**Finding S8-09**), it was revealed that `ProposalSchema` in `src/contracts/proposals.ts` only supported 12 existing capabilities (`fs`, `shell`, `http`, etc.) and had zero schema for `delegate`.

### 2.1 Schema Addition to `src/contracts/proposals.ts`
`src/contracts/proposals.ts` is formally reclassified as a **MODIFIED MODULE**. We add the `delegate` capability variant to `ProposalSchema`:

```typescript
export const DelegateProposalArgsSchema = z.object({
  targetAgentId: z.string().min(1).max(64),
  objective: z.string().min(1).max(2000),
  requestedCapabilities: z.array(CapabilityIdSchema).min(1).max(32),
  requestedConstraints: ConstraintsSchema.strict(),
  requestedBudget: z.object({
    maxPlannerTurns: z.number().int().min(1).max(50),
    maxModelCalls: z.number().int().min(1).max(100),
    maxTokens: z.number().int().min(1000).max(2_000_000),
    maxCapabilityCalls: z.number().int().min(1).max(100),
    maxRetries: z.number().int().min(0).max(20),
    maxExecutionTimeMs: z.number().int().min(1000).max(3600_000),
    maxArtifactBytes: z.number().int().min(1024).max(100 * 1024 * 1024),
    maxConcurrentTasks: z.number().int().min(1).max(5),
  }).strict(),
  acceptanceCriteria: z.array(CriterionExprSchema).min(1).max(16),
  lifetimeSeconds: z.number().int().min(10).max(86400),
}).strict();

export type DelegateProposalArgs = z.infer<typeof DelegateProposalArgsSchema>;
```

### 2.2 Execution Pipeline for Delegation Proposals
A delegation proposal is evaluated identically to any other capability proposal:

$$\text{Model} \to \text{Proposal} \to \text{Gate} \to \text{Attenuation} \to \text{Escrow} \to \text{Register} \to \text{Ledger} \to \text{Spawn}$$

1. **Gate Validation:** Validates schema and asserts parent holds capability `delegate`.
2. **Effective Attenuation:** Evaluates the 20-dimensional attenuation algorithm ($A_{\text{child}}^{\text{eff}} \subseteq A_{\text{parent}}$).
3. **Budget Escrow:** Executes atomic CAS reservation from parent available pool.
4. **Registry Registration:** Registers entry in Central Delegation Registry.
5. **Ledger Commit:** Appends `delegation.proposed` and `delegation.authorized` to parent journal with `fsyncSync()`.
6. **Container Spawn:** `ForgeRuntime` provisions container and initializes child sub-mission.

---

## 3. UPDATED IMPLEMENTATION BOUNDARY MAP

```text
┌────────────────────────────────────────────────────────────────────────┐
│                     REMEDIATED MODULE BOUNDARY MAP                     │
├──────────────────────────┬──────────────────────┬──────────────────────┤
│       NEW MODULES        │   MODIFIED MODULES   │  READ-ONLY / FROZEN  │
├──────────────────────────┼──────────────────────┼──────────────────────┤
│ src/multi-agent/         │ src/contracts/       │ src/codec/           │
│   registry.ts            │   records.ts (S8-07) │   hashChain.ts       │
│   manager.ts             │   proposals.ts(S8-09)│   canonicalJson.ts   │
│   receipt-verifier.ts    │ src/gate/            │ src/ledger/          │
│   revocation.ts          │   gate.ts            │   ledger.ts          │
│   crash-audit.ts         │ src/mission-engine/  │   lock.ts            │
│ test/multi-agent/        │   runner.ts          │ src/environments/    │
│                          │ src/runtime/         │   container.ts       │
│                          │   runtime.ts         │   local.ts           │
└──────────────────────────┴──────────────────────┴──────────────────────┘
```

---

*Authored by Principal Security Architect & Adversarial Engineering.*
