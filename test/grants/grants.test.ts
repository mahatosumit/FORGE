// grants.test.ts — M2: grant lifecycle over the ledger, attenuation (INV-9),
// expiry + revocation (INV-8), active-set replay.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMission, type MissionStore } from "../../src/ledger/index.js";
import { GrantStore, constraintsSubsetOf } from "../../src/grants/grants.js";

function setup(): { dir: string; store: MissionStore; grants: GrantStore } {
  const dir = mkdtempSync(join(tmpdir(), "forge-grants-"));
  const store = openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000000" });
  return { dir, store, grants: new GrantStore(store) };
}

function teardown(dir: string, store?: MissionStore): void {
  store?.close(); // close WAL handles before removing the directory (Windows)
  rmSync(dir, { recursive: true, force: true });
}

const HOUR = 3_600_000;

test("issue → active → revoke lifecycle is ledger-proven", () => {
  const { dir, store, grants } = setup();
  const g = grants.issue({ capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "envelope" });
  assert.equal(grants.active().length, 1);
  grants.revoke(g.id, "scope change");
  assert.equal(grants.active().length, 0);
  assert.equal(grants.isRevoked(g.id), true);
  // the lifecycle is ledger-proven: reopen replays it
  store.close();
  const store2 = openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000000" });
  const grants2 = new GrantStore(store2);
  assert.equal(grants2.active().length, 0);
  assert.equal(grants2.isRevoked(g.id), true);
  store2.close();
  teardown(dir, store);
});

test("expired grants are filtered from the active set (INV-8)", () => {
  const { dir, store, grants } = setup();
  const past = new Date(Date.now() - HOUR).toISOString();
  const future = new Date(Date.now() + HOUR).toISOString();
  grants.issue({ capability: "fs", constraints: { paths: ["a/**"] }, expiresAt: past, issuer: "envelope" });
  const g2 = grants.issue({ capability: "fs", constraints: { paths: ["b/**"] }, expiresAt: future, issuer: "envelope" });
  const active = grants.active();
  assert.equal(active.length, 1);
  assert.equal(active[0]!.id, g2.id);
  teardown(dir, store);
});

test("INV-9: widening child grants are rejected at issue time", () => {
  const { dir, store, grants } = setup();
  const parent = grants.issue({
    capability: "fs", constraints: { paths: ["src/payments/**"] }, expiresAt: null, issuer: "envelope",
  });
  // same path scope is fine
  assert.doesNotThrow(() =>
    grants.issue({ capability: "fs", constraints: { paths: ["src/payments/**"] }, expiresAt: null, issuer: "escalation", parentGrantId: parent.id }),
  );
  // widening to src/** is not
  assert.throws(() =>
    grants.issue({ capability: "fs", constraints: { paths: ["src/**"] }, expiresAt: null, issuer: "escalation", parentGrantId: parent.id }),
    /INV-9/,
  );
  // adding a capability the parent lacks is not
  assert.throws(() =>
    grants.issue({ capability: "shell", constraints: { paths: ["src/payments/**"] }, expiresAt: null, issuer: "escalation", parentGrantId: parent.id }),
  );
  teardown(dir, store);
});

test("INV-9: child grant cannot outlive its parent", () => {
  const { dir, store, grants } = setup();
  const parent = grants.issue({
    capability: "fs", constraints: { paths: ["src/**"] },
    expiresAt: new Date(Date.now() + HOUR).toISOString(), issuer: "envelope",
  });
  assert.throws(() =>
    grants.issue({
      capability: "fs", constraints: { paths: ["src/**"] },
      expiresAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      issuer: "escalation", parentGrantId: parent.id,
    }),
    /INV-9/,
  );
  teardown(dir, store);
});

test("argv-class attenuation semantics", () => {
  // exact child under prefix parent: covered
  assert.equal(
    constraintsSubsetOf(
      { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } },
      { argvClass: { kind: "exact", argv: ["npm", "test", "--watch"] } },
    ),
    true,
  );
  // prefix child under exact parent: widening
  assert.equal(
    constraintsSubsetOf(
      { argvClass: { kind: "exact", argv: ["npm", "test"] } },
      { argvClass: { kind: "argv-prefix", segments: ["npm"] } },
    ),
    false,
  );
  // regex children require identical anchors (conservative)
  assert.equal(
    constraintsSubsetOf(
      { argvClass: { kind: "argv-regex", anchors: ["^npm$", null] } },
      { argvClass: { kind: "argv-regex", anchors: ["^npm$", "^test$"] } },
    ),
    false,
  );
  // identical anchors: covered
  assert.equal(
    constraintsSubsetOf(
      { argvClass: { kind: "argv-regex", anchors: ["^npm$", null] } },
      { argvClass: { kind: "argv-regex", anchors: ["^npm$", null] } },
    ),
    true,
  );
});
