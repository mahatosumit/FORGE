// search-env.test.ts — P3-2 & P3-3 unit tests:
// 1. searchImpl routes all directory walking through ctx.environment.readDir
// 2. searchImpl routes all file reading through ctx.environment.readFile
// 3. searchImpl operates purely through environment indirection (in-memory mock works without node:fs)
// 4. LocalEnvironment readDir & truncation detection at exact maxBuffer boundary

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchImpl } from "../../src/capabilities/index.js";
import { LocalEnvironment, OUTPUT_MAX_BYTES } from "../../src/environments/local.js";
import type { DispatchContext } from "../../src/capability-host/types.js";
import type { Environment, DirEntry } from "../../src/contracts/env.js";
import type { WorkspacePath } from "../../src/contracts/base.js";

test("P3-3: searchImpl operates purely via ctx.environment readDir and readFile (in-memory mock)", async () => {
  const tree: Record<string, DirEntry[]> = {
    ".": [
      { name: "src", isDirectory: true, isFile: false },
      { name: "README.md", isDirectory: false, isFile: true },
      { name: ".forge", isDirectory: true, isFile: false }, // should be ignored
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
  const readFileCalls: string[] = [];

  const mockEnv: Environment = {
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
      readFileCalls.push(p);
      const content = files[p];
      if (content === undefined) throw new Error(`file not found: ${p}`);
      return new TextEncoder().encode(content);
    },
  };

  let captured: Uint8Array | null = null;
  const ctx: DispatchContext = {
    workspaceRoot: "/mock/root",
    environment: mockEnv,
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

  // 1. Test glob mode (matches src/*.ts)
  const globRes = await searchImpl.run(
    { capability: "search", args: { mode: "glob", query: "src/*.ts" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  assert.equal(globRes.observationKind, "observation.search");
  const globOutput = new TextDecoder().decode(captured!);
  assert.ok(globOutput.includes("src/index.ts"));
  assert.ok(globOutput.includes("src/utils.ts"));
  assert.ok(!globOutput.includes("README.md"));

  // Test root glob mode (matches *.md)
  await searchImpl.run(
    { capability: "search", args: { mode: "glob", query: "*.md" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  const globMdOutput = new TextDecoder().decode(captured!);
  assert.ok(globMdOutput.includes("README.md"));
  assert.ok(!globMdOutput.includes("src/index.ts"));

  // 2. Test text search mode
  const textRes = await searchImpl.run(
    { capability: "search", args: { mode: "text", query: "Welcome" } },
    ctx,
    { timeoutMs: 5000, signal: new AbortController().signal },
  );
  assert.equal(textRes.observationKind, "observation.search");
  const textOutput = new TextDecoder().decode(captured!);
  assert.ok(textOutput.includes("README.md:2: Welcome to FORGE."));

  // Verify that readDir and readFile were strictly called through mockEnv
  assert.ok(readDirCalls.includes("."));
  assert.ok(readDirCalls.includes("src"));
  assert.ok(readFileCalls.includes("README.md"));
  assert.ok(readFileCalls.includes("src/index.ts"));
  assert.ok(readFileCalls.includes("src/utils.ts"));
});

test("P3-3: LocalEnvironment readDir returns structured directory entries", () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-readdir-"));
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "sub", "test.txt"), "hello");
  writeFileSync(join(ws, "root.txt"), "root");

  const env = new LocalEnvironment(ws);
  const rootEntries = env.readDir("." as WorkspacePath);
  assert.ok(rootEntries.some((e) => e.name === "sub" && e.isDirectory && !e.isFile));
  assert.ok(rootEntries.some((e) => e.name === "root.txt" && !e.isDirectory && e.isFile));

  const subEntries = env.readDir("sub" as WorkspacePath);
  assert.ok(subEntries.some((e) => e.name === "test.txt" && !e.isDirectory && e.isFile));

  rmSync(ws, { recursive: true, force: true });
});

test("P3-2: LocalEnvironment exec detects truncation when output exceeds or hits maxBuffer", async () => {
  const ws = mkdtempSync(join(tmpdir(), "forge-trunc-"));
  const env = new LocalEnvironment(ws);

  // Command that produces > 2MB of output
  const res = await env.exec({
    argv: ["node", "-e", "process.stdout.write('A'.repeat(2 * 1024 * 1024 + 100))"],
    cwd: "." as WorkspacePath,
    timeoutMs: 10000,
    env: new Map(),
    signal: new AbortController().signal,
  });

  const out = env.output(res.outputHandle);
  assert.equal(out.truncated, true, "Output exceeding maxBuffer must be flagged as truncated");
  assert.ok(out.bytes.byteLength <= OUTPUT_MAX_BYTES);

  rmSync(ws, { recursive: true, force: true });
});
