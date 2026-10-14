// FORGE Model Runtime — Structured Model Output & Decision Validation (Step 5)
// Models must NEVER directly execute capabilities.
// All model output must pass rigorous schema validation. Malformed output becomes
// a controlled error that is recorded and handled gracefully.

import { z } from "zod";
import { ProposalSchema, ProposalMetaSchema, type Proposal, type ProposalMeta } from "../contracts/proposals.js";
import type { ModelEvent } from "../contracts/model.js";

export const ModelDecisionTypeSchema = z.enum([
  "propose_action",
  "replan",
  "complete_task",
  "fail_task",
  "pause",
]);
export type ModelDecisionType = z.infer<typeof ModelDecisionTypeSchema>;

export const PlanRevisionSchema = z
  .object({
    reason: z.string().min(1).max(2048),
    revisedObjectives: z.array(z.string().min(1).max(512)).max(16).optional(),
  })
  .strict();
export type PlanRevision = z.infer<typeof PlanRevisionSchema>;

export const ModelDecisionSchema = z
  .object({
    analysis: z.string().min(1).max(8192),
    decisionType: ModelDecisionTypeSchema,
    proposal: ProposalSchema.optional(),
    meta: ProposalMetaSchema.optional(),
    planRevision: PlanRevisionSchema.optional(),
    recommendation: z.enum(["retry", "replan", "escalate", "abort", "proceed"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine(
    (d) => (d.decisionType === "propose_action" ? d.proposal !== undefined : true),
    "decisionType 'propose_action' requires a valid proposal",
  )
  .refine(
    (d) => (d.decisionType === "replan" ? d.planRevision !== undefined : true),
    "decisionType 'replan' requires planRevision details",
  );
export type ModelDecision = z.infer<typeof ModelDecisionSchema>;

export interface ParseDecisionResult {
  ok: boolean;
  decision?: ModelDecision;
  error?: string;
  raw: string;
  validationErrors?: string[];
}

/**
 * Extracts a candidate JSON block from raw model output.
 */
function extractJsonCandidate(raw: string): string | null {
  const trimmed = raw.trim();

  // 1. Try markdown code fence: ```json ... ``` or ``` ... ```
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch && codeFenceMatch[1]) {
    const candidate = codeFenceMatch[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  // 2. Try whole string if it starts with { and ends with }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // 3. Scan for outer balanced braces
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

/**
 * Parses and validates raw model text or streaming events into a structured ModelDecision.
 */
export function parseModelDecision(input: string | readonly ModelEvent[]): ParseDecisionResult {
  let rawText = "";

  if (typeof input === "string") {
    rawText = input;
  } else {
    // If input is an array of ModelEvent, check for explicit proposal event first
    const proposalEvent = input.find((e) => e.type === "proposal");
    if (proposalEvent && proposalEvent.type === "proposal") {
      const decision: ModelDecision = {
        analysis: proposalEvent.meta.rationale,
        decisionType: "propose_action",
        proposal: proposalEvent.proposal,
        meta: proposalEvent.meta,
      };
      return { ok: true, decision, raw: JSON.stringify(decision) };
    }

    // Concatenate text deltas
    for (const ev of input) {
      if (ev.type === "text-delta") {
        rawText += ev.text;
      }
    }
  }

  const jsonStr = extractJsonCandidate(rawText);
  if (!jsonStr) {
    return {
      ok: false,
      error: "No JSON decision block found in model output",
      raw: rawText,
      validationErrors: ["Expected JSON object matching ModelDecisionSchema"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      ok: false,
      error: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw: jsonStr,
      validationErrors: ["Invalid JSON syntax"],
    };
  }

  // Auto-normalize legacy/loose proposal formatting if model returned { proposal: { ... }, rationale: ... }
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (!obj["decisionType"]) {
      if (obj["proposal"]) {
        obj["decisionType"] = "propose_action";
      } else if (obj["planRevision"] || obj["replan"]) {
        obj["decisionType"] = "replan";
      } else {
        obj["decisionType"] = "complete_task";
      }
    }
    if (!obj["analysis"] && obj["rationale"]) {
      obj["analysis"] = String(obj["rationale"]);
    } else if (!obj["analysis"] && obj["reason"]) {
      obj["analysis"] = String(obj["reason"]);
    } else if (!obj["analysis"]) {
      obj["analysis"] = "Autonomous decision evaluation";
    }

    if (obj["proposal"] && !obj["meta"]) {
      obj["meta"] = {
        rationale: String(obj["analysis"] ?? "Autonomous action proposal"),
        citations: [],
      };
    }
  }

  const validation = ModelDecisionSchema.safeParse(parsed);
  if (!validation.success) {
    const errors = validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return {
      ok: false,
      error: `Model decision schema violation: ${errors.join("; ")}`,
      raw: jsonStr,
      validationErrors: errors,
    };
  }

  return {
    ok: true,
    decision: validation.data,
    raw: jsonStr,
  };
}
