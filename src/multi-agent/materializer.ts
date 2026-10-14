// FORGE Child Mission Materializer (Step 8 Phase 2B.1: Materialization)
// Materializes isolated filesystem trees, workspaces, and genesis ledgers for child agents.
// Guarantees: Child mission directory is independent of parent mission directory;
//             Genesis journal is initialized with parent delegation attribution.

import { mkdirSync, existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { MissionId, DelegationId, Sha256Hex, Iso8601 } from "../contracts/index.js";
import type { EffectiveAuthorityEnvelope } from "../contracts/delegation.js";
import { Ledger } from "../ledger/ledger.js";

export interface MaterializedChildMission {
  childMissionId: MissionId;
  childMissionDir: string;
  childWorkspaceDir: string;
  childArtifactsDir: string;
  childLedger: Ledger;
}

export class ChildMissionMaterializer {
  /**
   * Materializes an isolated child mission environment.
   * Creates:
   * - <dataDir>/missions/<childMissionId>/
   * - <dataDir>/missions/<childMissionId>/workspace/
   * - <dataDir>/missions/<childMissionId>/artifacts/
   * - Independent child Ledger initialized with genesis mission.opened record.
   */
  static materialize(
    dataDir: string,
    parentMissionId: MissionId,
    childMissionId: MissionId,
    delegationId: DelegationId,
    effectiveAuthorityHash: Sha256Hex,
    envelope: EffectiveAuthorityEnvelope,
    intentHash?: Sha256Hex,
  ): MaterializedChildMission {
    const normDataDir = normalize(resolve(dataDir));
    const childMissionDir = join(normDataDir, childMissionId);
    const childWorkspaceDir = join(childMissionDir, "workspace");
    const childArtifactsDir = join(childMissionDir, "artifacts");

    // Create directories
    mkdirSync(childMissionDir, { recursive: true });
    mkdirSync(childWorkspaceDir, { recursive: true });
    mkdirSync(childArtifactsDir, { recursive: true });

    // Initialize child ledger
    const childLedger = new Ledger({
      dataDir: normDataDir,
      missionId: childMissionId,
      writer: { pid: process.pid, host: `supervisor-delegation-${delegationId}` },
    });

    // Append genesis record if newly created (chain is empty)
    if (childLedger.current() === null) {
      childLedger.append({
        kind: "mission.opened",
        author: "runtime",
        ts: new Date().toISOString() as Iso8601,
        body: {
          intent: {
            type: "child_delegation",
            parentMissionId,
            delegationId,
            effectiveAuthorityHash,
            depth: envelope.depth,
            ...(intentHash ? { intentHash } : {}),
          },
          goalSpec: {
            summary: `Child mission ${childMissionId} delegated under delegation ${delegationId}`,
            proposedCriteria: [],
          },
        },
      });
    }

    return {
      childMissionId,
      childMissionDir,
      childWorkspaceDir,
      childArtifactsDir,
      childLedger,
    };
  }
}
