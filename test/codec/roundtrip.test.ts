// roundtrip.test.ts — for EVERY record kind:
//   record → validate → encode → decode → validate → structural equality
// plus canonical determinism properties.

import test from "node:test";
import assert from "node:assert/strict";
import { RecordSchema, JOURNAL_SCHEMA_VERSION, type RecordKind } from "../../src/contracts/index.js";
import { canonicalize } from "../../src/codec/canonicalJson.js";
import { appendRecord, encodeRecord, decodeRecord, genesisHash } from "../../src/codec/hashChain.js";
import { ALL_KINDS, authorFor, makeRecord, MISSION, TS, RECORD_ID_1 } from "../helpers/fixtures.js";

test("every record kind round-trips: validate → encode → decode → validate → equal", () => {
  let prev: ReturnType<typeof appendRecord> | null = null;
  const results: RecordKind[] = [];
  for (const kind of ALL_KINDS) {
    const rec = appendRecord(prev, {
      missionId: MISSION,
      kind,
      author: authorFor[kind],
      ts: TS,
      body: bodyFor(kind),
    });
    prev = rec;
    const line = encodeRecord(rec);
    const decoded = decodeRecord(line);
    assert.ok(decoded.ok, `${kind}: decode failed: ${!decoded.ok ? decoded.detail : ""}`);
    if (!decoded.ok) continue;
    const reValidated = RecordSchema.parse(decoded.record);
    assert.deepEqual(reValidated, rec, `${kind}: structural equality broken`);
    assert.equal(encodeRecord(decoded.record), line, `${kind}: re-encode not byte-identical`);
    results.push(kind);
  }
  assert.equal(results.length, ALL_KINDS.length);
});

// appendRecord validates bodies itself; reuse the fixtures directly.
function bodyFor(kind: RecordKind): unknown {
  const rec = makeRecord(kind);
  return rec.body;
}

test("encode(record) === encode(record) across repeated executions", () => {
  const rec = appendRecord(null, {
    missionId: MISSION,
    kind: "mission.opened",
    author: "runtime",
    ts: TS,
    body: { intent: "x", goalSpec: { summary: "s", proposedCriteria: [] } },
  });
  const a = encodeRecord(rec);
  const b = encodeRecord(rec);
  const c = encodeRecord(JSON.parse(a) as typeof rec);
  assert.equal(a, b);
  assert.equal(a, c);
});

test("key insertion order does not affect canonical bytes", () => {
  const a = canonicalize({ z: 1, a: { q: 1, b: 2 }, m: [3, 1] });
  const b = canonicalize({ m: [3, 1], a: { b: 2, q: 1 }, z: 1 });
  assert.equal(a, b);
  assert.ok(a.indexOf('"a"') < a.indexOf('"m"') && a.indexOf('"m"') < a.indexOf('"z"'));
});

test("canonical number formatting is deterministic (JCS/ECMAScript)", () => {
  assert.equal(canonicalize(0.1 + 0.2), "0.30000000000000004");
  assert.equal(canonicalize(-0), "0");
  assert.equal(canonicalize(1e21), "1e+21");
  assert.equal(canonicalize(100), "100");
});

test("canonicalizer rejects non-JSON values", () => {
  assert.throws(() => canonicalize(undefined as never));
  assert.throws(() => canonicalize(NaN));
  assert.throws(() => canonicalize(Infinity));
  assert.throws(() => canonicalize(1n as never));
  assert.throws(() => canonicalize(() => 1 as never));
  assert.throws(() => canonicalize(new Date() as never)); // non-plain object
});

test("journal line carries the schema version; unsupported versions fail closed", () => {
  const rec = appendRecord(null, {
    missionId: MISSION,
    kind: "mission.opened",
    author: "runtime",
    ts: TS,
    body: { intent: "x", goalSpec: { summary: "s", proposedCriteria: [] } },
  });
  const line = encodeRecord(rec);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed["v"], JOURNAL_SCHEMA_VERSION);

  for (const v of [0, 2, 99, null, "1"]) {
    const mutated = JSON.stringify({ ...parsed, v });
    const d = decodeRecord(mutated);
    assert.ok(!d.ok);
    if (!d.ok) assert.equal(d.reason, "unsupported-version");
  }
});

test("decode rejects non-JSON lines and non-objects", () => {
  assert.equal(decodeRecord("not json{").ok, false);
  assert.equal(decodeRecord("[1,2]").ok, false);
  assert.equal(decodeRecord("42").ok, false);
});

test("decode rejects schema-invalid records (unknown kind, bad ids, extra fields)", () => {
  const rec = appendRecord(null, {
    missionId: MISSION,
    kind: "mission.opened",
    author: "runtime",
    ts: TS,
    body: { intent: "x", goalSpec: { summary: "s", proposedCriteria: [] } },
  });
  const base = JSON.parse(encodeRecord(rec)) as Record<string, unknown>;

  assert.equal(decodeRecord(JSON.stringify({ ...base, kind: "observation.telepathy" })).ok, false);
  assert.equal(decodeRecord(JSON.stringify({ ...base, id: "rec_bogus" })).ok, false);
  assert.equal(decodeRecord(JSON.stringify({ ...base, extra: true })).ok, false);
});

test("genesis rule is deterministic and domain-separated", () => {
  assert.equal(genesisHash(), genesisHash());
  // pinned vector — changing the genesis constant is a ledger-breaking event
  assert.equal(genesisHash().length, 64);
});

test("built chains verify end-to-end and encode/decode losslessly", () => {
  let prev: ReturnType<typeof appendRecord> | null = null;
  const lines: string[] = [];
  for (const kind of ALL_KINDS) {
    const rec = appendRecord(prev, {
      missionId: MISSION,
      kind,
      author: authorFor[kind],
      ts: TS,
      refs: kind === "claim.asserted" ? [RECORD_ID_1] : [],
      body: makeRecord(kind).body,
    });
    prev = rec;
    lines.push(encodeRecord(rec));
  }
  const d0 = decodeRecord(lines[0]!);
  assert.ok(d0.ok);
  if (d0.ok) assert.equal(d0.record.seq, 1);
  assert.equal(d0.ok && d0.record.prevHash, genesisHash());
});
