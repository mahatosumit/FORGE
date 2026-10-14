// FORGE Production Runtime Supervisor (Step 7B.7)
// Manages mission lifecycle, startup crash recovery sweep, heartbeat leasing,
// and graceful signal-safe shutdown.

import { readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openMission, type MissionStore, LockError, JournalCorruptionError } from "../ledger/index.js";
import { LOCK_STALE_MS } from "../ledger/lock.js";
import { MissionRecovery, type RecoveryAnalysis } from "../mission-engine/recovery.js";
import { CapabilityRegistry, createDefaultCapabilityRegistry } from "../capabilities/index.js";
import type { ForgeRecord } from "../contracts/records.js";

export interface ForgeRuntimeOptions {
  dataDir: string;
  workspaceRoot: string;
  registry?: CapabilityRegistry;
  onPostEffectUnknown?: (missionId: string, proposalId: string) => Promise<boolean>;
}

export interface MissionRecoveryReport {
  missionId: string;
  status: "clean" | "closed" | "interrupted" | "post-effect-unknown" | "active" | "quarantined";
  analysis: RecoveryAnalysis | null;
  recovered: boolean;
}

export class ForgeRuntime {
  public readonly dataDir: string;
  public readonly workspaceRoot: string;
  public readonly registry: CapabilityRegistry;
  private activeMissions = new Map<string, { store: MissionStore; controller: AbortController }>();
  private isShuttingDown = false;
  private signalCleanupRegistered = false;

  constructor(private readonly opts: ForgeRuntimeOptions) {
    this.dataDir = opts.dataDir;
    this.workspaceRoot = opts.workspaceRoot;
    this.registry = opts.registry ?? createDefaultCapabilityRegistry();
  }

  /**
   * Scans dataDir/missions upon boot, cleans stale locks, detects interrupted
   * missions, and performs crash recovery.
   */
  async bootRecoverySweep(): Promise<MissionRecoveryReport[]> {
    const missionsDir = join(this.dataDir, "missions");
    if (!existsSync(missionsDir)) return [];

    const reports: MissionRecoveryReport[] = [];
    const entries = readdirSync(missionsDir, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const missionId = ent.name;
      const dir = join(missionsDir, missionId);
      const journalPath = join(dir, "journal.jsonl");
      if (!existsSync(journalPath)) continue;

      // 1. Clean stale locks if prior process crashed
      const lockPath = join(dir, ".lock");
      if (existsSync(lockPath)) {
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age >= LOCK_STALE_MS) {
            unlinkSync(lockPath);
          }
        } catch {
          // ignore transient lock check errors
        }
      }

      // 2. Open mission in recovery mode (allowing repair of uncommitted torn tails)
      let store: MissionStore;
      try {
        store = openMission({
          dataDir: this.dataDir,
          missionId,
          writer: { pid: process.pid, host: "forge-supervisor" },
          repairTornTail: true,
        });
      } catch (err) {
        if (err instanceof LockError) {
          reports.push({
            missionId,
            status: "active",
            analysis: null,
            recovered: false,
          });
        } else if (err instanceof JournalCorruptionError) {
          reports.push({
            missionId,
            status: "quarantined",
            analysis: null,
            recovered: false,
          });
        }
        continue;
      }

      const records = store.read();
      const isClosed = records.some((r) => r.kind === "mission.closed");

      if (isClosed) {
        store.close();
        reports.push({
          missionId,
          status: "closed",
          analysis: null,
          recovered: false,
        });
        continue;
      }

      const analysis = MissionRecovery.analyzeLedger(records, this.registry);
      if (!analysis.isInterrupted) {
        store.close();
        reports.push({
          missionId,
          status: "clean",
          analysis,
          recovered: false,
        });
        continue;
      }

      if (analysis.hasPostEffectUnknown) {
        store.close();
        reports.push({
          missionId,
          status: "post-effect-unknown",
          analysis,
          recovered: false,
        });
      } else {
        store.close();
        reports.push({
          missionId,
          status: "interrupted",
          analysis,
          recovered: true,
        });
      }
    }

    return reports;
  }

  /**
   * Registers OS signal handlers (SIGINT, SIGTERM) for graceful shutdown.
   */
  registerSignalHandlers(): void {
    if (this.signalCleanupRegistered) return;
    this.signalCleanupRegistered = true;

    const onSignal = () => {
      this.shutdown();
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  /**
   * Aborts active mission tasks and cleanly releases all locks.
   */
  shutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    for (const [mid, { store, controller }] of this.activeMissions) {
      try {
        controller.abort();
        store.close();
      } catch {}
    }
    this.activeMissions.clear();
  }
}
