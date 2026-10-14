// FORGE ledger — KERNEL primitive #1 (ADR-002).
//
// One authoritative artifact per mission: journal.jsonl — append-only,
// hash-chained, schema-versioned, single-writer. Projections are caches that
// can always be rebuilt (INV-13). There is no update or delete API.
//
// The append API enforces the authorship matrix (C-2 / INV-1 / INV-4) and
// validates the body against the kind's schema *before* the hash exists, so
// an invalid record can never enter a chain.

import {
  appendRecord,
  decodeRecord,
  encodeRecord,
  verifyChain,
  type AppendInput,
  type VerifyResult,
} from "../codec/hashChain.js";
import {
  AUTHORSHIP,
  JOURNAL_SCHEMA_VERSION,
  type ForgeRecord,
  type RecordKind,
} from "../contracts/records.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { acquireLock, LockError, type LockHandle } from "./lock.js";

export { LockError };

export class UnsupportedSchemaVersionError extends Error {
  constructor(seq: number, foundVersion: number, maxSupportedVersion: number) {
    super(`unsupported schema version ${foundVersion} at seq ${seq} (maximum supported is ${maxSupportedVersion})`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export class AuthorshipViolation extends Error {
  constructor(kind: RecordKind, author: string) {
    super(`authorship violation: kind "${kind}" may not be authored by "${author}" (C-2, INV-1)`);
    this.name = "AuthorshipViolation";
  }
}

export class JournalCorruptionError extends Error {
  constructor(public readonly verify: Extract<VerifyResult, { ok: false }>) {
    super(
      `journal corruption at seq ${verify.at}: ${verify.reason} — ${verify.detail} ` +
        `(mission quarantined read-only; INV-5)`,
    );
    this.name = "JournalCorruptionError";
  }
}

export function authorshipAllows(kind: RecordKind, author: ForgeRecord["author"]): boolean {
  return AUTHORSHIP[kind].includes(author);
}

export interface MissionPaths {
  dir: string;
  journal: string;
  artifacts: string;
  projections: string;
}

export function missionPaths(dataDir: string, missionId: string): MissionPaths {
  const dir = join(dataDir, "missions", missionId);
  return {
    dir,
    journal: join(dir, "journal.jsonl"),
    artifacts: join(dir, "artifacts"),
    projections: join(dir, "projections.db"),
  };
}

export interface LedgerOptions {
  dataDir: string;
  missionId: string;
  writer: { pid: number; host: string };
  repairTornTail?: boolean;
}

/**
 * The Ledger for one mission. Holds the chain in memory (rebuilt from the
 * journal at construction — the journal is the truth; memory is a cache).
 */
export class Ledger {
  readonly missionId: string;
  readonly paths: MissionPaths;
  private readonly opts: LedgerOptions;
  private chain: ForgeRecord[] = [];
  private lock: LockHandle;
  private open = true;

  constructor(opts: LedgerOptions) {
    this.opts = opts;
    this.missionId = opts.missionId;
    this.paths = missionPaths(opts.dataDir, opts.missionId);
    mkdirSync(this.paths.dir, { recursive: true });
    mkdirSync(this.paths.artifacts, { recursive: true });
    this.lock = acquireLock(this.paths.dir, opts.missionId, opts.writer);
    this.rebuildFromJournal();
  }

  /** Delete-safe: everything reconstructable from journal.jsonl (INV-13). */
  private rebuildFromJournal(): void {
    this.chain = [];
    if (!existsSync(this.paths.journal)) return;
    const raw = readFileSync(this.paths.journal, "utf8");
    const rawLines = raw.split("\n");
    while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim().length === 0) {
      rawLines.pop();
    }
    if (rawLines.length === 0) return;

    const records: ForgeRecord[] = [];
    let tornTailDetected = false;
    let tornLineDetail: string | null = null;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const d = decodeRecord(line);
      if (!d.ok) {
        if (d.reason === "unsupported-version") {
          this.lock.release();
          throw new UnsupportedSchemaVersionError(records.length + 1, 2, JOURNAL_SCHEMA_VERSION);
        }
        if (i === rawLines.length - 1) {
          tornTailDetected = true;
          tornLineDetail = d.detail;
          break;
        } else {
          this.lock.release();
          throw new JournalCorruptionError({ ok: false, at: records.length + 1, reason: d.reason, detail: d.detail });
        }
      }
      records.push(d.record);
    }

    if (tornTailDetected) {
      if (this.opts.repairTornTail && records.length > 0) {
        const vPrefix = verifyChain(records);
        if (!vPrefix.ok) {
          this.lock.release();
          throw new JournalCorruptionError(vPrefix);
        }
        const repairedContent = records.map((r) => encodeRecord(r)).join("\n") + "\n";
        const fd = openSync(this.paths.journal, "w");
        writeSync(fd, repairedContent, null, "utf8");
        fsyncSync(fd);
        closeSync(fd);
      } else {
        this.lock.release();
        throw new JournalCorruptionError({
          ok: false,
          at: records.length + 1,
          reason: "decode-error",
          detail: `uncommitted torn trailing record detected: ${tornLineDetail}`,
        });
      }
    }

    const v = verifyChain(records);
    if (!v.ok) {
      this.lock.release();
      throw new JournalCorruptionError(v);
    }
    // F-04: truncation/alteration detection via the closure anchor. A
    // mission.closed record's receipt.chainTip pins the tip BEFORE the closure
    // record; an anchor that does not bind to the closure record's prevHash
    // means the closure body was rewritten.
    // NOTE (audit fix): records AFTER mission.closed are legitimate — a
    // directive reopens/continues a mission and appends plan/stage records
    // (executeMissionTurn). verifyChain above already validates their linkage,
    // so demanding "closure is the last record" produced a false corruption
    // alarm on every continued mission and blocked its resume.
    const closed = records.find((r) => r.kind === "mission.closed");
    if (closed) {
      const tip = (closed.body as { receipt?: { chainTip?: string } }).receipt?.chainTip;
      if (tip && tip !== closed.prevHash) {
        this.lock.release();
        throw new JournalCorruptionError({
          ok: false, at: records.indexOf(closed) + 1,
          reason: "prev-hash-mismatch",
          detail: "closure anchor does not bind to the closure record's prevHash — closure body altered (F-04)",
        });
      }
    }
    this.chain = records;
  }

  /** Append — the only mutation path. Synchronously flushed to disk before
   *  returning: a record is durable once append() resolves. */
  append(input: Omit<AppendInput, "missionId">): ForgeRecord {
    this.assertOpen();
    if (!authorshipAllows(input.kind, input.author)) {
      throw new AuthorshipViolation(input.kind, input.author);
    }
    const rec = appendRecord(this.current(), { ...input, missionId: this.missionId });
    const line = encodeRecord(rec) + "\n";
    const fd = openSync(this.paths.journal, "a");
    try {
      writeSync(fd, line, null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.chain.push(rec);
    return rec;
  }

  /** Ordered replay of the authoritative chain. */
  read(): readonly ForgeRecord[] {
    this.assertOpen();
    return this.chain;
  }

  current(): ForgeRecord | null {
    return this.chain.length > 0 ? this.chain[this.chain.length - 1]! : null;
  }

  /** Hash-chain integrity check (INV-5). */
  verify(): VerifyResult {
    return verifyChain(this.chain);
  }

  lastSeq(): number {
    return this.chain.length;
  }

  byKind<K extends RecordKind>(kind: K): ForgeRecord[] {
    return this.chain.filter((r) => r.kind === kind);
  }

  find(id: string): ForgeRecord | undefined {
    return this.chain.find((r) => r.id === id);
  }

  /** Content-addressed artifact write (EVIDENCE.md): blob addressed by its own
   *  sha256; caller supplies the hash after computing it. Used by capability
   *  host capture and content-event ingestion. */
  writeArtifact(bytes: Uint8Array, sha256hex: string): string {
    this.assertOpen();
    const path = join(this.paths.artifacts, sha256hex);
    if (!existsSync(path)) {
      const tmp = path + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      let renamed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          renameSync(tmp, path); // atomic on same filesystem
          renamed = true;
          break;
        } catch (err: any) {
          if (attempt < 4 && (err.code === "EPERM" || err.code === "EBUSY")) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            continue;
          }
          throw err;
        }
      }
    }
    return path;
  }

  artifactPath(sha256hex: string): string | null {
    const path = join(this.paths.artifacts, sha256hex);
    return existsSync(path) ? path : null;
  }

  readArtifact(sha256hex: string): Uint8Array | null {
    const path = this.artifactPath(sha256hex);
    return path ? readFileSync(path) : null;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.lock.release();
  }

  private assertOpen(): void {
    if (!this.open) throw new Error("ledger is closed");
  }
}

export { dirname };
