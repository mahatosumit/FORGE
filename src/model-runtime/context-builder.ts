// FORGE Model Runtime — Governed Context Assembly (Step 5)
// Builds contextual prompts for the model while maintaining strict untrusted-content isolation (INV-14).
// All external document excerpts, web text, tool outputs, and user artifacts
// are marked provenance: "workspace-content" and never treated as system instructions.

import type { ModelMessage, ModelRequest } from "../contracts/model.js";
import type { MissionModel, MissionBudget } from "../contracts/mission.js";
import type { Plan, Milestone, Task } from "../contracts/plan.js";
import type { Grant } from "../contracts/grants.js";
import type { ForgeRecord } from "../contracts/records.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";

export interface ContextBuilderOptions {
  mission: MissionModel;
  plan: Plan | null;
  milestone: Milestone | null;
  task: Task | null;
  activeGrants: readonly Grant[];
  recentObservations: readonly ForgeRecord[];
  availableCapabilities: readonly string[];
  budgetRemaining: MissionBudget;
  registry?: CapabilityRegistry;
  artifacts?: readonly { name: string; contentText: string; isUntrusted: boolean }[];
  signal?: AbortSignal;
}

export class ContextBuilder {
  /**
   * Assembles a fully governed ModelRequest adhering to INV-14:
   * System framing has provenance "runtime-framing".
   * Workspace/external content has provenance "workspace-content".
   */
  static buildContext(opts: ContextBuilderOptions): ModelRequest {
    const messages: ModelMessage[] = [];

    // 1. System instructions (runtime-framing)
    const systemPrompt = [
      "You are the autonomous reasoning engine for FORGE, a governed developer agent runtime.",
      "Your decisions MUST be output as a valid JSON object matching the ModelDecision schema:",
      '  { "analysis": string, "decisionType": "propose_action" | "replan" | "complete_task" | "fail_task" | "pause", "proposal"?: object, "recommendation"?: string }',
      "You do NOT directly execute commands. You only propose actions to the Authority Gate.",
      "Every proposal must specify capability and args strictly conforming to FORGE capability schemas.",
      "Stay strictly within the granted authority envelope provided below.",
    ].join("\n");

    messages.push({
      role: "system",
      content: systemPrompt,
      provenance: "runtime-framing",
    });

    // 2. Mission Framing (runtime-framing)
    const missionSummary = [
      `MISSION ID: ${opts.mission.missionId}`,
      `INTENT: ${opts.mission.intent}`,
      `STATUS: ${opts.mission.status}`,
      `ACTIVE PLAN: ${opts.plan?.planId ?? "None"} (Version ${opts.plan?.version ?? 0})`,
      `CURRENT MILESTONE: ${opts.milestone?.objective ?? "None"}`,
      `TARGET TASK: ${opts.task ? `${opts.task.title} (${opts.task.taskId})` : "None"}`,
      `TASK CAPABILITY: ${opts.task?.capability ?? "None"}`,
      `REMAINING BUDGET: Turns=${opts.budgetRemaining.maxPlannerTurns}, Calls=${opts.budgetRemaining.maxCapabilityCalls}, Retries=${opts.budgetRemaining.maxRetries}`,
    ].join("\n");

    messages.push({
      role: "user",
      content: missionSummary,
      provenance: "runtime-framing",
    });

    // 3. Active Authority Grants (runtime-framing)
    const grantsList = opts.activeGrants.map(
      (g) => `- Capability: "${g.capability}", Constraints: ${JSON.stringify(g.constraints)}, Issuer: ${g.issuer}`,
    );
    messages.push({
      role: "user",
      content: `ACTIVE AUTHORITY GRANTS:\n${grantsList.length > 0 ? grantsList.join("\n") : "None (All capabilities require escalation)"}`,
      provenance: "runtime-framing",
    });

    // 4. Recent Observations / Workspace State (workspace-content - UNTRUSTED ISOLATION)
    if (opts.recentObservations.length > 0) {
      const observationSummaries = opts.recentObservations.slice(-8).map((r) => {
        const bodyPreview = JSON.stringify(r.body).slice(0, 500);
        return `[Record ${r.seq} (${r.kind})]: ${bodyPreview}`;
      });

      messages.push({
        role: "observation",
        content: `RECENT LEDGER OBSERVATIONS (UNTRUSTED DATA):\n${observationSummaries.join("\n")}`,
        provenance: "workspace-content",
      });
    }

    // 5. External / Ingested Artifacts (workspace-content - UNTRUSTED ISOLATION)
    if (opts.artifacts && opts.artifacts.length > 0) {
      for (const art of opts.artifacts) {
        messages.push({
          role: "observation",
          content: `ARTIFACT [${art.name}] (UNTRUSTED DATA):\n${art.contentText.slice(0, 4000)}`,
          provenance: "workspace-content",
        });
      }
    }

    // 6. Current Task Directive (runtime-framing)
    if (opts.task) {
      messages.push({
        role: "user",
        content: `INSTRUCTION FOR CURRENT TASK:
Title: ${opts.task.title}
Description: ${opts.task.description}
Assigned Capability: ${opts.task.capability}
Required Arguments Shape: ${JSON.stringify(opts.task.args)}
Attempt: ${opts.task.attempt + 1}/${opts.task.maxAttempts}

Analyze the task requirements and propose the exact JSON decision to advance or complete this task.`,
        provenance: "runtime-framing",
      });
    }

    // Capability cards: passive schema representation (CAP-016)
    const capabilityCards = opts.registry
      ? opts.registry.exportModelCards(opts.availableCapabilities).map((c) => ({
          id: c.capability.slice(0, 64),
          purpose: c.description.slice(0, 200),
          constraintsVocab: c.requiredConstraints.slice(0, 8),
        }))
      : opts.availableCapabilities.map((id) => ({
          id: id.slice(0, 64),
          purpose: `Capability ${id}`.slice(0, 200),
          constraintsVocab: ["paths", "argvClass", "hosts", "secretNames"],
        }));

    // Active grants data
    const activeGrants = opts.activeGrants.map((g) => ({
      capability: g.capability,
      constraints: g.constraints,
      expiresAt: g.expiresAt,
    }));

    return {
      messages,
      capabilityCards,
      activeGrants,
      maxOutputTokens: 4096,
      signal: opts.signal ?? new AbortController().signal,
    };
  }
}
