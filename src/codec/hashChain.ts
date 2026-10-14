// FORGE codec — the hash chain (ADR-002).
//
// HASH RULE (normative):
//   record.hash = SHA256( canonicalJson(preimage) )
//   preimage    = { v, id, missionId, seq, kind, author, ts, refs, body, prevHash }
//   (everything in the record except `hash` itself, plus the journal schema
//    version so records from incompatible ledger eras can never hash equal)
//
// GENESIS RULE (deterministic): for seq=1,
//   prevHash = SHA256( "forge:genesis:v" + JOURNAL_SCHEMA_VERSION )
// — a fixed domain-separated constant with no clock, RNG, or key material.
//
// The chain is the only integrity mechanism: any change to a record's payload,
// kind, author, timestamp, refs, seq, prevHash, or id changes its preimage and
// therefore its hash; verifyChain() localizes the first broken record.

import { createHash } from "node:crypto";
import {
  JOURNAL_SCHEMA_VERSION,
  RecordCoreSchema,
  RecordSchema,
  authorshipAllows,
  parseBody,
  type ForgeRecord,
  type RecordKind,
} from "../contracts/records.js";
import type { Author } from "../contracts/base.js";
import { canonicalize } from "./canonicalJson.js";
import { ulidBody } from "../contracts/base.js";

export function sha256Utf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function genesisHash(): string {
  return sha256Utf8(`forge:genesis:v${JOURNAL_SCHEMA_VERSION}`);
}

function preimage(r: Omit<ForgeRecord, "hash">): Record<string, unknown> {
  return {
    v: JOURNAL_SCHEMA_VERSION,
    id: r.id,
    missionId: r.missionId,
    seq: r.seq,
    kind: r.kind,
    author: r.author,
    ts: r.ts,
    refs: r.refs,
    body: r.body,
    prevHash: r.prevHash,
  };
}

export function computeRecordHash(r: Omit<ForgeRecord, "hash">): string {
  return sha256Utf8(canonicalize(preimage(r) as Parameters<typeof canonicalize>[0]));
}

// ---------------------------------------------------------------------------
// Append: the only way a record is born. Enforces C-2 (authorship matrix) and
// schema validity before the hash exists — an invalid record can never enter
// a chain.
// ---------------------------------------------------------------------------

export interface AppendInput {
  readonly missionId: string;
  readonly kind: RecordKind;
  readonly author: Author;
  readonly ts: string;
  readonly refs?: readonly string[];
  readonly id?: string;
  readonly body: unknown; // validated against the kind's schema here
}

export function appendRecord(
  previous: ForgeRecord | null,
  input: AppendInput,
): ForgeRecord {
  if (!authorshipAllows(input.kind, input.author)) {
    throw new Error(
      `authorship violation: kind "${input.kind}" may not be authored by "${input.author}" (C-2)`,
    );
  }
  const body = parseBody(input.kind, input.body);
  const expectedSeq = previous === null ? 1 : previous.seq + 1;
  // NOTE: the record itself excludes `v` (the journal envelope field); the
  // version enters the hash via the preimage and the line via encodeRecord.
  // Validation uses the core (hash-less) schema; the hash is computed after.
  const candidate = {
    id: input.id ?? nextId(input.kind),
    missionId: input.missionId,
    seq: expectedSeq,
    kind: input.kind,
    author: input.author,
    ts: input.ts,
    refs: [...(input.refs ?? [])],
    body,
    prevHash: previous === null ? genesisHash() : previous.hash,
  };
  const core = RecordCoreSchema.parse(candidate); // header fields validated here
  const withoutHash = { ...core, kind: input.kind, body } as unknown as Omit<ForgeRecord, "hash">;
  const hash = computeRecordHash(withoutHash);
  return { ...withoutHash, hash } as ForgeRecord;
}

/** Fresh record id. A record's own id is always in the RecordId domain
 *  ("rec_"); "grt_" ids identify grants as *body payloads* (grant.issued),
 *  never as record identities. The ledger (M1) owns minting policy. */
function nextId(_kind: RecordKind): string {
  return `rec_${ulidBody()}`;
}

// ---------------------------------------------------------------------------
// Encode / decode: canonical JSONL lines.
//
// Journal line format (ADR-002): one canonical JSON object per line,
//   { v, id, missionId, seq, kind, author, ts, refs, body, prevHash, hash }
// `v` is the journal schema version; decode fails closed on any other value.
// ---------------------------------------------------------------------------

export function encodeRecord(record: ForgeRecord & { v?: unknown }): string {
  // Accepts a bare record or a decoded journal line (which carries `v`).
  const { v, ...rest } = record as { v?: unknown } & ForgeRecord;
  if (v !== undefined && v !== JOURNAL_SCHEMA_VERSION) {
    throw new Error(`unsupported journal schema version ${String(v)}`);
  }
  const parsed = RecordSchema.parse(rest);
  if (!authorshipAllows(parsed.kind, parsed.author, parsed.body)) {
    throw new Error(`authorship violation: kind "${parsed.kind}" / author "${parsed.author}"`);
  }
  const expected = computeRecordHash(parsed);
  if (expected !== rest.hash) {
    throw new Error("refusing to encode: record hash does not match its preimage");
  }
  return canonicalize({ ...preimage(parsed), hash: parsed.hash } as Parameters<typeof canonicalize>[0]);
}

export type DecodeResult =
  | { ok: true; record: ForgeRecord }
  | { ok: false; reason: DecodeFailureReason; detail: string };

export type DecodeFailureReason =
  | "decode-error" // not JSON / not an object
  | "unsupported-version" // v ≠ JOURNAL_SCHEMA_VERSION — fails closed
  | "schema-invalid" // zod rejection (incl. malformed ids/hashes/timestamps, unknown kinds, extra fields)
  | "authorship-invalid"; // matrix violation

export function decodeRecord(line: string): DecodeResult {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch (e) {
    return { ok: false, reason: "decode-error", detail: `not JSON: ${(e as Error).message}` };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, reason: "decode-error", detail: "not an object" };
  }
  const v = (obj as { v?: unknown }).v;
  if (v !== JOURNAL_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      detail: `journal schema version ${String(v)} unsupported (expected ${JOURNAL_SCHEMA_VERSION})`,
    };
  }
  const { v: _v, ...rest } = obj as { v?: unknown; [k: string]: unknown };
  const parsed = RecordSchema.safeParse(rest);
  if (!parsed.success) {
    return { ok: false, reason: "schema-invalid", detail: parsed.error.message };
  }
  const rec = parsed.data as ForgeRecord;
  if (!authorshipAllows(rec.kind, rec.author, rec.body)) {
    return {
      ok: false,
      reason: "authorship-invalid",
      detail: `kind "${rec.kind}" may not be authored by "${rec.author}"`,
    };
  }
  return { ok: true, record: rec };
}

// ---------------------------------------------------------------------------
// Verify: the tamper detector.
// ---------------------------------------------------------------------------

export type VerifyFailureReason =
  | DecodeFailureReason
  | "genesis-mismatch"
  | "seq-gap"
  | "duplicate-id"
  | "prev-hash-mismatch"
  | "hash-mismatch";

export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; at: number; reason: VerifyFailureReason; detail: string };

export function verifyChain(records: readonly ForgeRecord[]): VerifyResult {
  const seenIds = new Set<string>();
  let prev: ForgeRecord | null = null;
  for (const rec of records) {
    // Structure-level checks first, then position, then integrity.
    if (!RecordSchema.safeParse(rec).success || !authorshipAllows(rec.kind, rec.author, rec.body)) {
      return { ok: false, at: rec.seq, reason: "schema-invalid", detail: "record failed schema or authorship re-validation" };
    }
    if (seenIds.has(rec.id)) {
      return { ok: false, at: rec.seq, reason: "duplicate-id", detail: rec.id };
    }
    seenIds.add(rec.id);
    if (rec.seq !== (prev === null ? 1 : prev.seq + 1)) {
      return { ok: false, at: rec.seq, reason: "seq-gap", detail: `expected ${prev === null ? 1 : prev.seq + 1}` };
    }
    const expectedPrev = prev === null ? genesisHash() : prev.hash;
    if (rec.prevHash !== expectedPrev) {
      return {
        ok: false,
        at: rec.seq,
        reason: prev === null ? "genesis-mismatch" : "prev-hash-mismatch",
        detail: `prevHash ${rec.prevHash} ≠ expected ${expectedPrev}`,
      };
    }
    const expected = computeRecordHash(rec);
    if (rec.hash !== expected) {
      return { ok: false, at: rec.seq, reason: "hash-mismatch", detail: `record hash ${rec.hash} ≠ computed ${expected}` };
    }
    prev = rec;
  }
  return { ok: true, count: records.length };
}

/** Convenience: verify raw journal lines (decode + verify). */
export function verifyChainLines(lines: readonly string[]): VerifyResult {
  const records: ForgeRecord[] = [];
  for (const line of lines) {
    const d = decodeRecord(line);
    if (!d.ok) return { ok: false, at: records.length + 1, reason: d.reason, detail: d.detail };
    records.push(d.record);
  }
  return verifyChain(records);
}
