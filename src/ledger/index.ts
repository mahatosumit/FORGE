// FORGE ledger — mission-level facade over Ledger + Projections.
// The engine talks to this; the journal underneath is the only truth.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, JournalCorruptionError, LockError, AuthorshipViolation, UnsupportedSchemaVersionError, missionPaths, type MissionPaths } from "./ledger.js";
import { Projections } from "./projections.js";
import { decodeRecord } from "../codec/hashChain.js";
import type { AppendInput } from "../codec/hashChain.js";
import type { ForgeRecord } from "../contracts/records.js";
type AppendArgs = Omit<AppendInput, "missionId">;

export { Ledger, JournalCorruptionError, LockError, AuthorshipViolation, UnsupportedSchemaVersionError, missionPaths };
export type { MissionPaths };

export interface MissionStoreOptions {
  dataDir: string;
  missionId: string;
  writer?: { pid: number; host: string };
  repairTornTail?: boolean;
}

/** Opens (or creates) a mission's ledger + projections with the write lock held. */
export function openMission(opts: MissionStoreOptions): MissionStore {
  return new MissionStore(opts);
}

/** Mission-level facade: every append is durably journaled first, then the
 *  (rebuildable) projections are synced. The journal is the truth; if this
 *  process dies between the two, openMission rebuilds projections. */
export class MissionStore {
  readonly ledger: Ledger;
  readonly projections: Projections;

  constructor(opts: MissionStoreOptions) {
    const writer = opts.writer ?? { pid: process.pid, host: "localhost" };
    const paths = missionPaths(opts.dataDir, opts.missionId);
    mkdirSync(paths.dir, { recursive: true });
    this.ledger = new Ledger({ dataDir: opts.dataDir, missionId: opts.missionId, writer, repairTornTail: opts.repairTornTail });
    this.projections = new Projections(paths.projections);
    // F-04 tripwire: a projection that remembers MORE records than the journal
    // holds means the journal was truncated (the projection is a cache, but a
    // mismatch in this direction is never legitimate — deletes go through
    // destroyProjections, which clears the file).
    const anchored = this.projections.anchoredSeq();
    if (anchored !== null && anchored > this.ledger.lastSeq()) {
      this.ledger.close();
      this.projections.close();
      throw new JournalCorruptionError({
        ok: false, at: this.ledger.lastSeq() + 1,
        reason: "seq-gap",
        detail: `journal has ${this.ledger.lastSeq()} records but projections anchor ${anchored} — truncation detected (F-04)`,
      });
    }
    if (!this.projections.consistentWith(this.ledger)) this.projections.rebuild(this.ledger);
  }

  append(input: AppendArgs): ForgeRecord {
    const rec = this.ledger.append(input); // durable first
    this.projections.recordAppended(this.ledger, rec); // then cache
    return rec;
  }

  read(): readonly ForgeRecord[] {
    return this.ledger.read();
  }

  find(id: string): ForgeRecord | undefined {
    return this.ledger.find(id);
  }

  close(): void {
    this.ledger.close();
    this.projections.close();
  }
}

/** Lock-free read-only mission view. Safe on append-only journals (ADR-002):
 *  used by API reads while a mission executes under the write lock. */
export function openMissionReadOnly(dataDir: string, missionId: string): {
  read(): ForgeRecord[];
  find(id: string): ForgeRecord | undefined;
  status(): { status: string; closure: string | null; goal_summary: string } | undefined;
} {
  const journalPath = join(dataDir, "missions", missionId, "journal.jsonl");
  const records: ForgeRecord[] = [];
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim())) {
      const d = decodeRecord(line);
      if (d.ok) records.push(d.record);
    }
  }
  const statusRec = records.find((r) => r.kind === "mission.closed");
  const opened = records.find((r) => r.kind === "mission.opened");
  const goal = opened ? (opened.body as { goalSpec: { summary: string } }).goalSpec.summary : "";
  return {
    read: () => records,
    find: (id) => records.find((r) => r.id === id),
    status: () => statusRec
      ? { status: "closed", closure: (statusRec.body as { closure: string }).closure, goal_summary: goal }
      : { status: records.some((r) => r.kind === "plan.confirmed") ? "executing" : "open", closure: null, goal_summary: goal },
  };
}

/** Destroy projections — always safe (INV-13 test support). */
export function destroyProjections(dataDir: string, missionId: string): void {
  const paths = missionPaths(dataDir, missionId);
  Projections.destroy(paths.projections);
}

export function missionExists(dataDir: string, missionId: string): boolean {
  return existsSync(join(dataDir, "missions", missionId, "journal.jsonl"));
}

export function listMissions(dataDir: string): string[] {
  const dir = join(dataDir, "missions");
  if (!existsSync(dir)) return [];
  return require_listDir(dir);
}

// small local helper to avoid importing fs twice awkwardly
import { readdirSync, statSync } from "node:fs";
function require_listDir(dir: string): string[] {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
}
