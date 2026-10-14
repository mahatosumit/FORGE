// FORGE ledger — projections (ADR-002): rebuildable SQLite caches. NEVER
// authoritative (INV-13): every projection row carries the journal seq it was
// built from; deleting the file is always safe.

import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import type { Ledger } from "./ledger.js";
import type { ForgeRecord } from "../contracts/records.js";
import type { MissionClosure } from "../contracts/receipt.js";

export class Projections {
  private db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL, kind TEXT NOT NULL,
        author TEXT NOT NULL, ts TEXT NOT NULL, refs TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS records_id ON records(id);
      CREATE TABLE IF NOT EXISTS mission_state (
        mission_id TEXT PRIMARY KEY, status TEXT NOT NULL,
        closure TEXT, goal_summary TEXT, updated_ts TEXT NOT NULL
      );
    `);
  }

  /** Rebuild from the journal — the only correct way to (re)populate. */
  rebuild(ledger: Ledger): void {
    this.db.exec("DELETE FROM records; DELETE FROM mission_state; DELETE FROM meta;");
    const insert = this.db.prepare(
      "INSERT INTO records (seq, id, kind, author, ts, refs) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of ledger.read()) {
      insert.run(r.seq, r.id, r.kind, r.author, r.ts, JSON.stringify(r.refs));
    }
    this.rebuildMissionState(ledger);
    const tip = ledger.current();
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('journal_seq', ?), ('chain_tip', ?)")
      .run(String(ledger.lastSeq()), tip ? tip.hash : "");
  }

  private rebuildMissionState(ledger: Ledger): void {    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO mission_state (mission_id, status, closure, goal_summary, updated_ts)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let status = "open";
    let closure: MissionClosure | null = null;
    let goalSummary = "";
    let updated = new Date().toISOString();
    for (const r of ledger.read()) {
      updated = r.ts;
      switch (r.kind) {
        case "mission.opened":
          status = "open";
          goalSummary = typeof (r.body as { goalSpec?: { summary?: string } }).goalSpec?.summary === "string"
            ? (r.body as { goalSpec: { summary: string } }).goalSpec.summary
            : "";
          break;
        case "plan.confirmed":
          status = "executing";
          break;
        case "mission.closed":
          status = "closed";
          closure = r.body.closure;
          break;
        default:
          break;
      }
    }
    upsert.run(ledger.missionId, status, closure, goalSummary, updated);
  }

  recordCount(): number {    return (this.db.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number }).n;
  }

  findById(id: string): { seq: number; kind: string } | undefined {
    return this.db.prepare("SELECT seq, kind FROM records WHERE id = ?").get(id) as
      | { seq: number; kind: string }
      | undefined;
  }

  byKind(kind: string): Array<{ seq: number; id: string; ts: string }> {
    return this.db
      .prepare("SELECT seq, id, ts FROM records WHERE kind = ? ORDER BY seq")
      .all(kind) as Array<{ seq: number; id: string; ts: string }>;
  }

  missionStatus(): { status: string; closure: string | null; goal_summary: string } | undefined {
    return this.db.prepare("SELECT status, closure, goal_summary FROM mission_state LIMIT 1").get() as
      | { status: string; closure: string | null; goal_summary: string }
      | undefined;
  }

  /** Incremental sync after a single append: insert the row and refresh the
   *  (cheap) mission-state projection. Cache maintenance only — the journal
   *  remains the truth. */
  recordAppended(ledger: Ledger, r: ForgeRecord): void {
    this.db
      .prepare("INSERT OR REPLACE INTO records (seq, id, kind, author, ts, refs) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.seq, r.id, r.kind, r.author, r.ts, JSON.stringify(r.refs));
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('journal_seq', ?), ('chain_tip', ?)")
      .run(String(ledger.lastSeq()), ledger.current()?.hash ?? "");
    this.rebuildMissionState(ledger);
  }

  /** The journal seq this projection was built from (null if empty). */
  anchoredSeq(): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'journal_seq'").get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  /** INV-13 check: projection agrees with the journal tip. */
  consistentWith(ledger: Ledger): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'journal_seq'").get() as
      | { value: string }
      | undefined;
    if (!row) return false;
    return Number(row.value) === ledger.lastSeq() && this.recordCount() === ledger.lastSeq();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  static destroy(dbPath: string): void {
    if (existsSync(dbPath)) rmSync(dbPath);
  }
}
