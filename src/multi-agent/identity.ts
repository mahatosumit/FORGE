// FORGE Multi-Agent Identity & Incarnation Primitives (Step 8 Phase 1)
// Cryptographic identity tuple canonicalization, stable hashing, and monotonic epoch management.
// Core Invariant: Old agent incarnations cannot execute after newer epoch is authoritative.

import { createHash } from "node:crypto";
import { canonicalize, type JsonLike } from "../codec/canonicalJson.js";
import {
  type AgentIdentityTuple,
  AgentIdentityTupleSchema,
  type AgentId,
  type DelegationId,
  type IncarnationEpoch,
} from "../contracts/delegation.js";
import type { GrantId, MissionId, Sha256Hex } from "../contracts/base.js";

export class IncarnationEpochError extends Error {
  constructor(message: string) {
    super(`IncarnationEpochError: ${message}`);
    this.name = "IncarnationEpochError";
  }
}

/**
 * Validates whether a candidate incarnation epoch is valid against the authoritative epoch.
 * Rejects stale, rolled-back, or non-matching epochs.
 */
export function isEpochAuthoritative(authoritativeEpoch: number, candidateEpoch: number): boolean {
  if (!Number.isSafeInteger(candidateEpoch) || candidateEpoch < 1) return false;
  if (!Number.isSafeInteger(authoritativeEpoch) || authoritativeEpoch < 1) return false;
  return candidateEpoch === authoritativeEpoch;
}

/**
 * Computes the next valid incarnation epoch, guaranteeing strict monotonicity.
 * Fails closed if rollback or stagnation is attempted.
 */
export function nextIncarnationEpoch(currentEpoch: number): IncarnationEpoch {
  if (!Number.isSafeInteger(currentEpoch) || currentEpoch < 1) {
    throw new IncarnationEpochError(`Invalid current epoch: ${currentEpoch}`);
  }
  const next = currentEpoch + 1;
  if (!Number.isSafeInteger(next)) {
    throw new IncarnationEpochError("Incarnation epoch overflow");
  }
  return next as IncarnationEpoch;
}

/**
 * Creates and validates an immutable AgentIdentityTuple.
 */
export function createAgentIdentity(params: {
  agentId: AgentId;
  delegationId: DelegationId;
  missionId: MissionId;
  incarnationEpoch: IncarnationEpoch;
  grantId: GrantId;
  grantRevision: number;
}): AgentIdentityTuple {
  return AgentIdentityTupleSchema.parse(params);
}

/**
 * Generates the deterministic canonical JSON representation of an identity tuple.
 */
export function canonicalizeIdentity(identity: AgentIdentityTuple): string {
  const parsed = AgentIdentityTupleSchema.parse(identity);
  return canonicalize(parsed as unknown as JsonLike);
}

/**
 * Computes the stable SHA-256 identity digest for machine verification and ledger anchoring.
 */
export function hashIdentity(identity: AgentIdentityTuple): Sha256Hex {
  const canonical = canonicalizeIdentity(identity);
  return createHash("sha256").update(canonical).digest("hex") as Sha256Hex;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Creates a unique delegation ULID string with valid Crockford Base32 format.
 */
export function newDelegationId(): DelegationId {
  let id = "";
  for (let i = 0; i < 26; i++) {
    id += CROCKFORD_BASE32[Math.floor(Math.random() * 32)];
  }
  return `del_${id}` as DelegationId;
}
