// search-readpath.test.ts — scoped read via search pathPrefix:
// models must be able to read one exact file (empty query + pathPrefix)
// without flooding context with the whole workspace.

import test from "node:test";
import assert from "node:assert/strict";
import { searchImpl } from "../../src/capabilities/index.js";
import { ProposalSchema } from "../../src/contracts/proposals.js";
import { parseBody } from "../../src/contracts/records.js";
import type { DispatchContext } from "../../src/capability-host/types.js";
import type { Environment, DirEntry } from "../../src/contracts/env.js";
import type { WorkspacePath } from "../../src/contracts/base.js";

function mockEnv() {
  const tree: Record<string, DirEntry[]> = {
    ".": [
      { name: "src", isDirectory: true, isFile: false },
      { name: "README.md", isDirectory: false, isFile: true },
      { name: ".forge", isDirectory: true, isFile: false },
    ],
    "src": [
      { name: "index.ts", isDirectory: false, isFile: true },
      { name: "utils.ts", isDirectory: false, isFile: true },
    ],
  };
  const files: Record<string, string> = {
    "README.md": "# Sample Project\nWelcome to FORGE.",
    "src/index.ts": "import { add } from './utils.js';\nexport const main = () => add(1, 2);",
    "src/utils.ts": "export function add(a: number, b: number) { return a + b; }",
  };
  const readDirCalls: string[] = [];
  const env: Environment = {
    identity: { type: "local", hostFingerprint: "0".repeat(64) as never },
    exec: async () => { throw new Error("not implemented"); },
    output: () => { throw new Error("not implemented"); },
    putFile: () => { throw new Error("not implemented"); },
    realpath: (p) => p,
    readDir: (p: WorkspacePath): DirEntry[] => {
      readDirCalls.push(p);
      return tree[p] ?? [];
    },
    readFile: (p: WorkspacePath): Uint8Array => {
      const content = files[p];
      if (content === undefined) throw new Error(`file not found: ${p}`);
      return new TextEncoder().encode(content);
    },
  };
  return { env, readDirCalls };
}

function makeCtx(env: Environment): { ctx: DispatchContext; getCaptured: () => string } {
  let captured: Uint8Array | null = null;
  const ctx: DispatchContext = {
    workspaceRoot: "/mock/root",
    environment: env,
    environmentKind: "local",
    secrets: new Map(),
    capture: (bytes: Uint8Array) => {
      captured = bytes;
      return "hash123";
    },
    artifactBytes: () => null,
    criterionResolver: () => null,
    signal: new AbortController().signal,
  };
  return { ctx, getCaptured: () => new TextDecoder().decode(captured ?? new Uint8Array()) };
}

test("search pathPrefix: empty query reads one exact file (no workspace flood)", async () => {
  const { env, readDirCalls } = mockEnv();
  const { ctx, getCaptured } = makeCtx(env);
  const res = await searchImpl.run(
    { capability: "search", args: { mode: "grep", query: "", pathPrefix: "src/utils.ts" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  assert.equal(res.observationKind, "observation.search");
  const out = getCaptured();
  assert.ok(out.includes("src/utils.ts:1: export function add"));
  assert.ok(!out.includes("README.md"), "must not include files outside pathPrefix");
  assert.ok(!readDirCalls.includes("."), "exact file read must not walk the workspace root");
});

test("search pathPrefix: directory prefix scopes the walk", async () => {
  const { env } = mockEnv();
  const { ctx, getCaptured } = makeCtx(env);
  await searchImpl.run(
    { capability: "search", args: { mode: "grep", query: "", pathPrefix: "src" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  const out = getCaptured();
  assert.ok(out.includes("src/index.ts"));
  assert.ok(out.includes("src/utils.ts"));
  assert.ok(!out.includes("README.md"));
});

test("search pathPrefix with glob mode filters by prefix", async () => {
  const { env } = mockEnv();
  const { ctx, getCaptured } = makeCtx(env);
  await searchImpl.run(
    { capability: "search", args: { mode: "glob", query: "*.md", pathPrefix: "src" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  const out = getCaptured();
  assert.ok(!out.includes("README.md"), "glob outside prefix must be excluded");
});

test("search schema: empty query requires pathPrefix; scoped read is valid", () => {
  const noPrefix = ProposalSchema.safeParse({ capability: "search", args: { mode: "grep", query: "" } });
  assert.equal(noPrefix.success, false);

  const scoped = ProposalSchema.safeParse({ capability: "search", args: { mode: "grep", query: "", pathPrefix: "src/a.ts" } });
  assert.equal(scoped.success, true);

  const normal = ProposalSchema.safeParse({ capability: "search", args: { mode: "grep", query: "add" } });
  assert.equal(normal.success, true);
});

test("observation.search record: empty query (scoped read result) is appendable", () => {
  // Regression: proposal allowed empty query via pathPrefix, but the record
  // schema still demanded min(1) — observation append threw mid-dispatch.
  const body = parseBody("observation.search", {
    mode: "grep",
    query: "",
    matchCount: 3,
    resultsRef: null,
  });
  assert.equal(body.query, "");
});
