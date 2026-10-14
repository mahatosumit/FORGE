// FORGE contracts — Grant (authority) and CapabilityManifest.
// Source of truth: architecture/DATA-CONTRACTS.md §3 + audit-added §8.

import { z } from "zod";
import {
  ConstraintsSchema,
  GrantIdSchema,
  Iso8601Schema,
  MissionIdSchema,
  Sha256HexSchema,
} from "./base.js";

export const CapabilityIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/, "capability id: lowercase dotted namespace");
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const GrantIssuerSchema = z.enum(["base-policy", "envelope", "escalation"]);

/** Authority as data (KERNEL primitive #2). Immutable: changes are
 *  revoke + issue, both ledgered. Constraints are machine-checkable. */
export const GrantSchema = z
  .object({
    id: GrantIdSchema,
    missionId: MissionIdSchema,
    capability: CapabilityIdSchema,
    constraints: ConstraintsSchema,
    expiresAt: Iso8601Schema.nullable(),
    issuer: GrantIssuerSchema,
    parentGrantId: GrantIdSchema.nullable(),
  })
  .strict();
export type Grant = z.infer<typeof GrantSchema>;

// ---------------------------------------------------------------------------
// CapabilityManifest (audit-added, normative). Data only — never executes.
// ---------------------------------------------------------------------------

export const ManifestVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "manifest version must be semver");

export const RiskClassSchema = z.enum(["read", "write", "execute", "network", "secret"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const EnvironmentKindSchema = z.enum(["local", "container"]);

/** The constraint vocabulary a manifest declares — keys of Constraints. */
export const CONSTRAINT_VOCAB = [
  "paths",
  "argvClass",
  "hosts",
  "methods",
  "secretNames",
  "exclusive",
  "mcpTools",
  "mcpServers",
] as const;

export const CapabilityManifestSchema = z
  .object({
    id: CapabilityIdSchema,
    version: ManifestVersionSchema,
    purpose: z.string().min(1).max(200),
    environments: z.array(EnvironmentKindSchema).min(1).max(2),
    proposalKind: z.enum([
      "fs",
      "shell",
      "git",
      "http",
      "search",
      "verify",
      "artifact",
      "web_search",
      "web_fetch",
      "mcp_call",
      "doc_parse",
      "mcp_server_start",
      "mcp_server_stop",
    ]),
    constraintsVocab: z
      .array(z.enum(CONSTRAINT_VOCAB))
      .max(CONSTRAINT_VOCAB.length), // empty = read-only capability with no constraint vocabulary
    concurrency: z.enum(["parallel", "exclusive"]),
    idempotent: z.boolean(),
    riskClass: z.array(RiskClassSchema).min(1).max(5),
    provenance: z
      .object({
        pack: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
        hash: Sha256HexSchema,
      })
      .strict(),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
