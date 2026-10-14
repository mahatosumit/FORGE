// FORGE Autonomous Mission Verification Engine (Step 4)
// Evaluates criteria mechanically without trusting model claims.
// Checks artifact store, workspace file system, command exit codes, and test suites.

import { createHash } from "node:crypto";
import type { CriterionExpr, ForgeRecord } from "../contracts/records.js";
import type { Sha256Hex } from "../contracts/base.js";
import type { Milestone, Task } from "../contracts/plan.js";
import type { MissionModel } from "../contracts/mission.js";
import type { LocalEnvironment } from "../environments/local.js";

export interface VerificationCheckResult {
  passed: boolean;
  reason: string | null;
  evidenceRefs: Sha256Hex[];
}

export type GovernedCommandExecutor = (
  argv: readonly string[],
  signal?: AbortSignal,
) => Promise<{ exit: number | null; evidenceRef?: Sha256Hex }>;

export class VerificationEngine {
  constructor(
    private readonly environment: LocalEnvironment,
    private readonly artifactBytes: (sha: string) => Uint8Array | null,
    private readonly writeArtifact?: (bytes: Uint8Array) => Sha256Hex,
    private readonly commandExecutor?: GovernedCommandExecutor,
  ) {}

  /**
   * Evaluates a single CriterionExpr mechanically.
   */
  async evaluateCriterion(
    expr: CriterionExpr,
    signal?: AbortSignal,
  ): Promise<VerificationCheckResult> {
    const evidenceRefs: Sha256Hex[] = [];
    const effSignal = signal ?? new AbortController().signal;

    switch (expr.kind) {
      case "command-exit":
      case "test-suite": {
        if (!this.commandExecutor) {
          return {
            passed: false,
            reason: "Command execution in verification criteria requires an active grant evaluated by the Authority Gate (INV-3)",
            evidenceRefs,
          };
        }
        try {
          const expectedExit = expr.kind === "command-exit" ? expr.expect : 0;
          const execRes = await this.commandExecutor(expr.argv, effSignal);
          if (execRes.evidenceRef) {
            evidenceRefs.push(execRes.evidenceRef);
          }
          const passed = execRes.exit !== null && execRes.exit === expectedExit;
          const reason = passed
            ? null
            : `Command [${expr.argv.join(" ")}] exited with ${execRes.exit}, expected ${expectedExit}`;
          return { passed, reason, evidenceRefs };
        } catch (err) {
          return {
            passed: false,
            reason: `Governed verification execution threw: ${err instanceof Error ? err.message : String(err)}`,
            evidenceRefs,
          };
        }
      }

      case "file-state": {
        let bytes: Uint8Array | null = null;
        try {
          bytes = this.environment.readFile(expr.path as never);
        } catch {
          bytes = null;
        }

        if (expr.expect === "exists") {
          const passed = bytes !== null;
          return {
            passed,
            reason: passed ? null : `File ${expr.path} does not exist`,
            evidenceRefs,
          };
        }

        if (!bytes) {
          return {
            passed: false,
            reason: `File ${expr.path} does not exist for expectation "${expr.expect}"`,
            evidenceRefs,
          };
        }

        if (expr.expect === "hash") {
          const hash = createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
          evidenceRefs.push(hash);
          const passed = hash === expr.hash;
          return {
            passed,
            reason: passed ? null : `File ${expr.path} hash ${hash} did not match expected ${expr.hash}`,
            evidenceRefs,
          };
        }

        if (expr.expect === "diff-contains") {
          const text = new TextDecoder().decode(bytes);
          const passed = text.includes(expr.pattern ?? "");
          return {
            passed,
            reason: passed
              ? null
              : `File ${expr.path} does not contain pattern "${expr.pattern}"`,
            evidenceRefs,
          };
        }

        return { passed: false, reason: `Unknown file-state expect: ${expr.expect}`, evidenceRefs };
      }

      case "artifact-exists": {
        const found = this.artifactBytes(expr.hash) !== null;
        if (found) evidenceRefs.push(expr.hash);
        return {
          passed: found,
          reason: found ? null : `Artifact ${expr.hash} not found in artifact store`,
          evidenceRefs,
        };
      }

      case "http": {
        // HTTP evaluation without live fetch defaults to failing closed or checking presence
        return {
          passed: false,
          reason: "HTTP criteria cannot be verified without governed network capability",
          evidenceRefs,
        };
      }

      default:
        return { passed: false, reason: "Unsupported criterion kind", evidenceRefs };
    }
  }

  /**
   * Mechanically verifies a completed task against its observation record and any criteria.
   */
  async verifyTask(
    task: Task,
    observationRecord?: ForgeRecord,
  ): Promise<VerificationCheckResult> {
    const evidenceRefs: Sha256Hex[] = [];

    // 1. If observation is present, inspect mechanical signals
    if (observationRecord) {
      const body = observationRecord.body as unknown as Record<string, unknown>;

      // Check observation.shell / observation.git
      const exitVal = body["exit"];
      if (exitVal !== undefined && exitVal !== 0) {
        return {
          passed: false,
          reason: `Task capability exited with fault or non-zero code: ${exitVal ?? body["signal"] ?? "fault"}`,
          evidenceRefs,
        };
      }

      // Check observation.web_fetch / observation.http status code
      const httpStatusVal = body["status"];
      if (typeof httpStatusVal === "number") {
        if (httpStatusVal >= 400) {
          return {
            passed: false,
            reason: `Web/HTTP request failed with status code: ${httpStatusVal}`,
            evidenceRefs,
          };
        }
      }

      // Check observation.doc_parse / observation.mcp
      const statusVal = body["status"];
      if (typeof statusVal === "string") {
        if (statusVal !== "success") {
          return {
            passed: false,
            reason: `Capability reported non-success status: ${statusVal}`,
            evidenceRefs,
          };
        }
      }

      // Check MCP explicit error property
      const errVal = body["error"];
      if (typeof errVal === "string" && errVal.length > 0) {
        return {
          passed: false,
          reason: `Capability reported error: ${errVal}`,
          evidenceRefs,
        };
      }

      // Extract output refs
      const outputRefVal = body["outputRef"];
      if (typeof outputRefVal === "string") {
        evidenceRefs.push(outputRefVal as Sha256Hex);
      }
      const contentRefVal = body["contentRef"];
      if (typeof contentRefVal === "string") {
        evidenceRefs.push(contentRefVal as Sha256Hex);
      }
      const hashVal = body["hash"];
      if (typeof hashVal === "string") {
        evidenceRefs.push(hashVal as Sha256Hex);
      }
    }

    return {
      passed: true,
      reason: null,
      evidenceRefs,
    };
  }

  /**
   * Mechanically verifies milestone completion criteria.
   */
  async verifyMilestone(milestone: Milestone): Promise<VerificationCheckResult> {
    const allEvidence: Sha256Hex[] = [];

    // All tasks must have succeeded or been skipped
    for (const task of milestone.tasks) {
      if (task.status !== "succeeded" && task.status !== "skipped") {
        return {
          passed: false,
          reason: `Milestone ${milestone.milestoneId} task ${task.taskId} is in state ${task.status}`,
          evidenceRefs: allEvidence,
        };
      }
      for (const ref of task.evidenceRefs) {
        allEvidence.push(ref);
      }
    }

    // Evaluate explicit verificationCriteria if present
    for (const expr of milestone.verificationCriteria) {
      const res = await this.evaluateCriterion(expr);
      allEvidence.push(...res.evidenceRefs);
      if (!res.passed) {
        return {
          passed: false,
          reason: `Milestone criterion failed: ${res.reason}`,
          evidenceRefs: allEvidence,
        };
      }
    }

    return {
      passed: true,
      reason: null,
      evidenceRefs: allEvidence,
    };
  }

  /**
   * Mechanically verifies overall mission criteria.
   */
  async verifyMission(
    mission: MissionModel,
    criteria: CriterionExpr[],
  ): Promise<VerificationCheckResult> {
    const allEvidence: Sha256Hex[] = [];

    for (const expr of criteria) {
      const res = await this.evaluateCriterion(expr);
      allEvidence.push(...res.evidenceRefs);
      if (!res.passed) {
        return {
          passed: false,
          reason: `Mission criterion failed: ${res.reason}`,
          evidenceRefs: allEvidence,
        };
      }
    }

    return {
      passed: true,
      reason: null,
      evidenceRefs: allEvidence,
    };
  }
}
