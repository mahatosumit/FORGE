// FORGE Hierarchical Budget Escrow & Crash Accounting Model (Step 8 Phase 1)
// Remediates: S8-06 (High: Crash Accounting & Uncertain Spend), S8-10 (Medium: TOCTOU Concurrency CAS).
// Invariant: Conservation Law: TotalLimit = Consumed_P + sum(Escrow_c) + Available_P.
// Invariant: Available_P >= 0 at all times.
// Invariant: Automatic refund of UNCERTAIN spend is strictly prohibited.

import {
  type DelegationBudget,
  DelegationBudgetSchema,
  type BudgetEscrowState,
  type DelegationId,
} from "../contracts/delegation.js";
import type { Ledger } from "../ledger/ledger.js";
import { MultiAgentProjection } from "./projection.js";

export class BudgetEscrowError extends Error {
  constructor(message: string) {
    super(`BudgetEscrowError: ${message}`);
    this.name = "BudgetEscrowError";
  }
}

export class UncertainBudgetRefundError extends BudgetEscrowError {
  constructor(delegationId: string) {
    super(
      `Automatic refund of UNCERTAIN budget escrow for delegation "${delegationId}" is strictly prohibited (INV-33/S8-06). Audited reconciliation required.`,
    );
    this.name = "UncertainBudgetRefundError";
  }
}

export class InsufficientBudgetError extends BudgetEscrowError {
  constructor(dimension: string, requested: number, available: number) {
    super(`Insufficient available budget for "${dimension}": requested ${requested}, available ${available}`);
    this.name = "InsufficientBudgetError";
  }
}

export const MIN_ESCROW_TOKENS_FLOOR = 10_000;

export class BudgetBelowMinimumFloorError extends BudgetEscrowError {
  constructor(requested: number, floor: number = MIN_ESCROW_TOKENS_FLOOR) {
    super(`Requested delegation budget of ${requested} tokens is below minimum floor of ${floor} tokens (DR-03/P2C-010)`);
    this.name = "BudgetBelowMinimumFloorError";
  }
}

export interface BudgetReservationResult {
  ok: boolean;
  delegationId: DelegationId;
  remainingAvailable?: DelegationBudget;
  reason?: string;
  errorDimension?: string;
}

export interface DelegationEscrowEntry {
  delegationId: DelegationId;
  state: BudgetEscrowState;
  escrowed: DelegationBudget;
  consumed: {
    tokens: number;
    modelCalls: number;
    capabilityCalls: number;
    executionTimeMs: number;
    artifactBytes: number;
  };
  refundable: {
    tokens: number;
    modelCalls: number;
    capabilityCalls: number;
    executionTimeMs: number;
    artifactBytes: number;
  };
  uncertain: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hierarchical Budget Escrow Manager.
 * Manages parent available budget pool and 7-state escrow lifecycles for delegated children.
 */
export class BudgetEscrowManager {
  private readonly escrows = new Map<DelegationId, DelegationEscrowEntry>();
  private available: DelegationBudget;
  private readonly totalLimit: DelegationBudget;
  private parentConsumed = {
    tokens: 0,
    modelCalls: 0,
    capabilityCalls: 0,
    executionTimeMs: 0,
    artifactBytes: 0,
  };

  constructor(initialLimit: DelegationBudget) {
    this.totalLimit = DelegationBudgetSchema.parse(initialLimit);
    this.available = { ...this.totalLimit };
  }

  getAvailableBudget(): DelegationBudget {
    return { ...this.available };
  }

  getTotalLimit(): DelegationBudget {
    return { ...this.totalLimit };
  }

  getEscrow(delegationId: DelegationId): DelegationEscrowEntry | undefined {
    const entry = this.escrows.get(delegationId);
    return entry ? { ...entry, escrowed: { ...entry.escrowed }, consumed: { ...entry.consumed }, refundable: { ...entry.refundable } } : undefined;
  }

  /**
   * Atomic CAS Reservation:
   * Checks if parent has sufficient unallocated available budget across all dimensions.
   * If yes: atomically deducts requested amounts from AVAILABLE and moves to ESCROWED.
   * If no: rejects cleanly without modifying state.
   */
  atomicReserveEscrow(
    delegationId: DelegationId,
    requested: DelegationBudget,
  ): BudgetReservationResult {
    const parsed = DelegationBudgetSchema.parse(requested);

    if (this.escrows.has(delegationId)) {
      return {
        ok: false,
        delegationId,
        reason: `Delegation "${delegationId}" already has an escrow reservation`,
      };
    }

    // Atomic CAS checks across all dimensions
    if (parsed.maxTokens > this.available.maxTokens) {
      return {
        ok: false,
        delegationId,
        reason: "InsufficientAvailableBudget",
        errorDimension: "maxTokens",
      };
    }
    if (parsed.maxModelCalls > this.available.maxModelCalls) {
      return {
        ok: false,
        delegationId,
        reason: "InsufficientAvailableBudget",
        errorDimension: "maxModelCalls",
      };
    }
    if (parsed.maxCapabilityCalls > this.available.maxCapabilityCalls) {
      return {
        ok: false,
        delegationId,
        reason: "InsufficientAvailableBudget",
        errorDimension: "maxCapabilityCalls",
      };
    }
    if (parsed.maxExecutionTimeMs > this.available.maxExecutionTimeMs) {
      return {
        ok: false,
        delegationId,
        reason: "InsufficientAvailableBudget",
        errorDimension: "maxExecutionTimeMs",
      };
    }
    if (parsed.maxArtifactBytes > this.available.maxArtifactBytes) {
      return {
        ok: false,
        delegationId,
        reason: "InsufficientAvailableBudget",
        errorDimension: "maxArtifactBytes",
      };
    }

    // Atomically decrement AVAILABLE
    this.available.maxTokens -= parsed.maxTokens;
    this.available.maxModelCalls -= parsed.maxModelCalls;
    this.available.maxCapabilityCalls -= parsed.maxCapabilityCalls;
    this.available.maxExecutionTimeMs -= parsed.maxExecutionTimeMs;
    this.available.maxArtifactBytes -= parsed.maxArtifactBytes;

    const now = new Date().toISOString();
    const entry: DelegationEscrowEntry = {
      delegationId,
      state: "ESCROWED",
      escrowed: { ...parsed },
      consumed: {
        tokens: 0,
        modelCalls: 0,
        capabilityCalls: 0,
        executionTimeMs: 0,
        artifactBytes: 0,
      },
      refundable: {
        tokens: 0,
        modelCalls: 0,
        capabilityCalls: 0,
        executionTimeMs: 0,
        artifactBytes: 0,
      },
      uncertain: false,
      createdAt: now,
      updatedAt: now,
    };

    this.escrows.set(delegationId, entry);

    this.assertConservationLaw();

    return {
      ok: true,
      delegationId,
      remainingAvailable: { ...this.available },
    };
  }

  /**
   * Transition: ESCROWED -> ALLOCATED
   * Called when child container is spawned and execution begins.
   */
  activateEscrow(delegationId: DelegationId): void {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state !== "ESCROWED") {
      throw new BudgetEscrowError(`Cannot activate escrow in state "${entry.state}"`);
    }

    entry.state = "ALLOCATED";
    entry.updatedAt = new Date().toISOString();
  }

  /**
   * Transition: ESCROWED -> REFUNDED
   * Called if child spawn was cancelled pre-spawn. Entire escrow returned to AVAILABLE.
   */
  cancelEscrow(delegationId: DelegationId): void {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state !== "ESCROWED") {
      throw new BudgetEscrowError(`Cannot cancel escrow in state "${entry.state}"`);
    }

    // Recredit full escrow to AVAILABLE
    this.available.maxTokens += entry.escrowed.maxTokens;
    this.available.maxModelCalls += entry.escrowed.maxModelCalls;
    this.available.maxCapabilityCalls += entry.escrowed.maxCapabilityCalls;
    this.available.maxExecutionTimeMs += entry.escrowed.maxExecutionTimeMs;
    this.available.maxArtifactBytes += entry.escrowed.maxArtifactBytes;

    entry.state = "REFUNDED";
    entry.updatedAt = new Date().toISOString();
    this.assertConservationLaw();
  }

  /**
   * Transition: ALLOCATED -> CONSUMED (incremental audited spend)
   */
  recordSpend(
    delegationId: DelegationId,
    spend: {
      tokens?: number;
      modelCalls?: number;
      capabilityCalls?: number;
      executionTimeMs?: number;
      artifactBytes?: number;
    },
  ): void {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state !== "ALLOCATED") {
      throw new BudgetEscrowError(`Cannot record spend in state "${entry.state}"`);
    }

    const t = spend.tokens ?? 0;
    const m = spend.modelCalls ?? 0;
    const c = spend.capabilityCalls ?? 0;
    const e = spend.executionTimeMs ?? 0;
    const a = spend.artifactBytes ?? 0;

    if (entry.consumed.tokens + t > entry.escrowed.maxTokens) {
      throw new BudgetEscrowError("Spend exceeds escrowed token limit");
    }
    if (entry.consumed.modelCalls + m > entry.escrowed.maxModelCalls) {
      throw new BudgetEscrowError("Spend exceeds escrowed model call limit");
    }
    if (entry.consumed.capabilityCalls + c > entry.escrowed.maxCapabilityCalls) {
      throw new BudgetEscrowError("Spend exceeds escrowed capability call limit");
    }

    entry.consumed.tokens += t;
    entry.consumed.modelCalls += m;
    entry.consumed.capabilityCalls += c;
    entry.consumed.executionTimeMs += e;
    entry.consumed.artifactBytes += a;
    entry.updatedAt = new Date().toISOString();
  }

  /**
   * Transition: ALLOCATED -> REFUNDABLE -> REFUNDED
   * Normal termination with verified receipt.
   * Unspent balance = Escrow - Audited Spend is returned to parent AVAILABLE.
   */
  reconcileReceipt(
    delegationId: DelegationId,
    verifiedSpend: {
      tokens: number;
      modelCalls: number;
      capabilityCalls: number;
      executionTimeMs: number;
      artifactBytes: number;
    },
  ): { refundedTokens: number } {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state !== "ALLOCATED") {
      throw new BudgetEscrowError(`Cannot reconcile receipt in state "${entry.state}"`);
    }

    // Set consumed to verified spend
    entry.consumed.tokens = Math.min(verifiedSpend.tokens, entry.escrowed.maxTokens);
    entry.consumed.modelCalls = Math.min(verifiedSpend.modelCalls, entry.escrowed.maxModelCalls);
    entry.consumed.capabilityCalls = Math.min(verifiedSpend.capabilityCalls, entry.escrowed.maxCapabilityCalls);
    entry.consumed.executionTimeMs = Math.min(verifiedSpend.executionTimeMs, entry.escrowed.maxExecutionTimeMs);
    entry.consumed.artifactBytes = Math.min(verifiedSpend.artifactBytes, entry.escrowed.maxArtifactBytes);

    // Calculate unspent remainder
    const remTokens = entry.escrowed.maxTokens - entry.consumed.tokens;
    const remModelCalls = entry.escrowed.maxModelCalls - entry.consumed.modelCalls;
    const remCapCalls = entry.escrowed.maxCapabilityCalls - entry.consumed.capabilityCalls;
    const remTime = entry.escrowed.maxExecutionTimeMs - entry.consumed.executionTimeMs;
    const remBytes = entry.escrowed.maxArtifactBytes - entry.consumed.artifactBytes;

    entry.refundable = {
      tokens: remTokens,
      modelCalls: remModelCalls,
      capabilityCalls: remCapCalls,
      executionTimeMs: remTime,
      artifactBytes: remBytes,
    };
    entry.state = "REFUNDABLE";

    // Commit refund back to AVAILABLE
    this.available.maxTokens += remTokens;
    this.available.maxModelCalls += remModelCalls;
    this.available.maxCapabilityCalls += remCapCalls;
    this.available.maxExecutionTimeMs += remTime;
    this.available.maxArtifactBytes += remBytes;

    entry.state = "REFUNDED";
    entry.updatedAt = new Date().toISOString();

    this.assertConservationLaw();

    return { refundedTokens: remTokens };
  }

  /**
   * Transition: ALLOCATED -> UNCERTAIN (Remediates S8-06)
   * Child died, killed, or crashed without delivering verified receipt.
   * Actual spend is unknown until host crash audit runs.
   */
  handleCrashOrAbruptTermination(delegationId: DelegationId): void {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);

    entry.state = "UNCERTAIN";
    entry.uncertain = true;
    entry.updatedAt = new Date().toISOString();
  }

  /**
   * S8-06 Enforcement: Attempting to call refund on an UNCERTAIN escrow
   * without audit MUST throw UncertainBudgetRefundError.
   */
  refundUncertainDirectly(delegationId: DelegationId): void {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state === "UNCERTAIN" || entry.uncertain) {
      throw new UncertainBudgetRefundError(delegationId);
    }
    throw new BudgetEscrowError(`Delegation "${delegationId}" is not in UNCERTAIN state`);
  }

  /**
   * Resolves an UNCERTAIN escrow after host Crash Audit Daemon verifies child journal.
   * Deterministically partitions:
   * Consumed = AuditedSpent
   * Refundable = Escrow - AuditedSpent
   * Returns Refundable to AVAILABLE.
   */
  reconcileCrashAudit(
    delegationId: DelegationId,
    auditedSpend: {
      tokens: number;
      modelCalls: number;
      capabilityCalls: number;
      executionTimeMs: number;
      artifactBytes: number;
    },
  ): { refundedTokens: number } {
    const entry = this.escrows.get(delegationId);
    if (!entry) throw new BudgetEscrowError(`Delegation "${delegationId}" not found`);
    if (entry.state !== "UNCERTAIN" && !entry.uncertain) {
      throw new BudgetEscrowError(`Delegation "${delegationId}" is not in UNCERTAIN state`);
    }

    // Partition spend
    entry.consumed.tokens = Math.min(auditedSpend.tokens, entry.escrowed.maxTokens);
    entry.consumed.modelCalls = Math.min(auditedSpend.modelCalls, entry.escrowed.maxModelCalls);
    entry.consumed.capabilityCalls = Math.min(auditedSpend.capabilityCalls, entry.escrowed.maxCapabilityCalls);
    entry.consumed.executionTimeMs = Math.min(auditedSpend.executionTimeMs, entry.escrowed.maxExecutionTimeMs);
    entry.consumed.artifactBytes = Math.min(auditedSpend.artifactBytes, entry.escrowed.maxArtifactBytes);

    const remTokens = entry.escrowed.maxTokens - entry.consumed.tokens;
    const remModelCalls = entry.escrowed.maxModelCalls - entry.consumed.modelCalls;
    const remCapCalls = entry.escrowed.maxCapabilityCalls - entry.consumed.capabilityCalls;
    const remTime = entry.escrowed.maxExecutionTimeMs - entry.consumed.executionTimeMs;
    const remBytes = entry.escrowed.maxArtifactBytes - entry.consumed.artifactBytes;

    entry.refundable = {
      tokens: remTokens,
      modelCalls: remModelCalls,
      capabilityCalls: remCapCalls,
      executionTimeMs: remTime,
      artifactBytes: remBytes,
    };

    // Recredit verified unspent back to AVAILABLE
    this.available.maxTokens += remTokens;
    this.available.maxModelCalls += remModelCalls;
    this.available.maxCapabilityCalls += remCapCalls;
    this.available.maxExecutionTimeMs += remTime;
    this.available.maxArtifactBytes += remBytes;

    entry.state = "REFUNDED";
    entry.uncertain = false;
    entry.updatedAt = new Date().toISOString();

    this.assertConservationLaw();

    return { refundedTokens: remTokens };
  }

  /**
   * Invariant Check: Conservation Law
   * TotalLimit(tokens) == Available(tokens) + sum(Active Escrows) + sum(Settled Consumed)
   * And Available >= 0 at all times.
   */
  private assertConservationLaw(): void {
    if (
      this.available.maxTokens < 0 ||
      this.available.maxModelCalls < 0 ||
      this.available.maxCapabilityCalls < 0
    ) {
      throw new BudgetEscrowError("Conservation Law Violated: Available budget dropped below zero!");
    }

    let activeEscrowTokens = 0;
    let settledConsumedTokens = this.parentConsumed.tokens;

    for (const entry of this.escrows.values()) {
      if (entry.state === "ESCROWED" || entry.state === "ALLOCATED" || entry.state === "UNCERTAIN") {
        activeEscrowTokens += entry.escrowed.maxTokens;
      } else if (entry.state === "REFUNDED" || entry.state === "CONSUMED") {
        settledConsumedTokens += entry.consumed.tokens;
      }
    }

    const currentSum = this.available.maxTokens + activeEscrowTokens + settledConsumedTokens;
    if (currentSum !== this.totalLimit.maxTokens) {
      throw new BudgetEscrowError(
        `Conservation Law Violated: TotalLimit (${this.totalLimit.maxTokens}) !== sum (${currentSum})`,
      );
    }
  }

  /**
   * Rebuilds BudgetEscrowManager from canonical Ledger records.
   * Remediates: AUDIT-P1-01 (Budget Durability) & AUDIT-P1-07 (Single Source of Truth).
   */
  static rebuildFromLedger(ledger: Ledger, initialBudget?: DelegationBudget): BudgetEscrowManager {
    const projection = MultiAgentProjection.rebuildFromLedger(ledger, initialBudget);
    return BudgetEscrowManager.fromProjection(projection);
  }

  /**
   * Rebuilds BudgetEscrowManager from a MultiAgentProjection.
   */
  static fromProjection(projection: MultiAgentProjection): BudgetEscrowManager {
    const manager = new BudgetEscrowManager(projection.getTotalLimit());
    manager.available = projection.getAvailableBudget();
    for (const d of projection.allDelegations()) {
      const e = projection.getEscrow(d.delegationId);
      if (e) {
        manager.escrows.set(d.delegationId, {
          delegationId: e.delegationId,
          state: e.state as BudgetEscrowState,
          escrowed: { ...e.escrowed },
          consumed: { ...e.consumed },
          refundable: { ...e.refundable },
          uncertain: e.uncertain,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        });
      }
    }
    manager.assertConservationLaw();
    return manager;
  }
}
