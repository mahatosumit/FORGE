// AUDIT PROBE (F-04 re-run): truncation of a journal with projections/anchor
// must now be detected. Two scenarios:
//   A) closed journal truncated after mission.closed → closure anchor detects
//   B) open journal truncated → projections seq tripwire detects
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMission } from "../src/ledger/index.js";
import { JournalCorruptionError } from "../src/ledger/ledger.js";

// Scenario A: closed mission, truncate the tail
{
  const dir = mkdtempSync(join(tmpdir(), "audit-truncA-"));
  const store = openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000000" });
  store.append({ kind: "mission.opened", author: "runtime", ts: new Date().toISOString(), body: { intent: "x", goalSpec: { summary: "x", proposedCriteria: [] } } });
  store.append({ kind: "mission.closed", author: "runtime", ts: new Date().toISOString(), body: { closure: "verified", receipt: { closure: "verified", weakestTier: "none", criteria: [], authorityManifest: [], changeManifest: [], costs: { tokensIn: 0, tokensOut: 0, wallClockMs: 0 }, chainTip: store.ledger.current()!.hash } } });
  store.close();
  const journalPath = join(dir, "missions", "mis_01HZZ000000000000000000000", "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  writeFileSync(journalPath, lines.slice(0, 1).join("\n") + "\n"); // remove the closure record
  try {
    openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000000" });
    console.log("A: TRUNCATION ACCEPTED (BAD)");
  } catch (e) {
    console.log("A: truncation DETECTED:", (e as Error).name);
  }
  rmSync(dir, { recursive: true, force: true });
}

// Scenario B: open mission, truncate under the projections tripwire
{
  const dir = mkdtempSync(join(tmpdir(), "audit-truncB-"));
  const store = openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000001" });
  for (let i = 0; i < 4; i++) {
    store.append({ kind: "mission.directive", author: "user", ts: new Date().toISOString(), body: { delivery: "steer", content: `d${i}` } });
  }
  store.close();
  const journalPath = join(dir, "missions", "mis_01HZZ000000000000000000001", "journal.jsonl");
  const lines = readFileSync(journalPath, "utf8").trim().split("\n");
  writeFileSync(journalPath, lines.slice(0, 2).join("\n") + "\n"); // drop 2 records
  try {
    openMission({ dataDir: dir, missionId: "mis_01HZZ000000000000000000001" });
    console.log("B: TRUNCATION ACCEPTED (BAD)");
  } catch (e) {
    console.log("B: truncation DETECTED:", (e as Error).name);
  }
  rmSync(dir, { recursive: true, force: true });
}
