// FORGE Delegation Authority Registry (Step 8 Phase 1)
// Host-authoritative registry managing multi-agent delegation lineage,
// process/container binding, incarnation epochs, and cascade revocation.
// Remediates: S8-04 (Critical: Grandchild Zombie Containment), S8-08 (High: Pre-dispatch Revocation).

import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  type DelegationRegistryEntry,
  DelegationRegistryEntrySchema,
  type DelegationId,
  type DelegationStatus,
  type IncarnationEpoch,
} from "../contracts/delegation.js";
import type { MissionId, Iso8601 } from "../contracts/base.js";
import { acquireLock, LockError, type LockHandle } from "../ledger/lock.js";
import type { Ledger } from "../ledger/ledger.js";
import { MultiAgentProjection } from "./projection.js";

export const MAX_DELEGATION_DEPTH = 3;
export const MAX_CHILD_FANOUT = 3;
export const MAX_ACTIVE_AGENTS = 10;

export class DelegationRegistryError extends Error {
  constructor(message: string) {
    super(`DelegationRegistryError: ${message}`);
    this.name = "DelegationRegistryError";
  }
}

export class TopologyLimitError extends DelegationRegistryError {
  constructor(public readonly limitType: "depth" | "fanout" | "active_agents", message: string) {
    super(message);
    this.name = "TopologyLimitError";
  }
}

export class DepthLimitExceededError extends TopologyLimitError {
  constructor(depth: number) {
    super("depth", `Delegation depth ${depth} reached or exceeds maximum allowed depth`);
    this.name = "DepthLimitExceededError";
  }
}

export class FanoutLimitExceededError extends TopologyLimitError {
  constructor(fanout: number = 3) {
    super("fanout", `Active child count reached maximum fanout limit of ${fanout}`);
    this.name = "FanoutLimitExceededError";
  }
}

export class GlobalConcurrencyLimitError extends TopologyLimitError {
  constructor(activeCount: number = 10) {
    super("active_agents", `Global active agent count reached ceiling of ${activeCount}`);
    this.name = "GlobalConcurrencyLimitError";
  }
}

export class CycleDetectedError extends DelegationRegistryError {
  constructor(public readonly delegationId: string, message: string) {
    super(message);
    this.name = "CycleDetectedError";
  }
}

export class DelegationNotFoundError extends DelegationRegistryError {
  constructor(public readonly delegationId: string) {
    super(`Delegation "${delegationId}" not found in registry`);
    this.name = "DelegationNotFoundError";
  }
}

export class InvalidStateTransitionError extends DelegationRegistryError {
  constructor(public readonly fromStatus: string, public readonly toStatus: string, message?: string) {
    super(message ?? `Invalid delegation state transition from "${fromStatus}" to "${toStatus}"`);
    this.name = "InvalidStateTransitionError";
  }
}

/**
 * Host-Authoritative Delegation Authority Registry.
 * Tracks all active delegations across root, child, and grandchild missions.
 */
export class DelegationRegistry {
  private readonly entries = new Map<DelegationId, DelegationRegistryEntry>();
  private readonly childMissionIndex = new Map<MissionId, DelegationId>();

  constructor(private readonly storagePath?: string) {}

  /**
   * Registers a new delegation grant into the registry.
   * Enforces:
   * 1. Schema validity.
   * 2. Max depth bound D <= 3.
   * 3. Max parent fanout F <= 3.
   * 4. Max active agent ceiling N <= 10.
   * 5. Cycle prevention via ancestorPath verification.
   * 6. Valid parent delegation binding.
   */
  registerDelegation(rawEntry: DelegationRegistryEntry): DelegationRegistryEntry {
    const entry = DelegationRegistryEntrySchema.parse(rawEntry);

    // Check unique ID
    if (this.entries.has(entry.delegationId)) {
      throw new DelegationRegistryError(
        `Delegation with ID "${entry.delegationId}" already registered`,
      );
    }

    // Check depth bound
    if (entry.depth > MAX_DELEGATION_DEPTH) {
      throw new TopologyLimitError(
        "depth",
        `Delegation depth ${entry.depth} exceeds max permitted depth of ${MAX_DELEGATION_DEPTH}`,
      );
    }

    // Check ancestor path consistency
    if (entry.ancestorPath.length !== entry.depth) {
      throw new DelegationRegistryError(
        `Ancestor path length (${entry.ancestorPath.length}) must equal depth (${entry.depth})`,
      );
    }

    if (entry.ancestorPath[entry.ancestorPath.length - 1] !== entry.delegationId) {
      throw new DelegationRegistryError(
        `Ancestor path terminal must match delegationId "${entry.delegationId}"`,
      );
    }

    // Cycle detection in ancestor path
    const ancestorsExceptSelf = entry.ancestorPath.slice(0, -1);
    if (ancestorsExceptSelf.includes(entry.delegationId)) {
      throw new CycleDetectedError(
        entry.delegationId,
        `Self-referential cycle detected in ancestor path for "${entry.delegationId}"`,
      );
    }

    // Validate parent linkage if not root child
    if (entry.parentDelegationId !== null) {
      const parent = this.entries.get(entry.parentDelegationId);
      if (!parent) {
        throw new DelegationNotFoundError(entry.parentDelegationId);
      }
      if (parent.status === "revoked" || parent.status === "expired" || parent.status === "failed") {
        throw new DelegationRegistryError(
          `Cannot delegate from parent "${entry.parentDelegationId}" with status "${parent.status}"`,
        );
      }
      if (parent.depth + 1 !== entry.depth) {
        throw new DelegationRegistryError(
          `Child depth ${entry.depth} must be exactly parent depth ${parent.depth} + 1`,
        );
      }

      // Check cycle: parent's ancestor path must not contain child delegationId
      if (parent.ancestorPath.includes(entry.delegationId)) {
        throw new CycleDetectedError(
          entry.delegationId,
          `Delegation cycle detected: parent ${entry.parentDelegationId} contains ${entry.delegationId}`,
        );
      }

      // AUDIT-P1-10: Check all ancestors in ancestorPath are not revoked
      for (const ancestorId of entry.ancestorPath.slice(0, -1)) {
        const ancestor = this.entries.get(ancestorId);
        if (!ancestor) {
          throw new DelegationNotFoundError(ancestorId);
        }
        if (ancestor.status === "revoked" || ancestor.status === "expired" || ancestor.status === "failed") {
          throw new DelegationRegistryError(
            `Cannot delegate: ancestor "${ancestorId}" has status "${ancestor.status}"`,
          );
        }
      }

      // Check parent fanout bound
      const activeChildren = this.getActiveChildCount(entry.parentDelegationId);
      if (activeChildren >= MAX_CHILD_FANOUT) {
        throw new TopologyLimitError(
          "fanout",
          `Parent delegation "${entry.parentDelegationId}" has reached max active child fanout (${MAX_CHILD_FANOUT})`,
        );
      }
    }

    // Check global active agent limit
    const activeCount = this.getActiveAgentCount();
    if (activeCount >= MAX_ACTIVE_AGENTS) {
      throw new TopologyLimitError(
        "active_agents",
        `Active agent count (${activeCount}) has reached global maximum (${MAX_ACTIVE_AGENTS})`,
      );
    }

    // Store in index
    this.entries.set(entry.delegationId, { ...entry });
    this.childMissionIndex.set(entry.childMissionId, entry.delegationId);

    if (this.storagePath) {
      this.persistSync();
    }

    return { ...entry };
  }

  /**
   * Retrieves a delegation entry by its delegationId.
   */
  getDelegation(delegationId: DelegationId): DelegationRegistryEntry | undefined {
    const found = this.entries.get(delegationId);
    return found ? { ...found } : undefined;
  }

  /**
   * Retrieves a delegation entry by its child missionId.
   */
  getByChildMissionId(missionId: MissionId): DelegationRegistryEntry | undefined {
    const delegationId = this.childMissionIndex.get(missionId);
    if (!delegationId) return undefined;
    return this.getDelegation(delegationId);
  }

  /**
   * Discovers all descendants of a delegation.
   * By default includes the target delegation itself if includeSelf is true.
   */
  listDescendants(delegationId: DelegationId, includeSelf = true): DelegationRegistryEntry[] {
    const results: DelegationRegistryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.delegationId === delegationId) {
        if (includeSelf) results.push({ ...entry });
      } else if (entry.ancestorPath.includes(delegationId)) {
        results.push({ ...entry });
      }
    }
    return results;
  }

  /**
   * Cascade revocation (Remediates S8-04).
   * Atomically transitions target delegation and ALL descendants to "revoked".
   * Returns all updated entries so supervisor can kill corresponding processes/containers.
   */
  revokeDelegation(delegationId: DelegationId, reason: string): DelegationRegistryEntry[] {
    const target = this.entries.get(delegationId);
    if (!target) {
      throw new DelegationNotFoundError(delegationId);
    }

    const descendants = this.listDescendants(delegationId, true);
    const now = new Date().toISOString() as Iso8601;
    const revokedEntries: DelegationRegistryEntry[] = [];

    for (const d of descendants) {
      const current = this.entries.get(d.delegationId)!;
      // If already terminal (completed/failed), we preserve terminal status unless active/authorized/suspended
      const activeStates: DelegationStatus[] = ["authorized", "active", "suspended", "proposed"];
      if (activeStates.includes(current.status)) {
        current.status = "revoked";
        current.revokedAt = now;
        current.revocationReason = reason;
      } else if (current.status !== "revoked") {
        current.revokedAt = now;
        current.revocationReason = reason;
      }
      this.entries.set(current.delegationId, { ...current });
      revokedEntries.push({ ...current });
    }

    if (this.storagePath) {
      this.persistSync();
    }

    return revokedEntries;
  }

  /**
   * Cascade revocation alias (remediates S8-04, P2C-RACE-001, P2C-RACE-006).
   */
  revokeCascade(delegationId: DelegationId, reason: string): DelegationRegistryEntry[] {
    return this.revokeDelegation(delegationId, reason);
  }

  /**
   * Full Ancestor Lineage Check (P2C-RACE-006).
   * Traverses the entire ancestorPath from root down to target delegation.
   * If any node in the chain is revoked or non-active, effective lineage is inactive.
   */
  isLineageActive(delegationId: DelegationId): { ok: true } | { ok: false; reason: string; revokedAtId: string } {
    const entry = this.entries.get(delegationId);
    if (!entry) {
      return { ok: false, reason: "Delegation not found in registry", revokedAtId: delegationId };
    }

    if (entry.status === "revoked") {
      return { ok: false, reason: "Delegation is explicitly revoked", revokedAtId: entry.delegationId };
    }

    for (const ancestorId of entry.ancestorPath) {
      if (ancestorId === delegationId) continue;
      const ancestor = this.entries.get(ancestorId);
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

    return { ok: true };
  }

  /**
   * Reincarnates an agent with a strictly higher incarnation epoch (INV-30).
   */
  reincarnate(
    delegationId: DelegationId,
    newEpoch: IncarnationEpoch,
    containerId: string | null = null,
    hostPid: number | null = null,
  ): DelegationRegistryEntry {
    const entry = this.entries.get(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    if (newEpoch <= entry.childIncarnationEpoch) {
      throw new DelegationRegistryError(
        `New incarnation epoch (${newEpoch}) must be strictly greater than current (${entry.childIncarnationEpoch})`,
      );
    }

    if (entry.status === "revoked" || entry.status === "expired" || entry.status === "completed") {
      throw new DelegationRegistryError(
        `Cannot reincarnate delegation "${delegationId}" with status "${entry.status}"`,
      );
    }

    entry.childIncarnationEpoch = newEpoch;
    entry.containerId = containerId;
    entry.hostPid = hostPid;
    entry.status = "active";

    this.entries.set(delegationId, { ...entry });

    if (this.storagePath) {
      this.persistSync();
    }

    return { ...entry };
  }

  /**
   * Updates execution handle (hostPid and/or containerId) for an active delegation.
   */
  updateExecutionHandle(
    delegationId: DelegationId,
    hostPid: number | null,
    containerId: string | null = null,
  ): DelegationRegistryEntry {
    const entry = this.entries.get(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    entry.hostPid = hostPid;
    if (containerId !== null) {
      entry.containerId = containerId;
    }
    this.entries.set(delegationId, { ...entry });

    if (this.storagePath) {
      this.persistSync();
    }

    return { ...entry };
  }

  /**
   * Updates status of a delegation enforcing the formal state machine.
   */
  updateStatus(delegationId: DelegationId, status: DelegationStatus): DelegationRegistryEntry {
    const entry = this.entries.get(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    // Terminal states cannot transition to anything
    const terminalStates: DelegationStatus[] = [
      "completed",
      "failed",
      "revoked",
      "cancelled",
      "expired",
      "rejected",
    ];
    if (terminalStates.includes(entry.status)) {
      throw new InvalidStateTransitionError(
        entry.status,
        status,
        `Cannot transition terminal delegation "${delegationId}" from "${entry.status}" to "${status}"`,
      );
    }

    // Verify valid transition according to formal Phase 2 state machine
    const validTransitions: Record<string, string[]> = {
      requested: ["authorized", "rejected", "failed"],
      proposed: ["authorized", "rejected", "failed"],
      authorized: ["activating", "active", "revoked", "cancelled", "expired", "failed"],
      activating: ["active", "crashed", "failed", "revoked"],
      active: [
        "paused",
        "suspended",
        "revoking",
        "revoked",
        "completed",
        "failed",
        "cancelled",
        "crashed",
        "uncertain",
        "post_effect_unknown",
      ],
      paused: ["active", "revoking", "revoked", "cancelled", "crashed"],
      suspended: ["active", "revoking", "revoked", "cancelled", "crashed"],
      revoking: ["revoked"],
      crashed: ["uncertain", "failed", "post_effect_unknown"],
      uncertain: ["failed"],
      post_effect_unknown: ["failed", "uncertain"],
    };

    const allowed = validTransitions[entry.status];
    if (allowed && !allowed.includes(status)) {
      throw new InvalidStateTransitionError(
        entry.status,
        status,
        `Invalid transition for delegation "${delegationId}" from "${entry.status}" to "${status}"`,
      );
    }

    entry.status = status;
    this.entries.set(delegationId, { ...entry });

    if (this.storagePath) {
      this.persistSync();
    }

    return { ...entry };
  }

  /**
   * Returns count of all currently active/authorized agents.
   */
  getActiveAgentCount(): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.status === "authorized" || e.status === "active" || e.status === "suspended") {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns count of active child delegations for a specific parent.
   */
  getActiveChildCount(parentDelegationId: DelegationId | null): number {
    let count = 0;
    for (const e of this.entries.values()) {
      if (e.parentDelegationId === parentDelegationId) {
        if (e.status === "authorized" || e.status === "active" || e.status === "suspended") {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Returns all entries.
   */
  all(): DelegationRegistryEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  /**
   * Atomically persists registry to disk with cross-process locking, fsync and Windows-safe rename.
   * Remediates: AUDIT-P1-06 (Cross-process locking).
   */
  persistSync(targetPath?: string): void {
    const outPath = targetPath ?? this.storagePath;
    if (!outPath) {
      throw new DelegationRegistryError("No storagePath provided for persistSync");
    }

    const dir = dirname(outPath);
    mkdirSync(dir, { recursive: true });

    let lock: LockHandle | null = null;
    try {
      lock = acquireLock(dir, "delegation-registry", { pid: process.pid, host: "registry-sync" });
    } catch (err: any) {
      if (err instanceof LockError) throw err;
      // non-lock errors proceed
    }

    try {
      const payload = JSON.stringify(Array.from(this.entries.values()), null, 2);
      const tmp = `${outPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, payload, null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      let renamed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          renameSync(tmp, outPath);
          renamed = true;
          break;
        } catch (err: any) {
          if (attempt < 4 && (err.code === "EPERM" || err.code === "EBUSY")) {
            const waitMs = (attempt + 1) * 20;
            const end = Date.now() + waitMs;
            while (Date.now() < end) {
              // synchronous backoff
            }
            continue;
          }
          throw err;
        }
      }

      if (!renamed) {
        throw new DelegationRegistryError(`Failed to atomically rename ${tmp} to ${outPath}`);
      }
    } finally {
      lock?.release();
    }
  }

  /**
   * Recovers / loads delegation registry from disk.
   */
  static loadAndRecover(filePath: string): DelegationRegistry {
    const registry = new DelegationRegistry(filePath);
    if (!existsSync(filePath)) {
      return registry;
    }

    const content = readFileSync(filePath, "utf8");
    if (!content.trim()) {
      return registry;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new DelegationRegistryError(
        `Failed to parse delegation registry JSON from ${filePath}: ${String(err)}`,
      );
    }

    const items = z.array(DelegationRegistryEntrySchema).parse(raw);
    for (const item of items) {
      registry.entries.set(item.delegationId, item);
      registry.childMissionIndex.set(item.childMissionId, item.delegationId);
    }

    return registry;
  }

  /**
   * Reconstructs DelegationRegistry from canonical Ledger records.
   * Remediates: AUDIT-P1-07 (Journal is single source of truth).
   */
  static rebuildFromLedger(ledger: Ledger, storagePath?: string): DelegationRegistry {
    const projection = MultiAgentProjection.rebuildFromLedger(ledger);
    return DelegationRegistry.fromProjection(projection, storagePath);
  }

  /**
   * Constructs DelegationRegistry from a MultiAgentProjection.
   */
  static fromProjection(projection: MultiAgentProjection, storagePath?: string): DelegationRegistry {
    const registry = new DelegationRegistry(storagePath);
    for (const entry of projection.allDelegations()) {
      registry.entries.set(entry.delegationId, entry);
      registry.childMissionIndex.set(entry.childMissionId, entry.delegationId);
    }
    if (storagePath) {
      registry.persistSync();
    }
    return registry;
  }
}
