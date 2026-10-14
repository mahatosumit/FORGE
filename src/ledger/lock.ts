// FORGE ledger — single-writer lock (INV-6, ADR-002).
//
// The host process is the single writer to a mission journal. The lock is an
// exclusively-created file holding {pid, host, heartbeat}. A stale lock
// (heartbeat older than STALE_MS — i.e. the writer died without releasing) is
// stolen by rewriting it. This is host-level coordination, NOT ledger state.

import { openSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

export const LOCK_STALE_MS = 30_000;

export class LockError extends Error {
  constructor(public readonly missionId: string, public readonly holder: unknown) {
    super(`mission ${missionId} is locked by another writer (INV-6)`);
    this.name = "LockError";
  }
}

export interface LockHandle {
  release(): void;
  heartbeat(): void;
}

export function acquireLock(missionDir: string, missionId: string, info: { pid: number; host: string }): LockHandle {
  const lockPath = join(missionDir, ".lock");
  if (existsSync(lockPath)) {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    let holder: unknown = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      holder = null;
    }
    if (age < LOCK_STALE_MS) throw new LockError(missionId, holder);
    // stale — steal (the previous writer is dead; the journal is append-only
    // and crash-consistent, so stealing is safe per ADR-002).
    unlinkSync(lockPath);
  }
  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // exclusive create — O_EXCL semantics
  } catch (err: any) {
    if (err && (err.code === "EEXIST" || err.code === "EBUSY" || err.code === "EPERM")) {
      let holder: unknown = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        holder = null;
      }
      throw new LockError(missionId, holder);
    }
    throw err;
  }

  const now = Date.now();
  writeFileSync(fd, JSON.stringify({ ...info, acquiredAt: now, heartbeat: now }));
  closeSync(fd);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (existsSync(lockPath)) unlinkSync(lockPath);
      } catch {
        /* best-effort release; a stale lock will be stolen later */
      }
    },
    heartbeat() {
      if (released) return;
      try {
        writeFileSync(lockPath, JSON.stringify({ ...info, acquiredAt: now, heartbeat: Date.now() }));
      } catch {
        /* heartbeat is advisory */
      }
    },
  };
}
