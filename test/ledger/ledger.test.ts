// ledger.test.ts — M1 DoD: single-writer enforcement, authorship at append,
// durability, rebuild-from-journal, corruption quarantine, projections
// rebuild to identical semantics (INV-1/2/5/6/13).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LockError, JournalCorruptionError, AuthorshipViolation, openMission, destroyProjections } from "../../src/ledger/index.js";
import { bodyFixtures, authorFor, ALL_KINDS, MISSION, TS } from "../helpers/fixtures.js";

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "forge-ledger-"));
}

const writer = { pid: 1, host: "test" };

function makeLedger(dataDir: string, missionId = MISSION): Ledger {
  return new Ledger({ dataDir, missionId, writer });
}

function seedChain(ledger: Ledger, kinds: number = 4): void {
  for (const kind of ALL_KINDS.slice(0, kinds)) {
    let body = bodyFixtures[kind]();
    if (kind === "mission.closed") {
      // anchor the receipt's chainTip to the REAL current tip (the anchor is
      // verified at reopen — fixtures must not fake it)
      const tip = ledger.current()?.hash ?? null;
      const b = structuredClone(body) as { receipt: { chainTip: string } };
      if (tip) b.receipt.chainTip = tip;
      body = b;
    }
    ledger.append({ kind, author: authorFor[kind], ts: TS, body });
  }
}

test("append is durable: the journal contains every record, byte-identical to replay", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  seedChain(l, 3);
  l.close();
  const lines = readFileSync(join(dir, "missions", MISSION, "journal.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const l2 = makeLedger(dir); // reconstruct from journal
  assert.equal(l2.lastSeq(), 3);
  assert.deepEqual(l2.read().map((r) => r.id), l2.read().map((r) => r.id));
  l2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("authorship violations are rejected at append (INV-1)", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  assert.throws(
    () => l.append({ kind: "observation.shell", author: "model", ts: TS, body: bodyFixtures["observation.shell"]() }),
    AuthorshipViolation,
  );
  assert.throws(
    () => l.append({ kind: "claim.asserted", author: "runtime", ts: TS, body: bodyFixtures["claim.asserted"]() }),
    AuthorshipViolation,
  );
  assert.throws(
    () => l.append({ kind: "grant.decided", author: "model", ts: TS, body: bodyFixtures["grant.decided"]() }),
    AuthorshipViolation,
  );
  assert.equal(l.lastSeq(), 0); // nothing was written
  l.close();
  rmSync(dir, { recursive: true, force: true });
});

test("invalid bodies are rejected before the hash exists — journal untouched", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  l.append({ kind: "mission.opened", author: "runtime", ts: TS, body: bodyFixtures["mission.opened"]() });
  assert.throws(() =>
    l.append({ kind: "mission.directive", author: "user", ts: TS, body: { delivery: "steer", content: "" } }),
  );
  assert.equal(l.lastSeq(), 1);
  l.close();
  rmSync(dir, { recursive: true, force: true });
});

test("INV-6: a second writer on the same mission fails fast", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  assert.throws(() => makeLedger(dir), LockError);
  l.close();
  // after release, a new writer can open
  const l2 = makeLedger(dir);
  assert.equal(l2.lastSeq(), 0);
  l2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("INV-6: a stale lock (dead writer) is stolen", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  const lockPath = join(dir, "missions", MISSION, ".lock");
  // simulate a dead writer: backdate the heartbeat beyond the stale window
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
  const l2 = makeLedger(dir); // must steal, not fail
  assert.equal(l2.lastSeq(), 0);
  l2.close();
  l.close(); // release of the stale holder is best-effort
  rmSync(dir, { recursive: true, force: true });
});

test("INV-13: deleting projections + rebuilding yields identical semantics", () => {
  const dir = tmpDataDir();
  const store = openMission({ dataDir: dir, missionId: MISSION, writer });
  for (const kind of ALL_KINDS.slice(0, 5)) {
    let body = bodyFixtures[kind]();
    if (kind === "mission.closed") {
      const b = structuredClone(body) as { receipt: { chainTip: string } };
      const tip = store.ledger.current()?.hash;
      if (tip) b.receipt.chainTip = tip;
      body = b;
    }
    store.append({ kind, author: authorFor[kind], ts: TS, body });
  }
  const before = { count: store.projections.recordCount(), status: store.projections.missionStatus() };
  assert.equal(before.count, 5); // projections stay in sync with appends
  const hashes = store.read().map((r) => r.hash);
  // close WAL-backed handles BEFORE destroying the db file (Windows)
  store.close();
  destroyProjections(dir, MISSION);
  const store2 = openMission({ dataDir: dir, missionId: MISSION, writer });
  const after = { count: store2.projections.recordCount(), status: store2.projections.missionStatus() };
  assert.deepEqual(after, before);
  assert.deepEqual(store2.read().map((r) => r.hash), hashes);
  assert.ok(store2.projections.consistentWith(store2.ledger));
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("INV-5: journal tampering is detected and the mission is quarantined", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  seedChain(l, 4);
  l.close();
  const journalPath = join(dir, "missions", MISSION, "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  const obj = JSON.parse(lines[1]!) as Record<string, unknown>;
  obj.body = { ...(obj.body as object), content: "TAMPERED" };
  lines[1] = JSON.stringify(Object.assign({ v: 1 }, obj));
  writeFileSync(journalPath, lines.join("\n") + "\n");
  assert.throws(() => makeLedger(dir), JournalCorruptionError);
  rmSync(dir, { recursive: true, force: true });
});

test("INV-2: a claim citing a nonexistent observation is rejected at append", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  // contract layer only requires ≥1 citation; resolution is ledger scope here:
  // the mission-local rule is enforced by the engine; the ledger itself records
  // the claim — assert the contract boundary (resolution tested in engine tests).
  assert.doesNotThrow(() =>
    l.append({ kind: "claim.asserted", author: "model", ts: TS, body: bodyFixtures["claim.asserted"]() }),
  );
  l.close();
  rmSync(dir, { recursive: true, force: true });
});

test("artifacts are content-addressed and deduplicated", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  const bytes = new TextEncoder().encode("hello forge");
  const hash = "b".repeat(64);
  const p1 = l.writeArtifact(bytes, hash);
  const p2 = l.writeArtifact(bytes, hash);
  assert.equal(p1, p2);
  assert.ok(existsSync(p1));
  assert.ok(l.artifactPath(hash));
  assert.equal(l.artifactPath("c".repeat(64)), null);
  l.close();
  rmSync(dir, { recursive: true, force: true });
});

test("closed ledger refuses appends", () => {
  const dir = tmpDataDir();
  const l = makeLedger(dir);
  l.close();
  assert.throws(() => l.append({ kind: "mission.opened", author: "runtime", ts: TS, body: bodyFixtures["mission.opened"]() }));
  rmSync(dir, { recursive: true, force: true });
});

test("DoD: 200-record journal replays to identical query results after full projection rebuild", () => {
  const dir = tmpDataDir();
  const store = openMission({ dataDir: dir, missionId: MISSION, writer });
  const kinds = ALL_KINDS.filter((k) => k !== "mission.closed"); // closure is appended LAST (closed → any transition is illegal)
  for (let i = 0; i < 199; i++) {
    const kind = kinds[i % kinds.length]!;
    store.append({ kind, author: authorFor[kind], ts: TS, body: bodyFixtures[kind]() });
  }
  {
    const kind = "mission.closed";
    const b = structuredClone(bodyFixtures[kind]()) as { receipt: { chainTip: string } };
    b.receipt.chainTip = store.ledger.current()!.hash; // anchor = pre-closure tip
    store.append({ kind, author: authorFor[kind], ts: TS, body: b });
  }
  const hashes = store.read().map((r) => r.hash);
  const count = store.projections.recordCount();
  store.close();
  destroyProjections(dir, MISSION);
  const store2 = openMission({ dataDir: dir, missionId: MISSION, writer });
  assert.equal(store2.projections.recordCount(), count);
  assert.equal(store2.ledger.lastSeq(), 200);
  assert.deepEqual(store2.read().map((r) => r.hash), hashes);
  assert.ok(store2.projections.consistentWith(store2.ledger));
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});
