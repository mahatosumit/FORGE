// FORGE context compaction — mechanical, runtime-authored (ADR-005: memory is
// derived; no model summarization in the kernel). When an assembled request
// grows past a deterministic threshold, the runtime writes a checkpoint.created
// record and collapses the visible ledger tail. The checkpoint is a derived
// view of the journal: replay stays the source of truth.

export interface CompactionInputMessage {
  role: string;
  content: string;
}

/** ~4 chars/token heuristic; 160k chars ≈ 40k tokens. */
export const COMPACT_EST_CHARS = 160_000;

export function estimateRequestChars(messages: ReadonlyArray<CompactionInputMessage>): number {
  let n = 0;
  for (const m of messages) n += m.content.length;
  return n;
}

export function shouldCompact(messages: ReadonlyArray<CompactionInputMessage>, threshold = COMPACT_EST_CHARS): boolean {
  return estimateRequestChars(messages) > threshold;
}

export interface CheckpointDigest {
  checkpointId: string;
  state: string;
  planId: string;
  completedTasks: number;
  totalTasks: number;
  completedOutcomes: string[];
  verdicts: string[];
  unresolved: string[];
}

/** Derive a mechanical checkpoint digest from ledger records. */
export function deriveCheckpointSummary(
  records: ReadonlyArray<{ kind: string; body: unknown }>,
  checkpointId: string,
): CheckpointDigest {
  let planId = "plan";
  let totalTasks = 1;
  for (const r of records) {
    if (r.kind === "plan.proposed") {
      const b = r.body as { planId?: string; stages?: unknown[] };
      if (typeof b.planId === "string") planId = b.planId;
      if (Array.isArray(b.stages)) totalTasks = Math.max(1, b.stages.length);
    }
  }
  const completedOutcomes: string[] = [];
  const verdicts: string[] = [];
  const unresolved: string[] = [];
  for (const r of records) {
    if (r.kind === "stage.completed") {
      const b = r.body as { stageId?: string; outcome?: string };
      completedOutcomes.push(`${b.stageId ?? "stage"}=${b.outcome ?? "done"}`);
    }
    if (r.kind === "verdict.recorded") {
      const b = r.body as { criterionId?: string; result?: string };
      verdicts.push(`${b.criterionId ?? "criterion"}:${b.result ?? "unknown"}`);
      if (b.result === "fail" || b.result === "inconclusive") unresolved.push(b.criterionId ?? "criterion");
    }
    if (r.kind === "engine.error") {
      const b = r.body as { code?: string };
      if (b.code) unresolved.push(`error:${b.code}`);
    }
  }
  return {
    checkpointId,
    state: "compacted",
    planId,
    completedTasks: completedOutcomes.length,
    totalTasks,
    completedOutcomes: completedOutcomes.slice(-16),
    verdicts: verdicts.slice(-16),
    unresolved: [...new Set(unresolved)].slice(0, 16),
  };
}

/** Render the checkpoint as a runtime-framed context block (INV-14 marked). */
export function renderCheckpointBlock(d: CheckpointDigest, goal: string): string {
  return [
    `CHECKPOINT ${d.checkpointId} (runtime-authored; earlier ledger folded):`,
    `GOAL: ${goal}`,
    `completed tasks: ${d.completedTasks}/${d.totalTasks}${d.completedOutcomes.length ? " [" + d.completedOutcomes.join(", ") + "]" : ""}`,
    `verdicts: ${d.verdicts.length ? d.verdicts.join(", ") : "none"}`,
    `unresolved: ${d.unresolved.length ? d.unresolved.join(", ") : "none"}`,
  ].join("\n");
}
