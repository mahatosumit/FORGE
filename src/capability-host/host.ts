// FORGE capability host — KERNEL primitive #6, the ONLY effect executor.
// Pipeline per EXECUTION.md: schema → gate (verdict required) → dispatch
// record BEFORE effect → capability run → runtime-authored observation.
// INV-3: nothing outside this module + environments touches effect seams.

import type { CapabilityImpl, DispatchContext, CapabilityRunResult } from "./types.js";
import type { CapabilityManifest } from "../contracts/grants.js";
import type { Grant, Proposal } from "../contracts/index.js";
import type { ForgeRecord } from "../contracts/records.js";
import type { GateVerdict } from "../gate/gate.js";
import { computeImplementationHash } from "../contracts/capabilities.js";

export class VerdictMismatchError extends Error {
  constructor(detail: string) {
    super(`capability host refused dispatch: ${detail}`);
    this.name = "VerdictMismatchError";
  }
}

import type { CapabilityRegistry } from "../capabilities/registry.js";

export interface HostOptions {
  /** Capability implementations keyed by canonical id (built-ins + packs). */
  capabilities: Map<string, CapabilityImpl>;
  /** Optional capability registry for identity validation and disablement status. */
  registry?: CapabilityRegistry;
  /** Optional active grant checker for revocation windows. */
  isGrantActive?: (grantId: string) => boolean;
  /** Runtime-assigned per-capability timeouts (C-3: never model-supplied). */
  timeoutFor: (manifest: CapabilityManifest) => number;
  /** Where observations/dispatch records are appended (the mission ledger). */
  append: (input: {
    kind: ForgeRecord["kind"];
    author: ForgeRecord["author"];
    body: unknown;
    refs?: string[];
  }) => ForgeRecord;
  /** Environment selection: the dispatch context decides local vs container. */
  environment: (envKind: "local" | "container") => DispatchContext["environment"];
  /** Observation refs that the dispatched proposal refers to (for records). */
  now?: () => string;
}

interface InFlight {
  proposalId: string;
}

export class CapabilityHost {
  private inFlight = new Map<string, InFlight>(); // exclusive-class serialization
  private activeSubprocesses = 0;

  constructor(private readonly opts: HostOptions) {}

  manifest(capability: string): CapabilityManifest {
    const impl = this.opts.capabilities.get(capability);
    if (!impl) throw new VerdictMismatchError(`unknown capability "${capability}"`);
    return impl.manifest;
  }

  /**
   * Execute a proposal that the Gate has already approved.
   * The verdict is bound to the proposal: capability and args must match —
   * the host never re-derives authority, and never executes without one.
   */
  async execute(
    proposal: Proposal,
    verdict: GateVerdict & { type: "allow" },
    proposalId: string,
    ctx: DispatchContext,
  ): Promise<ForgeRecord> {
    const impl = this.opts.capabilities.get(proposal.capability);
    if (!impl) throw new VerdictMismatchError(`unknown capability "${proposal.capability}"`);
    if (verdict.type !== "allow") {
      throw new VerdictMismatchError(`non-allow verdict cannot dispatch`);
    }
    if (!verdict.resolved || typeof verdict.resolved !== "object" || verdict.resolved.capability !== proposal.capability) {
      throw new VerdictMismatchError("verdict capability does not match proposal");
    }
    // Re-check the verdict's grant is still the one issued for this scope —
    // the gate produced it for THIS proposal's resolved constraints.
    if (verdict.grantId === "") throw new VerdictMismatchError("empty grant id");

    // Resource limit: maxSubprocesses bound
    const isProcessSpawn = impl.manifestV2?.sideEffects.includes("process_spawn") ?? false;
    const maxSubprocesses = impl.manifestV2?.resourceLimits?.maxSubprocesses;
    if (isProcessSpawn && maxSubprocesses !== undefined && this.activeSubprocesses >= maxSubprocesses) {
      throw new VerdictMismatchError(`resource limit exceeded: maxSubprocesses (${maxSubprocesses}) reached`);
    }

    // Phase 6 - Window 3: Atomic Pre-Dispatch verification
    const isGrantActiveFn = ctx.isGrantActive ?? this.opts.isGrantActive;
    if (isGrantActiveFn && !isGrantActiveFn(verdict.grantId)) {
      throw new VerdictMismatchError(`grant "${verdict.grantId}" was revoked prior to dispatch (REVOKED_PRE_DISPATCH)`);
    }

    const regEntry = this.opts.registry?.get(proposal.capability);
    const expectedImplHash = ctx.pinnedIdentity?.implementationHash ?? regEntry?.identity.implementationHash;

    if (this.opts.registry) {
      const status = this.opts.registry.getStatus(proposal.capability);
      if (status === "disabled" || status === "quarantined") {
        throw new VerdictMismatchError(`capability "${proposal.capability}" is ${status} in registry (REVOKED_PRE_DISPATCH)`);
      }
      if (ctx.pinnedIdentity) {
        const idCheck = this.opts.registry.validateIdentity(ctx.pinnedIdentity);
        if (!idCheck.valid) {
          this.opts.append({
            kind: "observation.interrupted",
            author: "runtime",
            body: {
              proposalId,
              phase: "pre-dispatch-quarantine",
              note: `capability identity check failed: ${idCheck.reason}`,
              pinnedIdentity: ctx.pinnedIdentity,
            },
            refs: [proposalId],
          });
          throw new VerdictMismatchError(`capability identity check failed: ${idCheck.reason}`);
        }
      }
    }

    // F-01: Verify executable implementation identity. If substituted, quarantine and record evidence in ledger.
    if (expectedImplHash) {
      const actualImplHash = computeImplementationHash(impl);
      if (actualImplHash !== expectedImplHash) {
        if (this.opts.registry) {
          this.opts.registry.setStatus(proposal.capability, "quarantined", "executable implementation substitution detected");
        }
        this.opts.append({
          kind: "observation.interrupted",
          author: "runtime",
          body: {
            proposalId,
            phase: "pre-effect",
            note: `capability identity substitution detected: expected ${expectedImplHash}, got ${actualImplHash}`,
            capabilityId: ctx.pinnedIdentity?.capabilityId ?? proposal.capability,
            version: ctx.pinnedIdentity?.version ?? regEntry?.manifest.version ?? "1.0.0",
            manifestHash: ctx.pinnedIdentity?.manifestHash ?? regEntry?.identity.manifestHash,
            expectedImplementationHash: expectedImplHash,
            observedImplementationHash: actualImplHash,
            grantId: verdict.grantId,
            ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
            ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          },
          refs: [proposalId],
        });
        throw new VerdictMismatchError(
          `capability identity substitution detected: expected ${expectedImplHash}, got ${actualImplHash}`,
        );
      }
    }

    const manifest = impl.manifest;
    const timeoutMs = this.opts.timeoutFor(manifest);
    const envKind = ctx.environmentKind ?? "local";

    // EXCLUSIVE serialization: wait while another exclusive dispatch runs.
    if (manifest.concurrency === "exclusive") {
      while (this.inFlight.size > 0) await new Promise((r) => setTimeout(r, 25));
    }
    const inFlight: InFlight = { proposalId };
    this.inFlight.set(proposalId, inFlight);
    if (isProcessSpawn) {
      this.activeSubprocesses++;
    }

    try {
      // Phase 6 - Window 4: Pre-Execution cancellation check
      if (ctx.signal.aborted) {
        throw new VerdictMismatchError("execution aborted prior to effect run");
      }
      if (isGrantActiveFn && !isGrantActiveFn(verdict.grantId)) {
        throw new VerdictMismatchError(`grant "${verdict.grantId}" revoked during pre-exec`);
      }

      const capabilityId = ctx.pinnedIdentity?.capabilityId ?? proposal.capability;
      const version = ctx.pinnedIdentity?.version ?? regEntry?.manifest.version ?? (manifest as any).version ?? "1.0.0";
      const manifestHash = ctx.pinnedIdentity?.manifestHash ?? regEntry?.identity.manifestHash ?? (manifest as any).manifestHash ?? ("0".repeat(64) as any);
      const implementationHash = ctx.pinnedIdentity?.implementationHash ?? regEntry?.identity.implementationHash ?? (impl as any).implementationHash ?? ("0".repeat(64) as any);

      // Step 7A: Invariant INV-15: Isolation is authoritative
      // Model proposal cannot select environment via args to escape sandboxing.
      const effectiveIsolationProfile = verdict.isolationProfile ?? ctx.isolationProfile ?? "sandboxed";
      const executionCtx: DispatchContext = {
        ...ctx,
        isolationProfile: effectiveIsolationProfile,
      };

      // ADR-006: the dispatch record is written BEFORE the effect executes.
      // It is the crash boundary; recovery classifies from its presence.
      this.opts.append({
        kind: "proposal.dispatched",
        author: "runtime",
        body: {
          proposalId,
          grantId: verdict.grantId,
          capabilityId,
          version,
          manifestHash,
          implementationHash,
          environment: envKind,
          isolationProfile: effectiveIsolationProfile,
          timeoutMs,
          ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        },
        refs: [proposalId],
      });

      // Phase 6 - Window 5: Active execution (cancellation signal is passed)
      const env = this.opts.environment(envKind);
      let result: CapabilityRunResult;
      try {
        result = await impl.run(proposal, executionCtx, { timeoutMs, signal: ctx.signal, isolationProfile: effectiveIsolationProfile });
      } catch (err) {
        if (ctx.signal.aborted) {
          return this.opts.append({
            kind: "observation.interrupted",
            author: "runtime",
            body: {
              proposalId,
              phase: "post-effect-unknown",
              note: "execution aborted by revocation signal (EFFECT_UNKNOWN)",
            },
            refs: [proposalId],
          });
        }
        throw err;
      }

      if (ctx.signal.aborted) {
        return this.opts.append({
          kind: "observation.interrupted",
          author: "runtime",
          body: {
            proposalId,
            phase: "post-effect-unknown",
            note: "execution aborted by revocation signal (EFFECT_UNKNOWN)",
          },
          refs: [proposalId],
        });
      }

      // Phase 6 - Window 6: Post-Execution Pre-Commit check
      if (isGrantActiveFn && !isGrantActiveFn(verdict.grantId)) {
        this.opts.append({
          kind: "observation.interrupted",
          author: "runtime",
          body: {
            proposalId,
            phase: "post-effect-unknown",
            note: `grant "${verdict.grantId}" was revoked prior to ledger observation commit (REVOKED_PRE_COMMIT)`,
          },
          refs: [proposalId],
        });
        throw new VerdictMismatchError(
          `capability host refused commit: grant "${verdict.grantId}" was revoked prior to ledger observation commit (REVOKED_PRE_COMMIT)`,
        );
      }

      // runtime-authored observation (INV-1) — never model-supplied
      return this.opts.append({
        kind: result.observationKind,
        author: "runtime",
        body: result.observation,
        refs: [proposalId],
      });
    } finally {
      if (isProcessSpawn) {
        this.activeSubprocesses = Math.max(0, this.activeSubprocesses - 1);
      }
      this.inFlight.delete(proposalId);
    }
  }
}
