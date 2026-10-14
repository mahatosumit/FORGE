// schema.test.ts — every record kind validates; authorship matrix enforced;
// extra fields rejected; bounded model-controlled fields enforced; every
// discriminated union branch of Proposal / CriterionExpr / ModelEvent parses.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RecordSchema,
  RecordKindSchema,
  AUTHORSHIP,
  authorshipAllows,
  parseBody,
  ProposalSchema,
  CriterionExprSchema,
  ModelEventSchema,
  ModelMessageSchema,
  GrantSchema,
  ConstraintsSchema,
  verifyContentEvent,
  CONTENT_EVENT_MAX_DECODED,
  type RecordKind,
} from "../../src/contracts/index.js";
import { authorFor, bodyFixtures, makeRecord, ALL_KINDS, RECORD_ID_1 } from "../helpers/fixtures.js";

test("every record kind has a body fixture and validates", () => {
  assert.equal(ALL_KINDS.length, RecordKindSchema.options.length, "fixture/kind count mismatch");
  for (const kind of ALL_KINDS) {
    const rec = makeRecord(kind);
    const parsed = RecordSchema.parse(rec);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.author, authorFor[kind]);
  }
});

test("unknown record kinds are unrepresentable (closed enum)", () => {
  const rec = makeRecord("claim.asserted", { body: undefined }) as Record<string, unknown>;
  rec.kind = "observation.telepathy";
  rec.body = { statement: "x", citations: [RECORD_ID_1] };
  assert.throws(() => RecordSchema.parse(rec));
});

test("extra fields are rejected on record envelopes (strict)", () => {
  const rec = makeRecord("claim.asserted") as Record<string, unknown>;
  rec.sneaky = true;
  assert.throws(() => RecordSchema.parse(rec));
});

test("C-2: authorship matrix — every (kind, wrong author) pair is rejected", () => {
  const authors = ["runtime", "model", "user"] as const;
  for (const kind of ALL_KINDS) {
    const allowed = AUTHORSHIP[kind];
    for (const author of authors) {
      if (allowed.includes(author)) continue;
      assert.equal(
        authorshipAllows(kind, author),
        false,
        `${kind} must reject author ${author}`,
      );
      // and the C-2 validator agrees after structural parse:
      const rec = { ...makeRecord(kind), author };
      const parsed = RecordSchema.parse(rec);
      assert.equal(authorshipAllows(parsed.kind, parsed.author, parsed.body), false);
    }
  }
});

test("C-2: criterion.defined origin↔author consistency", () => {
  assert.equal(authorshipAllows("criterion.defined", "model", { origin: "model-proposed" }), true);
  assert.equal(authorshipAllows("criterion.defined", "model", { origin: "user" }), false);
  assert.equal(authorshipAllows("criterion.defined", "user", { origin: "user" }), true);
  assert.equal(authorshipAllows("criterion.defined", "user", { origin: "model-proposed" }), false);
  assert.equal(authorshipAllows("criterion.defined", "runtime", { origin: "model-proposed" }), false);
});

test("proposal union: every variant validates", () => {
  const proposals = [
    { capability: "fs", args: { op: "write", path: "src/a.ts", contentRef: "a".repeat(64) } },
    { capability: "fs", args: { op: "append", path: "src/a.ts", contentRef: "a".repeat(64) } },
    { capability: "fs", args: { op: "patch", path: "src/a.ts", patch: "--- a\n+++ b\n" } },
    { capability: "fs", args: { op: "mkdir", path: "src/dir" } },
    { capability: "shell", args: { argv: ["npm", "test"], cwd: "." } },
    { capability: "git", args: { op: "commit", message: "fix: cart" } },
    { capability: "http", args: { method: "GET", url: "https://x.example.com/", maxBytes: 1024 } },
    { capability: "search", args: { query: "totals", mode: "grep" } },
    { capability: "verify", args: { criterionRef: "cri_01HZZ000000000000000000001" } },
    { capability: "artifact", args: { op: "put", contentRef: "a".repeat(64) } },
    { capability: "web_search", args: { query: "node js documentation" } },
    { capability: "web_fetch", args: { url: "https://nodejs.org/docs" } },
    { capability: "mcp_call", args: { serverId: "github", toolName: "list_issues", arguments: { repo: "forge" } } },
    { capability: "doc_parse", args: { path: "docs/spec.pdf", mode: "markdown" } },
  ];
  for (const p of proposals) assert.doesNotThrow(() => ProposalSchema.parse(p));
});

test("C-3: proposal carrying timeout / grant / risk / approval fields is rejected", () => {
  assert.throws(() =>
    ProposalSchema.parse({
      capability: "shell",
      args: { argv: ["npm", "test"], cwd: ".", timeoutMs: 5 },
    }),
  );
  assert.throws(() =>
    ProposalSchema.parse({
      capability: "shell",
      args: { argv: ["npm", "test"], cwd: "." },
      grantId: "grt_01HZZ000000000000000000001",
    }),
  );
  assert.throws(() =>
    ProposalSchema.parse({
      capability: "shell",
      args: { argv: ["npm", "test"], cwd: "." },
      risk: "low",
      approved: true,
    }),
  );
});

test("proposal: fs contentRef/patch pairing enforced", () => {
  assert.throws(() => ProposalSchema.parse({ capability: "fs", args: { op: "patch", path: "p", patch: "x", contentRef: "a".repeat(64) } }));
  assert.throws(() => ProposalSchema.parse({ capability: "fs", args: { op: "write", path: "p" } }));
  assert.throws(() => ProposalSchema.parse({ capability: "fs", args: { op: "mkdir", path: "p", contentRef: "a".repeat(64) } }));
});

test("proposal: fake capability name dies at the schema", () => {
  assert.throws(() =>
    ProposalSchema.parse({ capability: "telepathy", args: {} }),
  );
});

test("criterion expression union: every variant validates", () => {
  const exprs = [
    { kind: "command-exit", argv: ["npm", "test"], expect: 0 },
    { kind: "test-suite", argv: ["npm", "test"] },
    { kind: "file-state", path: "src/a.ts", expect: "exists" },
    { kind: "file-state", path: "src/a.ts", expect: "hash", hash: "a".repeat(64) },
    { kind: "file-state", path: "src/a.ts", expect: "diff-contains", pattern: "x" },
    { kind: "artifact-exists", hash: "a".repeat(64) },
    { kind: "reproducible", argv: ["python", "analyze.py"], outputHash: "a".repeat(64) },
    { kind: "http", url: "https://x.example.com/health", expectStatus: 200 },
    { kind: "adjudicate", question: "is the fix coherent?", judges: ["user"] },
    { kind: "adjudicate", question: "is the fix coherent?", judges: ["model", "user"] },
  ];
  for (const e of exprs) assert.doesNotThrow(() => CriterionExprSchema.parse(e));
});

test("criterion expression: hash/pattern pairing enforced; bad status rejected", () => {
  assert.throws(() => CriterionExprSchema.parse({ kind: "file-state", path: "p", expect: "hash" }));
  assert.throws(() => CriterionExprSchema.parse({ kind: "http", url: "https://x/", expectStatus: 42 }));
});

test("model event union: every variant validates", () => {
  const events = [
    { type: "text-delta", text: "hello" },
    {
      type: "proposal",
      proposal: { capability: "shell", args: { argv: ["npm", "test"], cwd: "." } },
      meta: { rationale: "r", citations: [RECORD_ID_1] },
    },
    { type: "claim", statement: "s", citations: [RECORD_ID_1] },
    { type: "content", sha256: "a".repeat(64), base64: Buffer.from("hello").toString("base64") },
    { type: "usage", tokensIn: 1, tokensOut: 2 },
    { type: "error", error: { code: "RateLimited", message: "slow down" } },
  ];
  for (const e of events) assert.doesNotThrow(() => ModelEventSchema.parse(e));
});

test("content event: hash verification (correct, incorrect, oversized, malformed)", () => {
  const bytes = Buffer.from("forge content");
  const good = {
    type: "content" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
  const verified = verifyContentEvent(good as never);
  assert.equal(verified.ok, true);
  assert.equal(verified.bytes, bytes.byteLength);

  const badHash = { ...good, sha256: "b".repeat(64) };
  assert.equal(verifyContentEvent(badHash as never).ok, false);

  // oversized: just above the 2 MiB cap must fail schema validation
  const tooBig = Buffer.alloc(CONTENT_EVENT_MAX_DECODED + 1, 7).toString("base64");
  assert.throws(() =>
    ModelEventSchema.parse({ type: "content", sha256: "a".repeat(64), base64: tooBig }),
  );

  // malformed base64
  assert.throws(() =>
    ModelEventSchema.parse({ type: "content", sha256: "a".repeat(64), base64: "!!!" }),
  );

  // duplicate content verifies identically (value-based, dedup is not codec's job)
  const again = verifyContentEvent(good as never);
  assert.equal(again.ok, true);
  assert.equal(again.actualSha256, verified.actualSha256);
});

test("C-5 size bounds: rationale, statement, claim citations, maxBytes", () => {
  const big = (n: number) => "x".repeat(n);
  // rationale ≤ 4096
  assert.throws(() =>
    ProposalMetaParse({ rationale: big(4097), citations: [] }),
  );
  // statement ≤ 8192
  assert.throws(() =>
    ModelEventSchema.parse({ type: "claim", statement: big(8193), citations: [RECORD_ID_1] }),
  );
  // http.maxBytes ≤ 10 MiB
  assert.throws(() =>
    ProposalSchema.parse({
      capability: "http",
      args: { method: "GET", url: "https://x/", maxBytes: 10 * 1024 * 1024 + 1 },
    }),
  );
  // model message ≤ 256 KiB
  assert.throws(() =>
    ModelMessageSchema.parse({ role: "user", content: big(256 * 1024 + 1), provenance: "runtime-framing" }),
  );
});

function ProposalMetaParse(x: unknown) {
  // rationale is validated inside proposal.received bodies and ModelEvent
  return parseBody("proposal.received", {
    proposal: { capability: "shell", args: { argv: ["npm", "test"], cwd: "." } },
    meta: x,
  });
}

test("path policy at the contract layer: traversal, backslash, NUL, absolute", () => {
  const bad = ["../etc/passwd", "a/../b", "/abs", "C:\\x", "a\0b", "dir/"];
  for (const p of bad) {
    assert.throws(() => ConstraintsSchema.parse({ paths: [p] }), undefined, `path ${p} must be rejected`);
  }
});

test("malformed ids, hashes, timestamps rejected", () => {
  const rec = makeRecord("claim.asserted") as Record<string, unknown>;
  rec.id = "not-an-id";
  assert.throws(() => RecordSchema.parse(rec));
  rec.id = makeRecord("claim.asserted").id;
  rec.ts = "2026-10-04 12:00:00"; // missing T/Z
  assert.throws(() => RecordSchema.parse(rec));
  rec.ts = "2026-13-01T00:00:00.000Z"; // not a real date
  assert.throws(() => RecordSchema.parse(rec));
  rec.ts = makeRecord("claim.asserted").ts;
  rec.prevHash = "ZZ".repeat(32); // not hex
  assert.throws(() => RecordSchema.parse(rec));
});

test("grant: parent linkage and issuer enum enforced", () => {
  const grant = {
    id: "grt_01HZZ000000000000000000001",
    missionId: "mis_01HZZ000000000000000000001",
    capability: "shell",
    constraints: { argvClass: { kind: "argv-prefix", segments: ["npm", "test"] } },
    expiresAt: null,
    issuer: "envelope",
    parentGrantId: null,
  };
  assert.doesNotThrow(() => GrantSchema.parse(grant));
  assert.throws(() => GrantSchema.parse({ ...grant, issuer: "the-model" }));
  assert.throws(() => GrantSchema.parse({ ...grant, parentGrantId: "rec_01HZZ000000000000000000002" }));
  assert.throws(() => GrantSchema.parse({ ...grant, extra: true }));
});
