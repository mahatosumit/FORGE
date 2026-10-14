// FORGE contracts — Mission closure and Receipt (derived types, §5).

import { z } from "zod";
import {
  CriterionIdSchema,
  GrantIdSchema,
  Sha256HexSchema,
  WorkspacePathSchema,
  RecordIdSchema,
} from "./base.js";

export const MissionClosureSchema = z.enum([
  "verified",
  "completed-unverified",
  "blocked",
  "failed",
  "revised",
]);
export type MissionClosure = z.infer<typeof MissionClosureSchema>;

export const WeakestTierSchema = z.enum(["mechanical", "adjudicated", "none"]);

export const ReceiptSchema = z
  .object({
    closure: MissionClosureSchema,
    // Computed from the WEAKEST verdict — INV-11/INV-12. Adjudicated passes
    // never upgrade this; the field exists so the reader can discount.
    weakestTier: WeakestTierSchema,
    criteria: z
      .array(
        z
          .object({
            criterionId: CriterionIdSchema,
            verdictRef: RecordIdSchema,
            tier: z.enum(["mechanical", "adjudicated"]),
          })
          .strict(),
      )
      .max(256),
    authorityManifest: z
      .array(
        z
          .object({
            grantId: GrantIdSchema,
            issuer: z.enum(["base-policy", "envelope", "escalation"]),
            escalations: z.number().int().min(0),
          })
          .strict(),
      )
      .max(64),
    changeManifest: z
      .array(
        z
          .object({
            kind: z.enum(["file", "artifact"]),
            ref: Sha256HexSchema,
            path: WorkspacePathSchema.nullable(),
          })
          .strict(),
      )
      .max(1024),
    costs: z
      .object({
        tokensIn: z.number().int().min(0).safe(),
        tokensOut: z.number().int().min(0).safe(),
        wallClockMs: z.number().int().min(0).safe(),
      })
      .strict(),
    chainTip: Sha256HexSchema, // journal integrity anchor at closure
  })
  .strict();
export type Receipt = z.infer<typeof ReceiptSchema>;
