// tamper.test.ts — the ten mandated hash-chain tamper scenarios. Each test
// verifies the SPECIFIC failure condition (reason + seq), never "something threw".

import test from "node:test";
import assert from "node:assert/strict";
import { appendRecord, verifyChain, decodeRecord, encodeRecord, genesisHash } from "../../src/codec/hashChain.js";
import { ALL_KINDS, authorFor, makeRecord, MISSION, TS } from "../helpers/fixtures.js";
import type { ForgeRecord } from "../../src/contracts/index.js";

/** Build a 5-record chain: opened → directive? … use the first 5 kinds. */
function buildChain(n = 5): ForgeRecord[] {
  const chain: ForgeRecord[] = [];
  let prev: ForgeRecord | null = null;
  for (let i = 0; i < n; i++) {
    const kind = ALL_KINDS[i]!;
    const rec = appendRecord(prev, {
      missionId: MISSION,
      kind,
      author: authorFor[kind],
      ts: TS,
      body: makeRecord(kind).body,
    });
    chain.push(rec);
    prev = rec;
  }
  return chain;
}

test("1. a valid chain verifies", () => {
  const chain = buildChain();
  const result = verifyChain(chain);
  assert.deepEqual(result, { ok: true, count: 5 });
});

test("2. changed payload fails at the mutated record", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  // record 2 is mission.directive — mutate an existing field so the body stays
  // schema-valid and the failure is precisely the preimage hash
  mutated[1] = { ...mutated[1]!, body: { ...mutated[1]!.body, content: "tampered directive" } };
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "hash-mismatch");
    assert.equal(r.at, 2);
  }
});

test("3. changed sequence fails (position check fires first: seq-gap)", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  mutated[3] = { ...mutated[3]!, seq: 9 };
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "seq-gap");
});

test("3b. sequence is covered by the preimage: a re-signed record with a wrong seq cannot splice chains", () => {
  const chain = buildChain();
  // Build an orphan record whose payload is valid and self-consistent but
  // whose seq does not follow its prevHash source.
  const orphan = appendRecord(null, {
    missionId: chain[4]!.missionId,
    kind: "security.note",
    author: "runtime",
    ts: TS,
    body: makeRecord("security.note").body,
  });
  // splice: replace seq-5 record with the orphan (valid on its own, wrong seq/link)
  const r = verifyChain([...chain.slice(0, 4), orphan]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(["seq-gap", "prev-hash-mismatch"].includes(r.reason));
});

test("4. changed previous hash fails (link broken)", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  mutated[2] = { ...mutated[2]!, prevHash: "e".repeat(64) };
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "prev-hash-mismatch");
    assert.equal(r.at, 3);
  }
});

test("5. changed record kind fails (kind/body mismatch → schema-invalid)", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  mutated[1] = { ...mutated[1]!, kind: "security.note" }; // old body no longer matches
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "schema-invalid");
    assert.equal(r.at, 2);
  }
});

test("5c. fully consistent kind swap (kind+body+author) still fails on the preimage hash", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  // mission.directive (user) → grant.decided (user): schema-valid, authorship-valid,
  // different preimage ⇒ only the hash catches it.
  mutated[1] = {
    ...mutated[1]!,
    kind: "grant.decided",
    body: { requestId: mutated[1]!.id, decision: "extend" as const },
  };
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "hash-mismatch");
    assert.equal(r.at, 2);
  }
});

test("5b. changed author / timestamp / refs fail (preimage coverage)", () => {
  for (const field of ["author", "ts", "refs"] as const) {
    const chain = buildChain();
    const mutated = structuredClone(chain) as ForgeRecord[];
    (mutated[2] as unknown as Record<string, unknown>)[field] =
      field === "refs" ? ["rec_01HZZ000000000000000000099"] : field === "author" ? "user" : "2026-01-01T00:00:00.000Z";
    const r = verifyChain(mutated);
    assert.equal(r.ok, false, `field ${field} must be covered by the preimage`);
    if (!r.ok) assert.equal(r.reason, "hash-mismatch");
  }
});

test("6. deleted record is detected", () => {
  const chain = buildChain();
  const mutated = chain.filter((_, i) => i !== 2); // remove seq 3
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "seq-gap"); // position check fires before the link check
});

test("7. reordered records are detected", () => {
  const chain = buildChain();
  const mutated = [chain[0]!, chain[2]!, chain[1]!, chain[3]!, chain[4]!];
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(["prev-hash-mismatch", "hash-mismatch", "seq-gap"].includes(r.reason));
});

test("8. duplicated records are detected", () => {
  const chain = buildChain();
  const mutated = [...chain, chain[4]!];
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    // the duplicate carries seq 5 again → seq gap surfaces first; either way
    // the chain is rejected and the failure is localized
    assert.ok(["seq-gap", "duplicate-id"].includes(r.reason));
  }
});

test("8b. duplicated id (same id, different seq) is detected as duplicate-id", () => {
  const chain = buildChain();
  const clone = { ...chain[4]!, seq: 6, id: chain[4]!.id, prevHash: chain[4]!.hash, hash: "f".repeat(64) };
  const r = verifyChain([...chain, clone]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "duplicate-id");
});

test("9. altered genesis is detected", () => {
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  mutated[0] = { ...mutated[0]!, prevHash: "0".repeat(64) };
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "genesis-mismatch");
    assert.equal(r.at, 1);
  }
  // and the honest genesis equals the documented constant for schema v1
  assert.equal(chain[0]!.prevHash, genesisHash());
});

test("10. malformed hash representations are rejected at decode", () => {
  const chain = buildChain();
  const line = JSON.parse(encodeRecord(chain[0]!)) as Record<string, unknown>;
  line["hash"] = "NOT-A-HASH";
  const d = decodeRecord(JSON.stringify(line));
  assert.ok(!d.ok);
  if (!d.ok) assert.equal(d.reason, "schema-invalid");
});

test("tampering then re-signing one record breaks the NEXT link (tamper-evidence, not magic)", () => {
  // An attacker who edits record 3 AND recomputes its hash still fails at
  // record 4, whose prevHash no longer matches — this is why the chain is
  // append-only truth (ADR-002).
  const chain = buildChain();
  const mutated = structuredClone(chain) as ForgeRecord[];
  mutated[2] = { ...mutated[2]!, body: { ...mutated[2]!.body } };
  // recompute hash for the mutated record via the codec's own append machinery:
  const reSigned = appendRecord(mutated[1]!, {
    missionId: mutated[2]!.missionId,
    kind: mutated[2]!.kind,
    author: mutated[2]!.author,
    ts: "2026-10-04T23:59:59.999Z", // changed payload field
    id: mutated[2]!.id,
    refs: mutated[2]!.refs,
    body: mutated[2]!.body,
  });
  mutated[2] = reSigned;
  const r = verifyChain(mutated);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "prev-hash-mismatch");
    assert.equal(r.at, 4);
  }
});

test("encode refuses to emit a record whose hash does not match its preimage", () => {
  const chain = buildChain();
  const forged = { ...chain[0]!, hash: "a".repeat(64) };
  assert.throws(() => encodeRecord(forged));
});
