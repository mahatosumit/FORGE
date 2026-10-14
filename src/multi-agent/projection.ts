// FORGE Multi-Agent Authority Projection (Step 8 Phase 1 Remediation)
// Canonical state reconstructed entirely from the Step 7B Mission Journal.
// Invariant (INV-13 / ADR-002): The Journal is the sole canonical authority.
// This projection is a rebuildable, crash-consistent cache. Deleting it is always safe.
// Remediates: AUDIT-P1-01 (Budget Durability), AUDIT-P1-03 (Epoch Authority),
// AUDIT-P1-07 (Split-Brain Prevention), AUDIT-P1-08 (Revocation Authorization),
// AUDIT-P1-10 (Ancestor Revocation).

import {
  type DelegationRegistryEntry,
  DelegationRegistryEntrySchema,
  type DelegationBudget,
  DelegationBudgetSchema,
  type DelegationId,
  type IncarnationEpoch,
  type EffectiveAuthorityEnvelope,
} from "../contracts/delegation.js";
import { type ForgeRecord } from "../contracts/records.js";
import { type Ledger } from "../ledger/ledger.js";

import { type DelegationEscrowEntry } from "./budget-escrow.js";

export const DEFAULT_ROOT_BUDGET: DelegationBudget = {
  maxPlannerTurns: 50,
  maxModelCalls: 100,
  maxTokens: 1_000_000,
  maxCapabilityCalls: 100,
  maxRetries: 10,
  maxExecutionTimeMs: 1_800_000,
  maxArtifactBytes: 50 * 1024 * 1024,
  maxConcurrentTasks: 3,
  maxSubprocesses: 2,
};

export class LineageRevokedError extends Error {
  constructor(public readonly delegationId: string, public readonly revokedAncestorId: string) {
    super(`Delegation "${delegationId}" has revoked lineage at ancestor "${revokedAncestorId}"`);
    this.name = "LineageRevokedError";
  }
}

/**
 * Rebuildable Multi-Agent Projection.
 * Reconstructed 100% deterministically from mission journal records.
 */
export class MultiAgentProjection {
  private readonly delegations = new Map<DelegationId, DelegationRegistryEntry>();
  private readonly escrows = new Map<DelegationId, DelegationEscrowEntry>();
  private readonly childMissionIndex = new Map<string, DelegationId>();
  private readonly totalLimit: DelegationBudget;
  private available: DelegationBudget;
  private parentConsumed = {
    tokens: 0,
    modelCalls: 0,
    capabilityCalls: 0,
    executionTimeMs: 0,
    artifactBytes: 0,
  };
  private lastProcessedSeq = 0;

  constructor(initialLimit?: DelegationBudget) {
    this.totalLimit = initialLimit
      ? DelegationBudgetSchema.parse(initialLimit)
      : { ...DEFAULT_ROOT_BUDGET };
    this.available = { ...this.totalLimit };
  }

  getLastProcessedSeq(): number {
    return this.lastProcessedSeq;
  }

  getAvailableBudget(): DelegationBudget {
    return { ...this.available };
  }

  getTotalLimit(): DelegationBudget {
    return { ...this.totalLimit };
  }

  getDelegation(delegationId: DelegationId): DelegationRegistryEntry | undefined {
    const d = this.delegations.get(delegationId);
    return d ? { ...d } : undefined;
  }

  getByChildMissionId(missionId: string): DelegationRegistryEntry | undefined {
    const dId = this.childMissionIndex.get(missionId);
    if (!dId) return undefined;
    return this.getDelegation(dId);
  }

  getEscrow(delegationId: DelegationId): DelegationEscrowEntry | undefined {
    const e = this.escrows.get(delegationId);
    if (!e) return undefined;
    return {
      ...e,
      escrowed: { ...e.escrowed },
      consumed: { ...e.consumed },
      refundable: { ...e.refundable },
    };
  }

  getAuthoritativeEpoch(delegationId: DelegationId): number | undefined {
    return this.delegations.get(delegationId)?.childIncarnationEpoch;
  }

  /**
   * Check whether a candidate epoch is authoritative for a given delegation.
   */
  isEpochAuthoritative(delegationId: DelegationId, candidateEpoch: number): boolean {
    const entry = this.delegations.get(delegationId);
    if (!entry) return false;
    return entry.childIncarnationEpoch === candidateEpoch;
  }

  /**
   * Full Ancestor Lineage Check (Remediates AUDIT-P1-08, AUDIT-P1-10).
   * Traverses the ENTIRE ancestorPath from root down to target delegation.
   * If ANY node in the chain is revoked, the effective lineage is REVOKED.
   */
  isLineageActive(delegationId: DelegationId): { ok: true } | { ok: false; reason: string; revokedAtId: string } {
    const entry = this.delegations.get(delegationId);
    if (!entry) {
      return { ok: false, reason: "Delegation not found in projection", revokedAtId: delegationId };
    }

    if (entry.status === "revoked") {
      return { ok: false, reason: "Delegation is explicitly revoked", revokedAtId: entry.delegationId };
    }

    // Check all ancestors in the chain
    for (const ancestorId of entry.ancestorPath) {
      if (ancestorId === delegationId) continue;
      const ancestor = this.delegations.get(ancestorId);
      if (!ancestor) {
        return { ok: false, reason: `Ancestor delegation "${ancestorId}" not found`, revokedAtId: ancestorId };
      }
      if (ancestor.status !== "active" && ancestor.status !== "authorized") {
        return {
          ok: false,
          reason: `Ancestor delegation "${ancestorId}" is in inactive/terminal status "${ancestor.status}"`,
          revokedAtId: ancestorId,
        };
      }
    }

    if (entry.status !== "active" && entry.status !== "authorized") {
      return { ok: false, reason: `Delegation is in inactive status "${entry.status}"`, revokedAtId: entry.delegationId };
    }

    return { ok: true };
  }

  getActiveChildCount(parentDelegationId: DelegationId | null): number {
    let count = 0;
    for (const d of this.delegations.values()) {
      if (d.parentDelegationId === parentDelegationId) {
        if (d.status === "authorized" || d.status === "active" || d.status === "suspended") {
          count++;
        }
      }
    }
    return count;
  }

  getActiveAgentCount(): number {
    let count = 0;
    for (const d of this.delegations.values()) {
      if (d.status === "authorized" || d.status === "active" || d.status === "suspended") {
        count++;
      }
    }
    return count;
  }

  allDelegations(): DelegationRegistryEntry[] {
    return Array.from(this.delegations.values()).map((d) => ({ ...d }));
  }

  /**
   * Applies a single record to the projection state (Cache Maintenance).
   */
  applyRecord(r: ForgeRecord): void {
    if (r.seq <= this.lastProcessedSeq && this.lastProcessedSeq > 0) {
      return; // already processed
    }
    this.lastProcessedSeq = r.seq;

    switch (r.kind) {
      case "delegation.authorized": {
        const body = r.body as unknown as {
          delegationId: DelegationId;
          parentDelegationId: DelegationId | null;
          rootMissionId: any;
          childMissionId: any;
          parentAgentId: any;
          childAgentId: any;
          depth: number;
          ancestorPath: DelegationId[];
          childIncarnationEpoch: number;
          grantId: any;
          grantRevision: number;
          effectiveAuthorityHash?: any;
          effectiveEnvelope: EffectiveAuthorityEnvelope;
          budgetEscrow: DelegationBudget;
        };

        const escrowAmount = body.budgetEscrow;
        // Deduct from available budget
        this.available.maxTokens -= escrowAmount.maxTokens;
        this.available.maxModelCalls -= escrowAmount.maxModelCalls;
        this.available.maxCapabilityCalls -= escrowAmount.maxCapabilityCalls;
        this.available.maxExecutionTimeMs -= escrowAmount.maxExecutionTimeMs;
        this.available.maxArtifactBytes -= escrowAmount.maxArtifactBytes;

        const regEntry: DelegationRegistryEntry = {
          delegationId: body.delegationId,
          parentDelegationId: body.parentDelegationId,
          rootMissionId: body.rootMissionId,
          parentMissionId: r.missionId as any,
          childMissionId: body.childMissionId,
          parentAgentId: body.parentAgentId,
          childAgentId: body.childAgentId,
          depth: body.depth,
          ancestorPath: body.ancestorPath,
          childIncarnationEpoch: body.childIncarnationEpoch,
          containerId: null,
          hostPid: null,
          grantId: body.grantId,
          grantRevision: body.grantRevision,
          effectiveAuthorityHash: (body.effectiveAuthorityHash ?? "0".repeat(64)) as any,
          effectiveEnvelope: body.effectiveEnvelope,
          status: "authorized",
          issuedAt: r.ts as any,
          expiresAt: body.effectiveEnvelope.expiresAt,
          revokedAt: null,
          revocationReason: null,
          activeChildCount: 0,
          totalDescendantCount: 0,
        };

        this.delegations.set(body.delegationId, regEntry);
        this.childMissionIndex.set(body.childMissionId, body.delegationId);

        const escrowEntry: DelegationEscrowEntry = {
          delegationId: body.delegationId,
          state: "ESCROWED",
          escrowed: { ...escrowAmount },
          consumed: { tokens: 0, modelCalls: 0, capabilityCalls: 0, executionTimeMs: 0, artifactBytes: 0 },
          refundable: { tokens: 0, modelCalls: 0, capabilityCalls: 0, executionTimeMs: 0, artifactBytes: 0 },
          uncertain: false,
          createdAt: r.ts,
          updatedAt: r.ts,
        };
        this.escrows.set(body.delegationId, escrowEntry);
        break;
      }

      case "delegation.activated": {
        const body = r.body as {
          delegationId: DelegationId;
          containerId?: string | null;
          hostPid?: number | null;
        };
        const d = this.delegations.get(body.delegationId);
        if (d && d.status === "authorized") {
          d.status = "active";
          d.containerId = body.containerId ?? null;
          d.hostPid = body.hostPid ?? null;
        }
        const e = this.escrows.get(body.delegationId);
        if (e && e.state === "ESCROWED") {
          e.state = "ALLOCATED";
          e.updatedAt = r.ts;
        }
        break;
      }

      case "delegation.reincarnated": {
        const body = r.body as {
          delegationId: DelegationId;
          newEpoch: number;
          containerId?: string | null;
          hostPid?: number | null;
        };
        const d = this.delegations.get(body.delegationId);
        if (d) {
          d.childIncarnationEpoch = body.newEpoch;
          d.containerId = body.containerId ?? null;
          d.hostPid = body.hostPid ?? null;
          if (d.status === "suspended") d.status = "active";
        }
        break;
      }

      case "delegation.revoked": {
        const body = r.body as {
          delegationId: DelegationId;
          reason: string;
        };
        const targetId = body.delegationId;
        // Cascade to all descendants in ancestorPath
        for (const d of this.delegations.values()) {
          if (d.delegationId === targetId || d.ancestorPath.includes(targetId)) {
            if (d.status !== "completed" && d.status !== "failed") {
              d.status = "revoked";
              d.revokedAt = r.ts as any;
              d.revocationReason = body.reason;
            }
          }
        }
        // Mark escrow
        const e = this.escrows.get(targetId);
        if (e) {
          if (e.state === "ESCROWED") {
            // Cancelled pre-spawn: refund
            this.available.maxTokens += e.escrowed.maxTokens;
            this.available.maxModelCalls += e.escrowed.maxModelCalls;
            this.available.maxCapabilityCalls += e.escrowed.maxCapabilityCalls;
            this.available.maxExecutionTimeMs += e.escrowed.maxExecutionTimeMs;
            this.available.maxArtifactBytes += e.escrowed.maxArtifactBytes;
            e.state = "REFUNDED";
          } else if (e.state === "ALLOCATED") {
            // Killed without receipt: UNCERTAIN
            e.state = "UNCERTAIN";
            e.uncertain = true;
          }
          e.updatedAt = r.ts;
        }
        break;
      }

      case "delegation.budget_reconciled": {
        const body = r.body as unknown as {
          delegationId: DelegationId;
          actualConsumed?: { tokens: number; modelCalls?: number; capabilityCalls?: number; executionTimeMs?: number };
          consumedTokens?: number;
          refundedTokens: number;
          consumedModelCalls?: number;
          refundedModelCalls?: number;
          consumedCapabilityCalls?: number;
          refundedCapabilityCalls?: number;
        };
        const consumed = body.actualConsumed?.tokens ?? body.consumedTokens ?? 0;
        const refunded = body.refundedTokens ?? 0;
        const e = this.escrows.get(body.delegationId);
        if (e) {
          e.consumed.tokens = consumed;
          e.refundable.tokens = refunded;
          e.state = "REFUNDED";
          e.uncertain = false;
          e.updatedAt = r.ts;
        }
        this.available.maxTokens += refunded;
        if (body.refundedModelCalls) this.available.maxModelCalls += body.refundedModelCalls;
        if (body.refundedCapabilityCalls) this.available.maxCapabilityCalls += body.refundedCapabilityCalls;
        break;
      }

      case "delegation.cancelled": {
        const body = r.body as { delegationId: DelegationId };
        const e = this.escrows.get(body.delegationId);
        if (e && e.state === "ESCROWED") {
          this.available.maxTokens += e.escrowed.maxTokens;
          this.available.maxModelCalls += e.escrowed.maxModelCalls;
          this.available.maxCapabilityCalls += e.escrowed.maxCapabilityCalls;
          this.available.maxExecutionTimeMs += e.escrowed.maxExecutionTimeMs;
          this.available.maxArtifactBytes += e.escrowed.maxArtifactBytes;
          e.state = "REFUNDED";
          e.updatedAt = r.ts;
        }
        const d = this.delegations.get(body.delegationId);
        if (d) d.status = "cancelled";
        break;
      }

      default:
        break;
    }
  }

  /**
   * Deterministic recovery constructor from a canonical Ledger instance.
   * Guarantees 100% byte-identical reconstruction of multi-agent state.
   */
  static rebuildFromLedger(ledger: Ledger, initialBudget?: DelegationBudget): MultiAgentProjection {
    const projection = new MultiAgentProjection(initialBudget);
    for (const record of ledger.read()) {
      projection.applyRecord(record);
    }
    return projection;
  }
}
