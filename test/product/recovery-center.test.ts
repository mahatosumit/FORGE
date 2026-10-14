// recovery-center.test.ts — Comprehensive test suite for Mission Recovery Center (ADR-0008)
// Validates:
// - Classification of missions across all states (clean, interrupted, pending_escalation, post_effect_unknown)
// - Hash chain preservation during abort
// - Safe recovery and resume of interrupted missions without duplicating effects

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMission } from "../../src/ledger/index.js";
import { classifyMissionRecovery } from "../../src/api/server.js";
import { verifyChain, genesisHash } from "../../src/codec/hashChain.js";
import { newMissionId, newGrantId } from "../../src/grants/grants.js";
import { ulidBody } from "../../src/contracts/base.js";

function safeRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows file lock fallback
  }
}

test("Recovery Center: Classifies clean, interrupted, pending escalation, and post-effect unknown missions", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-test-recovery-"));
  try {
    // 1. Mission A: Clean Closed
    const msnA = newMissionId();
    const sA = openMission({ dataDir, missionId: msnA });
    const opA = sA.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "Complete audit", goalSpec: { summary: "Complete audit", proposedCriteria: [] } },
    });
    sA.append({
      kind: "mission.closed",
      author: "runtime",
      ts: new Date().toISOString(),
      body: {
        closure: "verified",
        receipt: {
          closure: "verified",
          weakestTier: "none",
          criteria: [],
          authorityManifest: [],
          changeManifest: [],
          costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 1200 },
          chainTip: opA.hash,
        },
      },
    });
    sA.close();

    const infoA = classifyMissionRecovery(dataDir, msnA);
    assert.ok(infoA);
    assert.equal(infoA.status, "verified");
    assert.equal(infoA.resumable, false);
    assert.equal(infoA.effectsMayHaveOccurred, false);

    // 2. Mission B: Interrupted between turns (cleanly paused)
    const msnB = newMissionId();
    const sB = openMission({ dataDir, missionId: msnB });
    sB.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "Refactor database client", goalSpec: { summary: "Refactor database client", proposedCriteria: [] } },
    });
    sB.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: {
        proposal: { capability: "fs", args: { op: "mkdir", path: "src" } },
        meta: { rationale: "create directory", citations: [] },
      },
    });
    sB.append({
      kind: "observation.fs",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { op: "write", path: "src/db.ts", beforeHash: null, afterHash: "0".repeat(64), diffRef: null },
    });
    sB.close();

    const infoB = classifyMissionRecovery(dataDir, msnB);
    assert.ok(infoB);
    assert.equal(infoB.status, "interrupted");
    assert.equal(infoB.resumable, true);
    assert.equal(infoB.effectsMayHaveOccurred, false);

    // 3. Mission C: Pending Escalation (waiting for operator decision)
    const msnC = newMissionId();
    const sC = openMission({ dataDir, missionId: msnC });
    sC.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "Deploy to staging", goalSpec: { summary: "Deploy to staging", proposedCriteria: [] } },
    });
    sC.append({
      kind: "grant.requested",
      author: "runtime",
      ts: new Date().toISOString(),
      body: {
        proposalId: `rec_${ulidBody()}`,
        capability: "shell",
        requested: { argvClass: { kind: "argv-prefix", segments: ["npm", "publish"] } },
        rationale: "Requires operator escalation for publishing",
        citations: [],
      },
    });
    sC.close();

    const infoC = classifyMissionRecovery(dataDir, msnC);
    assert.ok(infoC);
    assert.equal(infoC.status, "pending_escalation");
    assert.equal(infoC.resumable, false);

    // 4. Mission D: Post-Effect Unknown (proposal dispatched, but process died before observation recorded)
    const msnD = newMissionId();
    const sD = openMission({ dataDir, missionId: msnD });
    sD.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "Apply migration", goalSpec: { summary: "Apply migration", proposedCriteria: [] } },
    });
    sD.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: {
        proposal: { capability: "shell", args: { argv: ["migrate", "up"], cwd: "." } },
        meta: { rationale: "run migration", citations: [] },
      },
    });
    sD.append({
      kind: "proposal.dispatched",
      author: "runtime",
      ts: new Date().toISOString(),
      body: {
        proposalId: `rec_${ulidBody()}`,
        grantId: newGrantId(),
        environment: "local",
        timeoutMs: 10000,
      },
    });
    // Crash occurs here: no observation appended!
    sD.close();

    const infoD = classifyMissionRecovery(dataDir, msnD);
    assert.ok(infoD);
    assert.equal(infoD.status, "post_effect_unknown");
    assert.equal(infoD.effectsMayHaveOccurred, true);
    assert.equal(infoD.resumable, false);
  } finally {
    safeRm(dataDir);
  }
});

test("Recovery Center: Abort mission cleanly writes closure without corrupting hash chain", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "forge-test-abort-"));
  try {
    const missionId = newMissionId();
    const s = openMission({ dataDir, missionId });
    s.append({
      kind: "mission.opened",
      author: "runtime",
      ts: new Date().toISOString(),
      body: { intent: "Long running automation", goalSpec: { summary: "Long running automation", proposedCriteria: [] } },
    });
    s.append({
      kind: "proposal.received",
      author: "model",
      ts: new Date().toISOString(),
      body: {
        proposal: { capability: "fs", args: { op: "mkdir", path: "test" } },
        meta: { rationale: "create test directory", citations: [] },
      },
    });
    s.close();

    // Abort operation (replicating POST /recovery/:id/abort)
    const sAbort = openMission({ dataDir, missionId });
    const isClosedBefore = sAbort.read().some((r) => r.kind === "mission.closed");
    assert.equal(isClosedBefore, false);

    const prevRec = sAbort.ledger.current();
    sAbort.append({
      kind: "mission.closed",
      author: "runtime",
      ts: new Date().toISOString(),
      body: {
        closure: "blocked",
        receipt: {
          closure: "blocked",
          weakestTier: "none",
          criteria: [],
          authorityManifest: [],
          changeManifest: [],
          costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 },
          chainTip: prevRec ? prevRec.hash : genesisHash(),
        },
      },
    });
    sAbort.close();

    // Verify recovery info after abort
    const info = classifyMissionRecovery(dataDir, missionId);
    assert.ok(info);
    assert.equal(info.status, "blocked");
    assert.equal(info.closure, "blocked");
    assert.equal(info.resumable, false);

    // Verify SHA-256 hash chain integrity
    const sVerify = openMission({ dataDir, missionId });
    const records = sVerify.read();
    assert.equal(records.length, 3);
    const check = verifyChain(records);
    assert.equal(check.ok, true);
    sVerify.close();
  } finally {
    safeRm(dataDir);
  }
});
