// FORGE Governed Reservation Coordinator (Step 8 Phase 2C.2)
// Atomic serialized authorization transaction combining budget reservation,
// topology slot acquisition, criterion state verification, and plan epoch validation.
// Enforces DR-03, DR-06, DR-07, and P2C-RACE-003.

import type { DelegationBudget, DelegationRegistryEntry, DelegationId } from "../contracts/delegation.js";
import type { CriterionId } from "../contracts/base.js";
import type { ContributionType } from "../contracts/intent.js";
import {
  DelegationRegistry,
  DepthLimitExceededError,
  FanoutLimitExceededError,
  GlobalConcurrencyLimitError,
  CycleDetectedError,
} from "./registry.js";
import {
  BudgetEscrowManager,
  BudgetBelowMinimumFloorError,
  InsufficientBudgetError,
  MIN_ESCROW_TOKENS_FLOOR,
  type BudgetReservationResult,
} from "./budget-escrow.js";
import type { CriterionStore } from "./intent-gate.js";
import { acquireLock, type LockHandle } from "../ledger/lock.js";

export class InvalidParentStateError extends Error {
  constructor(message = "Parent delegation is not in active state") {
    super(message);
    this.name = "InvalidParentStateError";
  }
}

export class StalePlanEpochError extends Error {
  constructor(message = "Plan epoch is stale") {
    super(message);
    this.name = "StalePlanEpochError";
  }
}

export class DependencyUnsatisfiedError extends Error {
  constructor(message = "Task prerequisite dependencies are not satisfied") {
    super(message);
    this.name = "DependencyUnsatisfiedError";
  }
}

export class InvalidCriterionStateError extends Error {
  constructor(message = "Criterion is not in valid state for delegation") {
    super(message);
    this.name = "InvalidCriterionStateError";
  }
}

export interface DelegationReservationRequest {
  delegationId: DelegationId;
  targetCriterionId?: CriterionId;
  criterionVersion?: number;
  contributionType?: ContributionType;
  budget: DelegationBudget;
  planEpoch?: number;
  taskId?: string;
  entry: DelegationRegistryEntry;
}

export interface ReservationCommit {
  committed: boolean;
  entry: DelegationRegistryEntry;
  escrow: BudgetReservationResult;
}

export interface GovernedReservationOptions {
  parentDelegationId: DelegationId | null;
  request: DelegationReservationRequest;
  registry: DelegationRegistry;
  budgetManager: BudgetEscrowManager;
  criterionStore?: CriterionStore;
  currentPlanEpoch?: number;
  unsatisfiedDependencies?: string[];
  enforceTokenFloor?: boolean;
  lockDir?: string;
}

export class GovernedReservationCoordinator {
  // Process-local mutex chain ensuring strictly serialized reservation transactions
  private static mutexChain: Promise<void> = Promise.resolve();

  private static async withSerializedLock<T>(lockDir: string | undefined, fn: () => Promise<T>): Promise<T> {
    // Acquire in-memory queue slot
    let releaseMemQueue: () => void = () => {};
    const memLockAcquired = new Promise<void>((resolve) => {
      releaseMemQueue = resolve;
    });
    const prior = GovernedReservationCoordinator.mutexChain;
    GovernedReservationCoordinator.mutexChain = (async () => {
      await prior;
      await memLockAcquired;
    })();

    await prior;

    let fileLock: LockHandle | undefined;
    try {
      if (lockDir) {
        fileLock = acquireLock(lockDir, "governed-reservation-coordinator", {
          pid: process.pid,
          host: "coordinator-mutex",
        });
      }
      return await fn();
    } finally {
      if (fileLock) {
        try {
          fileLock.release();
        } catch {
          // ignore lock release error on exit
        }
      }
      releaseMemQueue();
    }
  }

  /**
   * Executes atomic serialized reservation transaction (DR-03, DR-06, DR-07).
   */
  static async executeReservationTransaction(
    opts: GovernedReservationOptions,
  ): Promise<ReservationCommit> {
    return GovernedReservationCoordinator.withSerializedLock(opts.lockDir, async () => {
      const {
        parentDelegationId,
        request,
        registry,
        budgetManager,
        criterionStore,
        currentPlanEpoch,
        unsatisfiedDependencies,
        enforceTokenFloor = true,
      } = opts;

      // 1. Validate Parent State & Lineage (if non-root)
      if (parentDelegationId !== null) {
        const parent = registry.getDelegation(parentDelegationId);
        if (!parent || parent.status !== "active") {
          throw new InvalidParentStateError(
            `Parent delegation "${parentDelegationId}" not found or not in active state (status=${parent?.status})`,
          );
        }

        // Depth Hierarchy limit: Depth 2 (Grandchild) cannot delegate further (P2C-004)
        if (parent.depth >= 2) {
          throw new DepthLimitExceededError(parent.depth);
        }

        // Fanout limit: Maximum 3 active concurrent children per parent (P2C-005)
        const activeChildren = registry.getActiveChildCount(parentDelegationId);
        if (activeChildren >= 3) {
          throw new FanoutLimitExceededError(3);
        }
      }

      // 2. Global Concurrency Ceiling: Max 10 active agents across the system (DR-07)
      if (registry.getActiveAgentCount() >= 10) {
        throw new GlobalConcurrencyLimitError(10);
      }

      // 3. Cycle Detection in Ancestor Path (P2C-006)
      const path = request.entry.ancestorPath;
      const pathSet = new Set(path);
      if (pathSet.size !== path.length) {
        throw new CycleDetectedError(
          request.delegationId,
          `Ancestor cycle detected in delegation path: [${path.join(", ")}] (P2C-006)`,
        );
      }

      // 4. Plan Epoch & Dependency Barrier (DR-06, DR-08)
      if (request.planEpoch !== undefined && currentPlanEpoch !== undefined && request.planEpoch !== currentPlanEpoch) {
        throw new StalePlanEpochError(
          `Request plan epoch ${request.planEpoch} does not match current plan epoch ${currentPlanEpoch}`,
        );
      }
      if (unsatisfiedDependencies && unsatisfiedDependencies.length > 0) {
        throw new DependencyUnsatisfiedError(
          `Prerequisite tasks unsatisfied: [${unsatisfiedDependencies.join(", ")}]`,
        );
      }

      // 5. Criterion Validation (DR-02, P2C-008)
      if (criterionStore && request.targetCriterionId) {
        const crit = criterionStore.get(request.targetCriterionId);
        if (!crit) {
          throw new InvalidCriterionStateError(`Target criterion "${request.targetCriterionId}" not found`);
        }
        if (crit.status === "satisfied" || crit.status === "failed" || crit.status === "invalidated") {
          throw new InvalidCriterionStateError(
            `Target criterion "${request.targetCriterionId}" is in terminal state "${crit.status}"`,
          );
        }
        if (request.criterionVersion !== undefined && request.criterionVersion !== crit.immutableVersion) {
          throw new InvalidCriterionStateError(
            `Criterion version mismatch: request version ${request.criterionVersion} !== active version ${crit.immutableVersion}`,
          );
        }
      }

      // 6. Minimum Escrow Floor (DR-03, P2C-010)
      if (enforceTokenFloor && request.budget.maxTokens < MIN_ESCROW_TOKENS_FLOOR) {
        throw new BudgetBelowMinimumFloorError(request.budget.maxTokens, MIN_ESCROW_TOKENS_FLOOR);
      }

      // 7. Atomic Multi-Dimension CAS Budget Reservation (DR-03, P2C-012, P2C-RACE-003)
      const res = budgetManager.atomicReserveEscrow(request.delegationId, request.budget);
      if (!res.ok) {
        const available = budgetManager.getAvailableBudget();
        throw new InsufficientBudgetError(
          res.errorDimension ?? "maxTokens",
          request.budget.maxTokens,
          available.maxTokens,
        );
      }

      // 8. Register Delegation in Authoritative Registry
      const entry = registry.registerDelegation(request.entry);

      return {
        committed: true,
        entry,
        escrow: res,
      };
    });
  }
}
