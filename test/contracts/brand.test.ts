// brand.test.ts — ID domains: valid accepted, malformed rejected, domains
// runtime-distinguishable via prefixes, serialization preserves the domain.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MissionIdSchema,
  RecordIdSchema,
  GrantIdSchema,
  StageIdSchema,
  CriterionIdSchema,
  Sha256HexSchema,
  Iso8601Schema,
  SeqSchema,
  ulidBody,
  RecordSchema,
} from "../../src/contracts/index.js";
import { makeRecord, MISSION, RECORD_ID_1 } from "../helpers/fixtures.js";

const BODY = "01HZZ" + "0".repeat(21);
const VALID_MIS = `mis_${BODY}`;
const VALID_REC = `rec_${BODY}`;
const VALID_GRT = `grt_${BODY}`;

test("valid prefixed ids are accepted and branded", () => {
  assert.equal(MissionIdSchema.parse(VALID_MIS), VALID_MIS);
  assert.equal(RecordIdSchema.parse(VALID_REC), VALID_REC);
  // round-trip through the brand keeps the string form (canonical JSON needs
  // plain strings; the domain lives in the prefix).
  const enc = JSON.stringify(MissionIdSchema.parse(VALID_MIS));
  assert.equal(JSON.parse(enc), VALID_MIS);
});

test("malformed ids rejected per domain", () => {
  const bad = [
    "",
    "01HZZ000000000000000000000", // missing prefix
    "mis_01HZZ00000000000000000000", // 25 chars
    "mis_01HZZ0000000000000000000000", // 27 chars
    "mis_01HZZ00000000000000000000I", // I not in Crockford alphabet
    "mis_01HZZ00000000000000000000L", // L not in alphabet
    "mis_01HZZ00000000000000000000O", // O not in alphabet
    "mis_01HZZ00000000000000000000U", // U not in alphabet
    "mis_01hzz00000000000000000000a", // lowercase not allowed (strict Crockford upper)
    "rec_01HZZ000000000000000000000", // wrong domain prefix for MissionId
  ];
  for (const b of bad) assert.throws(() => MissionIdSchema.parse(b), undefined, `MissionId must reject "${b}"`);
});

test("wrong ID domains cannot silently substitute (runtime prefixes)", () => {
  // A RecordId is NOT a MissionId, a GrantId is NOT a CriterionId, etc.
  assert.throws(() => MissionIdSchema.parse(VALID_REC));
  assert.throws(() => RecordIdSchema.parse(VALID_MIS));
  assert.throws(() => GrantIdSchema.parse(VALID_MIS));
  assert.throws(() => StageIdSchema.parse(VALID_MIS));
  assert.throws(() => CriterionIdSchema.parse(VALID_MIS));
  assert.throws(() => GrantIdSchema.parse(VALID_REC));
});

test("id generation produces valid, unique domain bodies", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const body = ulidBody();
    assert.match(body, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(!seen.has(body));
    seen.add(body);
  }
});

test("missionId inside records must be a MissionId, not a RecordId", () => {
  const rec = makeRecord("claim.asserted") as Record<string, unknown>;
  rec.missionId = RECORD_ID_1; // rec_ prefix in a mis_ field
  assert.throws(() => RecordSchema.parse(rec));
  rec.missionId = MISSION;
  assert.doesNotThrow(() => RecordSchema.parse(rec));
});

test("hash / timestamp / seq scalars", () => {
  assert.doesNotThrow(() => Sha256HexSchema.parse("a".repeat(64)));
  assert.throws(() => Sha256HexSchema.parse("A".repeat(64))); // uppercase rejected
  assert.throws(() => Sha256HexSchema.parse("a".repeat(63)));
  assert.doesNotThrow(() => Iso8601Schema.parse("2026-10-04T12:00:00Z"));
  assert.doesNotThrow(() => Iso8601Schema.parse("2026-10-04T12:00:00.123Z"));
  assert.throws(() => Iso8601Schema.parse("2026-10-04T12:00:00+02:00")); // not UTC-Z form
  assert.throws(() => Iso8601Schema.parse("not-a-date"));
  assert.doesNotThrow(() => SeqSchema.parse(1));
  assert.throws(() => SeqSchema.parse(0));
  assert.throws(() => SeqSchema.parse(1.5));
  assert.throws(() => SeqSchema.parse(Number.MAX_SAFE_INTEGER + 1));
});
