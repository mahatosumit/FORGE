// FORGE grants — authority as typed, scoped, expiring objects (KERNEL
// primitive #2; ADR-003). The active set is a projection of grant.issued /
// grant.revoked records plus the wall clock (expiry). Grants are immutable:
// change = revoke + issue.

import { createHash } from "node:crypto";
import { GrantSchema, type Grant } from "../contracts/grants.js";
import {
  Iso8601Schema,
  MissionIdSchema,
  ulidBody,
  type Author,
  type Constraints,
  type GrantId,
  type MissionId,
} from "../contracts/base.js";
import { matchPath, literalPrefix } from "../gate/pathMatch.js";
import type { MissionStore } from "../ledger/index.js";
import type { ForgeRecord } from "../contracts/records.js";

export function newGrantId(): GrantId {
  return `grt_${ulidBody()}` as GrantId;
}

export function newMissionId(): MissionId {
  return `mis_${ulidBody()}` as MissionId;
}

// ---------------------------------------------------------------------------
// Attenuation (INV-9): a child grant must be a strict subset of its parent.
// ---------------------------------------------------------------------------

function argvClassCovers(parent: Constraints["argvClass"], child: NonNullable<Constraints["argvClass"]>): boolean {
  if (!parent) return false;
  if (child.kind === "exact" && parent.kind === "exact") {
    return parent.argv.length <= child.argv.length &&
      parent.argv.every((s, i) => child.argv[i] === s);
  }
  if (parent.kind === "argv-prefix" && child.kind === "argv-prefix") {
    return parent.segments.length <= child.segments.length &&
      parent.segments.every((s, i) => child.segments[i] === s);
  }
  if (parent.kind === "argv-prefix" && child.kind === "exact") {
    return parent.segments.every((s, i) => child.argv[i] === s);
  }
  if (parent.kind === "exact" && child.kind === "argv-prefix") return false; // widening
  // argv-regex children are only ever covered by an identical anchor list
  // (conservative: regex equivalence is undecidable, so never widen).
  if (parent.kind === "argv-regex" && child.kind === "argv-regex") {
    return JSON.stringify(parent.anchors) === JSON.stringify(child.anchors);
  }
  return false;
}

export function constraintsSubsetOf(parent: Constraints, child: Constraints): boolean {
  if (child.paths) {
    if (!parent.paths) return false;
    for (const p of child.paths) {
      const prefix = literalPrefix(p) || "";
      const covered = parent.paths.some((pp) => matchPath(prefix, pp));
      if (!covered) return false;
    }
  }
  if (child.hosts) {
    if (!parent.hosts) return false;
    for (const h of child.hosts) if (!parent.hosts.includes(h)) return false;
  }
  if (child.methods) {
    if (!parent.methods) return false;
    for (const m of child.methods) if (!parent.methods.includes(m)) return false;
  }
  if (child.secretNames) {
    if (!parent.secretNames) return false;
    for (const s of child.secretNames) if (!parent.secretNames.includes(s)) return false;
  }
  if (child.argvClass && !argvClassCovers(parent.argvClass, child.argvClass)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// GrantStore — lifecycle over the ledger.
// ---------------------------------------------------------------------------

export class GrantStore {
  constructor(private readonly store: MissionStore) {}

  private grantFromRecord(r: ForgeRecord): Grant | null {
    if (r.kind === "grant.issued") return GrantSchema.parse((r.body as { grant: unknown }).grant);
    return null;
  }

  /** Active (issued, not revoked, not expired) grants, in issue order. */
  active(now: Date = new Date()): Grant[] {
    const nowMs = now.getTime();
    const active = new Map<string, Grant>();
    for (const r of this.store.read()) {
      if (r.kind === "grant.issued") {
        const g = this.grantFromRecord(r);
        if (g) active.set(g.id, g);
      } else if (r.kind === "grant.revoked") {
        const id = (r.body as { grantId: string }).grantId;
        active.delete(id);
      }
    }
    return [...active.values()].filter(
      (g) => g.expiresAt === null || Date.parse(g.expiresAt) > nowMs,
    );
  }

  isRevoked(grantId: string): boolean {
    return this.store
      .read()
      .some((r) => r.kind === "grant.revoked" && (r.body as { grantId: string }).grantId === grantId);
  }

  /** Issue a grant. With parentGrantId: INV-9 subset validation against the
   *  parent grant (from the active set at the time of issuance). */
  issue(input: {
    capability: string;
    constraints: Constraints;
    expiresAt: string | null;
    issuer: Grant["issuer"];
    parentGrantId?: string | null;
  }): Grant {
    let parentGrantId = input.parentGrantId ?? null;
    if (parentGrantId) {
      const parent = this.active().find((g) => g.id === parentGrantId);
      if (!parent) throw new Error(`parent grant ${parentGrantId} is not active — cannot attenuate`);
      if (input.capability !== parent.capability) {
        throw new Error(`INV-9 violation: child grant capability "${input.capability}" exceeds parent "${parent.capability}"`);
      }
      if (!constraintsSubsetOf(parent.constraints, input.constraints)) {
        throw new Error(`INV-9 violation: child grant constraints widen parent ${parentGrantId}`);
      }
      if (parent.expiresAt !== null) {
        const childExp = input.expiresAt ? Date.parse(input.expiresAt) : Infinity;
        if (childExp > Date.parse(parent.expiresAt)) {
          throw new Error(`INV-9 violation: child grant outlives parent ${parentGrantId}`);
        }
      }
    }
    const grant: Grant = GrantSchema.parse({
      id: newGrantId(),
      missionId: MissionIdSchema.parse(this.store.ledger.missionId),
      capability: input.capability,
      constraints: input.constraints,
      expiresAt: input.expiresAt === null ? null : Iso8601Schema.parse(input.expiresAt),
      issuer: input.issuer,
      parentGrantId,
    });
    this.store.append({ kind: "grant.issued", author: "runtime", ts: new Date().toISOString(), body: { grant } });
    return grant;
  }

  revoke(grantId: string, reason: string, author: Author = "runtime"): void {
    this.store.append({ kind: "grant.revoked", author, ts: new Date().toISOString(), body: { grantId, reason } });
  }

  /** Deterministic grant id for a given capability+constraints+mission — used
   *  by the engine's quick lane so re-deriving the same envelope is stable. */
  static deterministicId(capability: string, constraints: Constraints, missionId: string): GrantId {
    const h = createHash("sha256")
      .update(`${missionId}|${capability}|${JSON.stringify(constraints)}`)
      .digest("hex")
      .slice(0, 26)
      .toUpperCase()
      .replace(/[^0-9A-HJKMNP-TV-Z]/g, "0");
    return `grt_${h}` as GrantId;
  }
}
