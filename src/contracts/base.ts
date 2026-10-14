// FORGE contracts — base scalars, branded IDs, authorship.
// Source of truth: architecture/DATA-CONTRACTS.md (§0–§1, §4 authorship matrix).
//
// M0 correction (ADR-007): IDs carry a domain prefix ("mis_", "rec_", "grt_",
// "stg_", "cri_") over a 26-char Crockford-base32 ULID body so that ID domains
// are runtime-distinguishable, not merely compile-time brands. Without the
// prefix, a RecordId would validate as a MissionId and vice versa — the audit's
// "wrong ID domains cannot silently substitute" requirement would be
// unenforceable at runtime.

import { z } from "zod";
import { webcrypto as nodeCryptoInternal } from "node:crypto";

function randomBytes(n: number): Uint8Array {
  return nodeCryptoInternal.getRandomValues(new Uint8Array(n));
}

// Phantom brand: a string-literal key that is never read at runtime. (A
// `unique symbol` brand cannot be named by declaration emit; the literal key
// is equally opaque for type-level domain separation.)
export type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
// Domain-prefixed ULIDs.
// ---------------------------------------------------------------------------

const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/; // Crockford base32, no I/L/O/U

export const ULID_PREFIXES = {
  MissionId: "mis_",
  RecordId: "rec_",
  GrantId: "grt_",
  StageId: "stg_",
  CriterionId: "cri_",
} as const;

export type IdDomain = keyof typeof ULID_PREFIXES;

/** Generates a fresh ULID body (48-bit ms timestamp + 80 bits of CSPRNG
 *  entropy, Crockford base32, exactly 26 chars). Pure data generation — no
 *  world effects. */
export function ulidBody(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > 281474976710655) {
    throw new RangeError("ulid timestamp out of range");
  }
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = BigInt(now);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[Number(t % 32n)]! + out;
    t = t / 32n;
  }
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i]! % 32]!;
  }
  return out;
}

function idSchema<K extends IdDomain>(domain: K) {
  const prefix = ULID_PREFIXES[domain];
  return z
    .string()
    .length(prefix.length + 26)
    .regex(new RegExp(`^${prefix}${ULID_BODY.source.slice(1)}`), `${domain} must be "${prefix}" + 26-char ULID`)
    .transform((v) => v as Brand<string, K>);
}

export const MissionIdSchema = idSchema("MissionId");
export const RecordIdSchema = idSchema("RecordId");
export const GrantIdSchema = idSchema("GrantId");
export const StageIdSchema = idSchema("StageId");
export const CriterionIdSchema = idSchema("CriterionId");

export type MissionId = z.infer<typeof MissionIdSchema>;
export type RecordId = z.infer<typeof RecordIdSchema>;
export type GrantId = z.infer<typeof GrantIdSchema>;
export type StageId = z.infer<typeof StageIdSchema>;
export type CriterionId = z.infer<typeof CriterionIdSchema>;

// ---------------------------------------------------------------------------
// Hashes, timestamps, sequences.
// ---------------------------------------------------------------------------

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Sha256Hex must be 64 lowercase hex chars")
  .transform((v) => v as Brand<string, "Sha256Hex">);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** UTC ISO-8601, second or millisecond precision, "Z" only. */
export const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, "Iso8601 must be UTC ISO-8601 with Z")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Iso8601 must be a real date")
  .transform((v) => v as Brand<string, "Iso8601">);
export type Iso8601 = z.infer<typeof Iso8601Schema>;

export const SeqSchema = z
  .number()
  .int()
  .min(1)
  .refine(Number.isSafeInteger, "seq must be a safe integer")
  .transform((v) => v as Brand<number, "Seq">);
export type Seq = z.infer<typeof SeqSchema>;

export const AuthorSchema = z.enum(["runtime", "model", "user"]);
export type Author = z.infer<typeof AuthorSchema>;

/** Justified unconstrained shape (DATA-CONTRACTS §0): user-controlled content,
 *  never executed, never authority-bearing. Bounded at use sites by C-5. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(65536),
    z.number().refine((n) => Number.isFinite(n), "JSON numbers must be finite"),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).max(256),
    z
      .record(JsonValueSchema)
      .refine((o) => Object.keys(o).length <= 256, "object keys must be ≤ 256"),
  ]),
);

// ---------------------------------------------------------------------------
// Constraint vocabulary (§1).
// ---------------------------------------------------------------------------

export const WORKSPACE_PATH_MAX = 1024;
export const WorkspacePathSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_PATH_MAX)
  .refine((s) => !s.includes("\0"), "path must not contain NUL")
  .refine((s) => !s.includes("\\"), "path must be POSIX-style (no backslash)")
  .refine((s) => !s.startsWith("/"), "path must be workspace-relative")
  .refine((s) => !s.split("/").includes(".."), "path must not traverse upward")
  .refine((s) => !s.endsWith("/"), "path must not end with a separator")
  .transform((v) => v as Brand<string, "WorkspacePath">);
export type WorkspacePath = z.infer<typeof WorkspacePathSchema>;

export const ARGV_MAX_ELEMENTS = 64;
export const ARGV_ELEMENT_MAX = 8192;
export const ArgvSchema = z
  .array(z.string().min(1).max(ARGV_ELEMENT_MAX))
  .min(1)
  .max(ARGV_MAX_ELEMENTS)
  .transform((a) => a as unknown as Argv);
export type Argv = readonly [string, ...string[]];

export const ArgvClassSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("argv-prefix"),
    segments: z.array(z.string().min(1).max(256)).min(1).max(16),
  }),
  z.object({
    kind: z.literal("argv-regex"),
    anchors: z
      .array(z.string().max(256).refine(anchoredRegexCompiles, "anchor must be an anchored, compilable regex").nullable())
      .min(1)
      .max(16),
  }),
  z.object({
    kind: z.literal("exact"),
    argv: z.array(z.string().min(1).max(4096)).min(1).max(16),
  }),
]);
export type ArgvClass = z.infer<typeof ArgvClassSchema>;

/** Anchors are matched against whole argv elements, so every regex string must
 *  be explicitly anchored ("^...$") — a non-anchored expression would silently
 *  become a substring match at the Gate. */
function anchoredRegexCompiles(s: string): boolean {
  if (!s.startsWith("^") || !s.endsWith("$") || s.length < 3) return false;
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

export const HostPatternSchema = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'host must be a hostname or "*.suffix" form',
  )
  .transform((v) => v as Brand<string, "HostPattern">);
export type HostPattern = z.infer<typeof HostPatternSchema>;

export const SecretNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/, "secret name: lowercase segments, optional '/' grouping")
  .transform((v) => v as Brand<string, "SecretName">);
export type SecretName = z.infer<typeof SecretNameSchema>;

export const HttpMethodSchema = z.enum(["GET", "HEAD"]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

export const ConstraintsSchema = z
  .object({
    paths: z.array(WorkspacePathSchema).max(64).optional(),
    argvClass: ArgvClassSchema.optional(),
    hosts: z.array(HostPatternSchema).max(32).optional(),
    methods: z.array(HttpMethodSchema).max(4).optional(),
    secretNames: z.array(SecretNameSchema).max(32).optional(),
    exclusive: z.boolean().optional(),
    mcpTools: z.array(z.string().min(1).max(128)).max(64).optional(),
    mcpServers: z.array(z.string().min(1).max(64)).max(32).optional(),
    allowHostExecution: z.boolean().optional(),
    isolationProfile: z.enum(["sandboxed", "sandboxed-network", "host"]).optional(),
  })
  .strict();
export type Constraints = z.infer<typeof ConstraintsSchema>;

// ---------------------------------------------------------------------------
// Canonical JSON is defined in src/codec/canonicalJson.ts; the rule it
// implements is documented there and in DATA-CONTRACTS.md (M0 correction,
// ADR-007): RFC 8785 (JCS) — lexicographic key order by UTF-16 code units,
// ECMAScript number formatting, minimal string escaping, no whitespace.
// ---------------------------------------------------------------------------
