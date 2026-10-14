// FORGE Host Supervisor (Step 8 Phase 2B.2: Host Supervisor, 2B.7: Revocation, 2B.8: Crash Boundaries)
// Central trusted daemon orchestrating child mission materialization, jail compilation,
// process lifecycle tracking, bounded termination, and crash boundary enforcement.

import type { DelegationId, MissionId, AgentId, Iso8601, Sha256Hex } from "../contracts/index.js";
import type { Proposal } from "../contracts/proposals.js";
import type { GateCallerContext } from "../gate/gate.js";
import type { ContainerDriver } from "../environments/execution/types.js";
import { DelegationRegistry, DelegationNotFoundError } from "./registry.js";
import { MultiAgentProjection } from "./projection.js";
import { BudgetEscrowManager } from "./budget-escrow.js";
import { ChildMissionMaterializer } from "./materializer.js";
import { AuthorityJailCompiler } from "./jail-compiler.js";
import { ProcessJail } from "./process-jail.js";
import { ChildRuntimeHost } from "./child-host.js";
import type { Ledger } from "../ledger/ledger.js";

export interface SupervisorOptions {
  dataDir: string;
  registry: DelegationRegistry;
  projection: MultiAgentProjection;
  budgetManager: BudgetEscrowManager;
  parentLedger: Ledger;
  containerDriver?: ContainerDriver;
  availableSecrets?: Record<string, string>;
  intentHash?: Sha256Hex;
}

export class MultiAgentSupervisor {
  private readonly activeChildren = new Map<DelegationId, ChildRuntimeHost>();

  constructor(private readonly opts: SupervisorOptions) {}

  /**
   * Activates a child mission:
   * 1. Validates delegation authorization & lineage.
   * 2. Materializes isolated child mission tree (Step 2B.1).
   * 3. Compiles EffectiveAuthorityEnvelope to physical jail config (Step 2B.3).
   * 4. Binds process jail and child host (Step 2B.4 & 2B.6).
   * 5. Appends delegation.activated to parent journal.
   */
  async activateChild(delegationId: DelegationId): Promise<ChildRuntimeHost> {
    const entry = this.opts.registry.getDelegation(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    const lineage = this.opts.projection.isLineageActive(delegationId);
    if (!lineage.ok) {
      throw new Error(`Cannot activate delegation "${delegationId}": lineage inactive (${lineage.reason})`);
    }

    // Materialize child mission (Step 2B.1)
    const materialized = ChildMissionMaterializer.materialize(
      this.opts.dataDir,
      entry.parentMissionId,
      entry.childMissionId,
      delegationId,
      entry.effectiveAuthorityHash,
      entry.effectiveEnvelope,
      this.opts.intentHash,
    );

    // Compile physical jail configuration (Step 2B.3)
    const parentMissionDir = `${this.opts.dataDir}/${entry.parentMissionId}`;
    const jailConfig = AuthorityJailCompiler.compile(
      entry.effectiveEnvelope,
      entry.childMissionId,
      materialized.childWorkspaceDir,
      {
        parentMissionDir,
        availableSecrets: this.opts.availableSecrets,
      },
    );

    // Instantiate process jail (Step 2B.4)
    const jail = new ProcessJail(jailConfig, this.opts.containerDriver);

    // Instantiate child runtime host (Step 2B.6)
    const childHost = new ChildRuntimeHost({
      childMissionId: entry.childMissionId,
      childAgentId: entry.childAgentId,
      delegationId,
      incarnationEpoch: entry.childIncarnationEpoch,
      envelope: entry.effectiveEnvelope,
      childWorkspaceRoot: materialized.childWorkspaceDir,
      childArtifactsRoot: materialized.childArtifactsDir,
      childLedger: materialized.childLedger,
      jail,
    });

    // Update status in registry & memory
    this.opts.registry.updateStatus(delegationId, "active");
    this.activeChildren.set(delegationId, childHost);

    // Activate budget escrow if in ESCROWED state
    const escrow = this.opts.budgetManager.getEscrow(delegationId);
    if (escrow && escrow.state === "ESCROWED") {
      this.opts.budgetManager.activateEscrow(delegationId);
    }

    // Append delegation.activated to parent ledger
    this.opts.parentLedger.append({
      kind: "delegation.activated",
      author: "runtime",
      ts: new Date().toISOString() as Iso8601,
      body: {
        delegationId,
        childMissionId: entry.childMissionId,
        childAgentId: entry.childAgentId,
        childIncarnationEpoch: entry.childIncarnationEpoch,
        containerId: null,
        hostPid: process.pid,
      },
    });

    return childHost;
  }

  /**
   * Retrieves active child host.
   */
  getChildHost(delegationId: DelegationId): ChildRuntimeHost | undefined {
    return this.activeChildren.get(delegationId);
  }

  /**
   * Dispatches proposal through child runtime host.
   */
  async executeChildProposal(
    delegationId: DelegationId,
    proposal: Proposal,
    caller?: GateCallerContext,
  ) {
    const childHost = this.activeChildren.get(delegationId);
    if (!childHost) {
      throw new Error(`Child delegation "${delegationId}" is not currently active`);
    }

    const res = await childHost.dispatch(proposal, caller);

    // Record capability spend if executed
    if (res.ok) {
      this.opts.budgetManager.recordSpend(delegationId, {
        capabilityCalls: 1,
      });
    }

    return res;
  }

  /**
   * Revocation & Bounded Termination (Step 2B.7):
   * 1. Updates registry status to "revoked".
   * 2. Appends delegation.revoked to parent journal.
   * 3. Executes bounded process-tree termination.
   * 4. Marks budget escrow UNCERTAIN if revoked abruptly (Step 2B.8).
   */
  async revokeChild(
    delegationId: DelegationId,
    reason: string,
    revokedBy: "parent" | "operator" | "cascade" = "operator",
  ): Promise<void> {
    const entry = this.opts.registry.getDelegation(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    const hostPid = entry.hostPid;
    const containerId = entry.containerId;

    // Update registry
    this.opts.registry.revokeDelegation(delegationId, reason);

    // Append delegation.revoked to parent ledger
    const nowIso = new Date().toISOString() as Iso8601;
    this.opts.parentLedger.append({
      kind: "delegation.revoked",
      author: "runtime",
      ts: nowIso,
      body: {
        delegationId,
        parentDelegationId: entry.parentDelegationId,
        childMissionId: entry.childMissionId,
        revokedAt: nowIso,
        reason,
        revokedBy,
      },
    });

    // Physically terminate process tree (Step 2B.7)
    await ProcessJail.killProcessTree(hostPid, containerId);

    // Abrupt termination without verified receipt -> mark UNCERTAIN (Step 2B.8)
    this.opts.budgetManager.handleCrashOrAbruptTermination(delegationId);

    // Remove from active map
    this.activeChildren.delete(delegationId);
  }

  /**
   * Crash Boundary Enforcement (Step 2B.8):
   * Marks child as crashed and freezes budget spend as UNCERTAIN.
   */
  async handleChildCrash(
    delegationId: DelegationId,
    exitCode: number,
    errorDetail: string,
  ): Promise<void> {
    const entry = this.opts.registry.getDelegation(delegationId);
    if (!entry) throw new DelegationNotFoundError(delegationId);

    // Update status to crashed
    this.opts.registry.updateStatus(delegationId, "crashed");

    // Mark budget escrow UNCERTAIN (cannot be refunded directly)
    this.opts.budgetManager.handleCrashOrAbruptTermination(delegationId);

    // Record crash revocation in parent ledger
    const nowIso = new Date().toISOString() as Iso8601;
    this.opts.parentLedger.append({
      kind: "delegation.revoked",
      author: "runtime",
      ts: nowIso,
      body: {
        delegationId,
        parentDelegationId: entry.parentDelegationId,
        childMissionId: entry.childMissionId,
        revokedAt: nowIso,
        reason: `Process crashed with exit code ${exitCode}: ${errorDetail}`,
        revokedBy: "operator" as const,
      },
    });

    this.activeChildren.delete(delegationId);
  }
}
