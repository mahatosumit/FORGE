// FORGE contracts — Proposal (the sole world-affecting request channel).
// Source of truth: architecture/DATA-CONTRACTS.md §2.
//
// Invariant C-3: a Proposal carries NO authority-bearing fields — no timeout,
// no risk, no grant id, no capability-registry override. All schemas are
// .strict(); extra keys are rejected at the Gate, not stripped.

import { z } from "zod";
import {
  ArgvSchema,
  CriterionIdSchema,
  RecordIdSchema,
  Sha256HexSchema,
  WorkspacePathSchema,
  HttpMethodSchema,
  JsonValueSchema,
} from "./base.js";
import { DelegateProposalArgsSchema } from "./delegation.js";

const PATCH_MAX = 256 * 1024; // C-5 (M0 correction, ADR-007)
const URL_MAX = 2048;
const HTTP_MAX_BYTES = 10 * 1024 * 1024; // C-5
const QUERY_MAX = 1024;
const GIT_MESSAGE_MAX = 512;

function urlLike(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export const ProposalSchema = z.discriminatedUnion("capability", [
  z
    .object({
      capability: z.literal("fs"),
      args: z
        .object({
          op: z.enum(["write", "append", "patch", "mkdir"]),
          path: WorkspacePathSchema,
          contentRef: Sha256HexSchema.optional(),
          patch: z.string().max(PATCH_MAX).optional(),
          expectedBeforeHash: Sha256HexSchema.nullable().optional(),
        })
        .strict()
        .refine(
          (a) =>
            (a.op === "patch") === (a.patch !== undefined) ||
            (a.op !== "patch" && a.patch === undefined),
          "patch payload only valid for op:'patch'",
        )
        .refine(
          (a) =>
            (a.op === "write" || a.op === "append") ? a.contentRef !== undefined : a.contentRef === undefined,
          "contentRef required for write/append, forbidden otherwise",
        ),
    })
    .strict(),
  z
    .object({
      capability: z.literal("shell"),
      args: z
        .object({
          argv: ArgvSchema,
          cwd: WorkspacePathSchema,
          // NO timeout field: the runtime assigns it at dispatch (C-3).
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("git"),
      args: z
        .object({
          op: z.enum(["status", "diff", "add", "commit", "rev-parse"]),
          paths: z.array(WorkspacePathSchema).max(64).optional(),
          message: z.string().max(GIT_MESSAGE_MAX).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("http"),
      args: z
        .object({
          method: HttpMethodSchema,
          url: z.string().max(URL_MAX).refine(urlLike, "url must be http(s)"),
          maxBytes: z.number().int().min(1).max(HTTP_MAX_BYTES),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("search"),
      args: z
        .object({
          query: z.string().max(QUERY_MAX),
          glob: z.string().max(256).optional(),
          mode: z.enum(["grep", "glob", "symbol"]),
          pathPrefix: z.string().min(1).max(512).optional(),
        })
        .strict()
        .refine(
          (a) => a.query.length > 0 || a.pathPrefix !== undefined,
          "empty query requires pathPrefix (scoped read)",
        ),
    })
    .strict(),
  z
    .object({
      capability: z.literal("verify"),
      args: z
        .object({
          // verify can only run a *defined* criterion — existence is checked
          // by the engine against the mission's criterion records.
          criterionRef: CriterionIdSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("artifact"),
      args: z
        .object({
          op: z.literal("put"),
          path: WorkspacePathSchema.optional(),
          contentRef: Sha256HexSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("web_search"),
      args: z
        .object({
          query: z.string().min(1).max(QUERY_MAX),
          maxResults: z.number().int().min(1).max(25).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("web_fetch"),
      args: z
        .object({
          url: z.string().max(URL_MAX).refine(urlLike, "url must be http(s)"),
          extractMode: z.enum(["markdown", "text", "raw"]).optional(),
          maxBytes: z.number().int().min(1).max(HTTP_MAX_BYTES).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("mcp_call"),
      args: z
        .object({
          serverId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_-]+$/i, "serverId must be alphanumeric with dashes or underscores"),
          toolName: z
            .string()
            .min(1)
            .max(128)
            .regex(/^[a-z0-9_.-]+$/i, "toolName must be alphanumeric with dashes, dots, or underscores"),
          arguments: z.record(JsonValueSchema).refine((o) => Object.keys(o).length <= 64, "tool arguments count must be ≤ 64"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("mcp_server_start"),
      args: z
        .object({
          serverId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_-]+$/i, "serverId must be alphanumeric with dashes or underscores"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("mcp_server_stop"),
      args: z
        .object({
          serverId: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9_-]+$/i, "serverId must be alphanumeric with dashes or underscores"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("doc_parse"),
      args: z
        .object({
          path: WorkspacePathSchema,
          mode: z.enum(["text", "markdown", "structured", "metadata"]).optional(),
          maxBytes: z.number().int().min(1).max(20 * 1024 * 1024).optional(),
          pages: z.array(z.number().int().min(1).max(10000)).max(100).optional(),
          sheet: z.string().min(1).max(128).optional(),
          includeImages: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      capability: z.literal("delegate"),
      args: DelegateProposalArgsSchema,
    })
    .strict(),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

export const ProposalMetaSchema = z
  .object({
    rationale: z.string().min(1).max(4096), // C-5; model narration, never executed
    citations: z.array(RecordIdSchema).max(64),
  })
  .strict();
export type ProposalMeta = z.infer<typeof ProposalMetaSchema>;
