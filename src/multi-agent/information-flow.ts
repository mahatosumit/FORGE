// FORGE Information Flow Control & Security Lattice (Step 8 Phase 2C.4)
// Enforces DR-04:
// 1. 6-level security lattice: PUBLIC < WORKSPACE < MISSION_PRIVATE < CHILD_PRIVATE < SECRET < EXTERNAL.
// 2. Non-interference: CanFlow(L1, L2) <=> L1 <= L2.
// 3. Governed declassification filter: prevents parent oracle leaks of CHILD_PRIVATE secrets.
// 4. Star-topology artifact mediation between siblings without direct IPC.

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DelegationId, Sha256Hex } from "../contracts/index.js";

export type SecurityLabel =
  | "PUBLIC"
  | "WORKSPACE"
  | "MISSION_PRIVATE"
  | "CHILD_PRIVATE"
  | "SECRET"
  | "EXTERNAL";

export const SECURITY_LATTICE_RANK: Record<SecurityLabel, number> = {
  PUBLIC: 1,
  WORKSPACE: 2,
  MISSION_PRIVATE: 3,
  CHILD_PRIVATE: 4,
  SECRET: 5,
  EXTERNAL: 6,
};

export class FlowPolicyViolationError extends Error {
  constructor(source: SecurityLabel, dest: SecurityLabel, message?: string) {
    super(
      message ??
        `Information flow policy violation: cannot flow from ${source} (rank ${SECURITY_LATTICE_RANK[source]}) to ${dest} (rank ${SECURITY_LATTICE_RANK[dest]}) (DR-04)`,
    );
    this.name = "FlowPolicyViolationError";
  }
}

export class DeclassificationError extends Error {
  constructor(message: string) {
    super(`DeclassificationError: ${message}`);
    this.name = "DeclassificationError";
  }
}

export class InformationFlowPolicy {
  /**
   * Evaluates if information with source label can flow to destination label (DR-04 Rule 1).
   */
  static canFlow(source: SecurityLabel, dest: SecurityLabel): boolean {
    if (source === "EXTERNAL" && dest !== "EXTERNAL") {
      return false; // Tainted data cannot flow without sanitization
    }
    if (source === "SECRET" && dest !== "SECRET") {
      return false; // Secrets cannot flow without redaction
    }
    if (source === "CHILD_PRIVATE" && (dest === "WORKSPACE" || dest === "PUBLIC" || dest === "MISSION_PRIVATE")) {
      return false; // Child private data cannot cross without passing declassification filter
    }
    return SECURITY_LATTICE_RANK[source] <= SECURITY_LATTICE_RANK[dest];
  }

  static assertCanFlow(source: SecurityLabel, dest: SecurityLabel): void {
    if (!InformationFlowPolicy.canFlow(source, dest)) {
      throw new FlowPolicyViolationError(source, dest);
    }
  }
}

export class GovernedDeclassificationFilter {
  /**
   * Evaluates if a CHILD_PRIVATE artifact can be declassified to WORKSPACE (DR-04 Rule 3).
   * Checks:
   * 1. Zero occurrences of active secret strings.
   * 2. Zero matches against credential or API key patterns.
   */
  static declassifyArtifact(artifact: {
    content: string | Uint8Array;
    label: SecurityLabel;
    knownSecrets?: string[];
  }): { declassified: boolean; newLabel: SecurityLabel; error?: DeclassificationError } {
    if (artifact.label !== "CHILD_PRIVATE") {
      return { declassified: true, newLabel: artifact.label };
    }

    const text = typeof artifact.content === "string" ? artifact.content : Buffer.from(artifact.content).toString("utf8");

    // Secret pattern scanning
    if (artifact.knownSecrets) {
      for (const secret of artifact.knownSecrets) {
        if (secret.length >= 4 && text.includes(secret)) {
          return {
            declassified: false,
            newLabel: "SECRET",
            error: new DeclassificationError(
              "Declassification rejected: artifact content contains private secret value",
            ),
          };
        }
      }
    }

    // High entropy API token regex check
    if (/sk-[a-zA-Z0-9]{20,}/.test(text) || /bearer\s+[a-zA-Z0-9._-]{20,}/i.test(text)) {
      return {
        declassified: false,
        newLabel: "SECRET",
        error: new DeclassificationError(
          "Declassification rejected: artifact content matches API credential pattern",
        ),
      };
    }

    return {
      declassified: true,
      newLabel: "WORKSPACE",
    };
  }
}

export class ParentArtifactBroker {
  private readonly verifiedArtifacts = new Map<
    Sha256Hex,
    { content: Uint8Array; label: SecurityLabel; authorDelegationId: DelegationId }
  >();
  private readonly quarantinedAuthors = new Set<DelegationId>();

  quarantineAuthor(authorDelegationId: DelegationId): void {
    this.quarantinedAuthors.add(authorDelegationId);
  }

  /**
   * Publishes an artifact from a child to the parent broker with lattice validation (INV-41.1).
   */
  publishArtifact(
    authorDelegationId: DelegationId,
    content: Uint8Array,
    label: SecurityLabel = "CHILD_PRIVATE",
    knownSecrets?: string[],
  ): Sha256Hex {
    const sha = createHash("sha256").update(content).digest("hex") as Sha256Hex;

    const declass = GovernedDeclassificationFilter.declassifyArtifact({
      content,
      label,
      knownSecrets,
    });

    if (!declass.declassified && declass.error) {
      throw declass.error;
    }

    this.verifiedArtifacts.set(sha, {
      content,
      label: declass.newLabel,
      authorDelegationId,
    });

    return sha;
  }

  getArtifact(sha: Sha256Hex): { content: Uint8Array; label: SecurityLabel; authorDelegationId: DelegationId } | undefined {
    return this.verifiedArtifacts.get(sha);
  }

  /**
   * Mounts a verified, declassified artifact read-only into a recipient child's workspace (P2C-015, P2C-RACE-007).
   */
  mountArtifactForChild(
    recipientDelegationId: DelegationId,
    contentHash: Sha256Hex,
    targetWorkspaceRoot: string,
    relativePath: string,
  ): string {
    const entry = this.verifiedArtifacts.get(contentHash);
    if (!entry) {
      throw new Error(`Artifact "${contentHash}" not found in parent broker`);
    }

    if (this.quarantinedAuthors.has(entry.authorDelegationId)) {
      throw new DeclassificationError(
        `Artifact "${contentHash}" quarantined: author delegation "${entry.authorDelegationId}" was revoked (P2C-RACE-007)`,
      );
    }

    InformationFlowPolicy.assertCanFlow(entry.label, "WORKSPACE");

    const fullPath = join(targetWorkspaceRoot, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, entry.content, { mode: 0o444 });
    return fullPath;
  }
}
