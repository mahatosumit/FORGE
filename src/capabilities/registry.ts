// FORGE Capability Registry (Step 6 Phase 3).
// Centralized, strongly typed, immutable registry for capabilities.
// Cardinal Invariant: Registration NEVER grants authority.
// Zero authority semantics; zero grants inside the registry.

import {
  type CapabilityIdentity,
  type CapabilityManifestV2,
  type CapabilityStatus,
  type CapabilityRiskTier,
  type CapabilityIdempotency,
  CapabilityManifestV2Schema,
  computeManifestHash,
  computeImplementationHash,
} from "../contracts/capabilities.js";
import type { CapabilityImpl, DispatchContext, CapabilityRunResult } from "../capability-host/types.js";
import type { Proposal } from "../contracts/proposals.js";

export class TamperedImplementationError extends Error {
  constructor(public readonly capabilityId: string, public readonly detail: string) {
    super(`tampered capability implementation for "${capabilityId}": ${detail}`);
    this.name = "TamperedImplementationError";
  }
}

export class ManifestTamperingError extends Error {
  constructor(public readonly capabilityId: string, public readonly detail: string) {
    super(`tampered capability manifest for "${capabilityId}": ${detail}`);
    this.name = "ManifestTamperingError";
  }
}

export class UnknownCapabilityError extends Error {
  constructor(public readonly capabilityId: string, public readonly version?: string) {
    super(`unknown capability "${capabilityId}"${version ? `@${version}` : ""}`);
    this.name = "UnknownCapabilityError";
  }
}

export interface CapabilityImplV2 {
  readonly manifest: CapabilityManifestV2;
  run(
    proposal: Proposal,
    ctx: DispatchContext,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<CapabilityRunResult>;
  readonly artifactBytes?: Uint8Array;
  readonly artifactPath?: string;
  readonly code?: string;
  readonly implementationHash?: string;
}

export interface CapabilityDescriptor {
  readonly identity: CapabilityIdentity;
  readonly manifest: CapabilityManifestV2;
  readonly impl: CapabilityImplV2;
  readonly status: CapabilityStatus;
}

export interface ModelCard {
  readonly capability: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly requiredConstraints: readonly string[];
  readonly riskTier: CapabilityRiskTier;
  readonly idempotency: CapabilityIdempotency;
  readonly provenance: string;
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === "object" || typeof val === "function") && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj as Readonly<T>;
}

export class CapabilityRegistry {
  private readonly entries = new Map<
    string,
    {
      identity: CapabilityIdentity;
      manifest: CapabilityManifestV2;
      impl: CapabilityImplV2;
      status: CapabilityStatus;
    }
  >();

  private readonly versionsByCapability = new Map<string, string[]>();
  private readonly globalStatusOverrides = new Map<string, { status: CapabilityStatus; reason?: string }>();

  /**
   * Register a capability manifest and its implementation binding.
   * Immutable: registration cannot be overwritten in-place.
   * Confers ZERO execution authority.
   */
  register(
    rawManifest: CapabilityManifestV2,
    impl: CapabilityImplV2,
    options?: {
      implementationSource?: string | Uint8Array;
      expectedIdentity?: CapabilityIdentity;
    },
  ): CapabilityIdentity {
    const manifest = CapabilityManifestV2Schema.parse(rawManifest);
    const key = `${manifest.id}@${manifest.version}`;

    if (this.entries.has(key)) {
      throw new Error(`Capability "${key}" is already registered (in-place modification forbidden)`);
    }

    const manifestHash = computeManifestHash(manifest);
    const implementationHash = computeImplementationHash(options?.implementationSource ?? impl);

    if (options?.expectedIdentity) {
      if (options.expectedIdentity.manifestHash !== manifestHash) {
        throw new ManifestTamperingError(
          manifest.id,
          `manifest hash mismatch (expected ${options.expectedIdentity.manifestHash}, got ${manifestHash})`,
        );
      }
      if (options.expectedIdentity.implementationHash !== implementationHash) {
        throw new TamperedImplementationError(
          manifest.id,
          `implementation hash mismatch (expected ${options.expectedIdentity.implementationHash}, got ${implementationHash})`,
        );
      }
    }

    const identity: CapabilityIdentity = deepFreeze({
      capabilityId: manifest.id,
      version: manifest.version,
      manifestHash,
      implementationHash,
    });

    const frozenManifest: CapabilityManifestV2 = deepFreeze({ ...manifest });

    this.entries.set(key, {
      identity,
      manifest: frozenManifest,
      impl,
      status: manifest.status,
    });

    const versions = this.versionsByCapability.get(manifest.id) ?? [];
    if (!versions.includes(manifest.version)) {
      versions.push(manifest.version);
      // Sort SemVer descending
      versions.sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
        }
        return 0;
      });
      this.versionsByCapability.set(manifest.id, versions);
    }

    return identity;
  }

  /**
   * Resolve a capability by ID and optional version or semver range.
   */
  resolve(capabilityId: string, version?: string): CapabilityDescriptor {
    let targetVersion = version;
    if (!targetVersion) {
      const versions = this.versionsByCapability.get(capabilityId);
      if (!versions || versions.length === 0) {
        throw new UnknownCapabilityError(capabilityId);
      }
      targetVersion = versions[0]; // Highest version
    }

    const key = `${capabilityId}@${targetVersion}`;
    const entry = this.entries.get(key);
    if (!entry) {
      throw new UnknownCapabilityError(capabilityId, targetVersion);
    }

    const globalOverride = this.globalStatusOverrides.get(capabilityId);
    const effectiveStatus = globalOverride ? globalOverride.status : entry.status;

    return {
      identity: entry.identity,
      manifest: entry.manifest,
      impl: entry.impl,
      status: effectiveStatus,
    };
  }

  /** Get an exact version or throw. */
  get(capabilityId: string, exactVersion?: string): CapabilityDescriptor {
    return this.resolve(capabilityId, exactVersion);
  }

  /** Set global lifecycle status (e.g. disabled or quarantined). */
  setStatus(capabilityId: string, status: CapabilityStatus, reason?: string): void {
    this.globalStatusOverrides.set(capabilityId, { status, reason });
  }

  /** Get effective lifecycle status for a capability. */
  getStatus(capabilityId: string, version?: string): CapabilityStatus {
    const globalOverride = this.globalStatusOverrides.get(capabilityId);
    if (globalOverride) return globalOverride.status;
    try {
      const desc = this.resolve(capabilityId, version);
      return desc.status;
    } catch {
      return "disabled";
    }
  }

  /**
   * Mechanically validate identity integrity (CAP-006, CAP-018).
   * Verifies both manifestHash and implementationHash against registered code.
   */
  validateIdentity(identity: CapabilityIdentity): { valid: boolean; reason?: string } {
    const key = `${identity.capabilityId}@${identity.version}`;
    const entry = this.entries.get(key);
    if (!entry) {
      return { valid: false, reason: "unknown-capability" };
    }
    if (entry.identity.manifestHash !== identity.manifestHash) {
      return { valid: false, reason: "manifest-tampered" };
    }
    if (entry.identity.implementationHash !== identity.implementationHash) {
      this.setStatus(identity.capabilityId, "quarantined", "implementation hash mismatch");
      return { valid: false, reason: "tampered-implementation" };
    }

    // Dynamic verification of implementation code
    const currentImplHash = computeImplementationHash(entry.impl);
    if (currentImplHash !== identity.implementationHash) {
      // Quarantine immediately
      this.setStatus(identity.capabilityId, "quarantined", "dynamic implementation hash verification failed");
      return { valid: false, reason: "tampered-implementation" };
    }

    return { valid: true };
  }

  /** List all registered capability descriptors. */
  list(): readonly CapabilityDescriptor[] {
    return Array.from(this.entries.values()).map((entry) => {
      const globalOverride = this.globalStatusOverrides.get(entry.manifest.id);
      return {
        identity: entry.identity,
        manifest: entry.manifest,
        impl: entry.impl,
        status: globalOverride ? globalOverride.status : entry.status,
      };
    });
  }

  /**
   * Export passive discovery model cards.
   * Conveys schema and risk metadata as passive data without instruction authority.
   */
  exportModelCards(allowedCapabilityIds?: readonly string[]): readonly ModelCard[] {
    const allowed = allowedCapabilityIds ? new Set(allowedCapabilityIds) : null;
    const cards: ModelCard[] = [];

    for (const [id, versions] of this.versionsByCapability) {
      if (allowed && !allowed.has(id)) continue;
      const latestVersion = versions[0];
      if (!latestVersion) continue;

      const desc = this.resolve(id, latestVersion);
      if (desc.status === "disabled" || desc.status === "quarantined") continue;

      // Sanitize description: strip control characters, excessive whitespace, and instruction injection tags
      const sanitizedDescription = desc.manifest.description
        .replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
        .replace(/<\/?(?:system|instruction|prompt|command)[^>]*>/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 512);

      cards.push({
        capability: desc.manifest.id,
        version: desc.manifest.version,
        name: desc.manifest.name,
        description: sanitizedDescription,
        requiredConstraints: desc.manifest.constraintsVocab,
        riskTier: desc.manifest.riskTier,
        idempotency: desc.manifest.idempotency,
        provenance: desc.manifest.provenance.pack,
      });
    }

    return cards;
  }
}
