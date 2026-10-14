// FORGE contracts — ModelFn surface (provider-neutral cognition).
// Source of truth: architecture/DATA-CONTRACTS.md §6.
//
// Providers emit DATA events only. Nothing here can execute a capability,
// write the ledger, or carry authority (no grant/approval/timeout fields exist).

import { createHash } from "node:crypto";
import { z } from "zod";
import { Iso8601Schema, RecordIdSchema } from "./base.js";
import { ConstraintsSchema } from "./base.js";
import { ProposalSchema, ProposalMetaSchema } from "./proposals.js";

export const CONTENT_EVENT_MAX_DECODED = 2 * 1024 * 1024; // C-5
export const MODEL_MESSAGE_MAX = 256 * 1024; // C-5 (M0 correction, ADR-007)

export const ProvenanceSchema = z.enum(["runtime-framing", "workspace-content"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Provenance marks the injection boundary (INV-14): untrusted content is
 *  always "workspace-content" and is data, never instructions. */
export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "observation"]),
    content: z.string().max(MODEL_MESSAGE_MAX),
    provenance: ProvenanceSchema,
  })
  .strict();
export type ModelMessage = z.infer<typeof ModelMessageSchema>;

export const ModelRequestSchema = z
  .object({
    messages: z.array(ModelMessageSchema).max(4096),
    capabilityCards: z
      .array(
        z
          .object({
            id: z.string().max(64),
            purpose: z.string().max(200),
            constraintsVocab: z.array(z.string().max(32)).max(8),
          })
          .strict(),
      ),
    activeGrants: z
      .array(
        z
          .object({
            capability: z.string().max(64),
            constraints: ConstraintsSchema,
            expiresAt: Iso8601Schema.nullable(),
          })
          .strict(),
      ),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    // signal is runtime-only (an AbortSignal is a live handle, not data) and is
    // carried outside the schema by the ModelRequest TS interface below.
  })
  .strict();
export type ModelRequestData = z.infer<typeof ModelRequestSchema>;

export interface ModelRequest extends ModelRequestData {
  readonly signal: AbortSignal;
}

export const ModelErrorCodeSchema = z.enum([
  "RateLimited",
  "QuotaExceeded",
  "AuthFailed",
  "ContextOverflow",
  "ContentPolicy",
  "Transport",
  "InvalidOutput",
  "Unknown",
]);
export type ModelErrorCode = z.infer<typeof ModelErrorCodeSchema>;

export const ModelErrorSchema = z
  .object({
    code: ModelErrorCodeSchema,
    message: z.string().max(4096),
    retryAfterMs: z.number().int().min(0).max(3_600_000).optional(),
  })
  .strict();
export type ModelError = z.infer<typeof ModelErrorSchema>;

export const ModelEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string().max(MODEL_MESSAGE_MAX) }).strict(),
  z
    .object({ type: z.literal("proposal"), proposal: ProposalSchema, meta: ProposalMetaSchema })
    .strict(),
  z
    .object({
      type: z.literal("claim"),
      statement: z.string().min(1).max(8192), // C-5
      citations: z.array(RecordIdSchema).min(1).max(64), // INV-2 at the contract layer
    })
    .strict(),
  // Content delivery for contentRef fields (audit-added, normative). The host
  // verifies sha256 over the decoded bytes; ingestion into the artifact store
  // happens at runtime, not here. Not an effect.
  z
    .object({
      type: z.literal("content"),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      base64: z
        .string()
        .max(Math.ceil(((CONTENT_EVENT_MAX_DECODED + 2) * 4) / 3)) // cheap prefilter
        .refine(isBase64, "content base64 must be valid base64")
        .refine(
          (s) => Buffer.byteLength(s, "base64") <= CONTENT_EVENT_MAX_DECODED,
          `content must decode to ≤ ${CONTENT_EVENT_MAX_DECODED} bytes (C-5)`,
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("usage"),
      tokensIn: z.number().int().min(0).safe(),
      tokensOut: z.number().int().min(0).safe(),
    })
    .strict(),
  z.object({ type: z.literal("error"), error: ModelErrorSchema }).strict(),
]);
export type ModelEvent = z.infer<typeof ModelEventSchema>;

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
}

/**
 * Content event verification (audit-required):
 *   model content → bounded input (schema above) → hash verification →
 *   validated content reference.
 * Pure and deterministic: no storage, no side effects. Returns the decoded
 * bytes' length and whether the declared hash matches the actual bytes.
 */
export function verifyContentEvent(
  event: Extract<ModelEvent, { type: "content" }>,
): { ok: boolean; actualSha256: string; declaredSha256: string; bytes: number } {
  const bytes = Buffer.from(event.base64, "base64");
  const actual = createHash("sha256").update(bytes).digest("hex");
  return {
    ok: actual === event.sha256,
    actualSha256: actual,
    declaredSha256: event.sha256,
    bytes: bytes.byteLength,
  };
}

// The ModelFn interface (KERNEL #7) — the entire provider surface.
export interface ModelFn {
  complete(req: ModelRequest): AsyncGenerator<ModelEvent>;
}
