// FORGE capabilities — the seven v1 built-ins (CAPABILITIES.md).
// Each: manifest + run(). A capability NEVER calls another capability, never
// authors observations itself (the host appends), never creates authority.
// Idempotency declarations drive post-effect-unknown recovery (ADR-006).

import { createHash } from "node:crypto";
import type { CapabilityImpl } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import type { DispatchContext } from "../capability-host/types.js";
import type { CapabilityManifest } from "../capability-host/types.js";
import { CapabilityManifestSchema } from "../contracts/grants.js";
import type { Argv } from "../contracts/base.js";
import { sha256Hex, OUTPUT_MAX_BYTES } from "../environments/local.js";
import { httpImpl } from "./http.js";
import { webSearchImpl, webFetchImpl } from "./web.js";
import { mcpCallImpl, mcpServerStartImpl, mcpServerStopImpl } from "./mcp.js";
export { mcpCallImpl, mcpServerStartImpl, mcpServerStopImpl } from "./mcp.js";
import { docParseImpl } from "./doc.js";
export { docParseImpl } from "./doc.js";

function manifest(m: import("zod").input<typeof CapabilityManifestSchema>) {
  return CapabilityManifestSchema.parse(m);
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// fs — write / append / patch / mkdir (idempotent: atomic putFile, same content
// = same result). Patch = minimal unified-diff apply (exact context match).
// ---------------------------------------------------------------------------

export function applyUnifiedDiff(original: string, diff: string): string {
  const lines = original.split("\n");
  const diffLines = diff.split("\n");
  let idx = 0;
  const out: string[] = [];
  let i = 0;
  let applied = 0;
  while (i < diffLines.length) {
    const line = diffLines[i]!;
    const hunkMatch = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (!hunkMatch) {
      i++;
      continue;
    }
    applied++;
    const start = parseInt(hunkMatch[1]!, 10);
    // copy unchanged lines up to the hunk
    while (idx < start - 1 && idx < lines.length) out.push(lines[idx++]!);
    i++;
    const hunk: string[] = [];
    while (i < diffLines.length && !diffLines[i]!.startsWith("@@")) hunk.push(diffLines[i++]!);
    for (const h of hunk) {
      if (h.startsWith("-")) {
        // verify the removed line matches the original (exact context match)
        if (idx >= lines.length || lines[idx] !== h.slice(1)) {
          throw new Error(`patch context mismatch at original line ${idx + 1}`);
        }
        idx++; // drop the removed line
      } else if (h.startsWith("+")) {
        out.push(h.slice(1));
      } else if (h.startsWith(" ") || h === "") {
        if (idx < lines.length) out.push(lines[idx++]!);
      }
    }
  }
  if (applied === 0) throw new Error("no hunks in diff");
  while (idx < lines.length) out.push(lines[idx++]!);
  return out.join("\n");
}

const fsImpl: CapabilityImpl = {
  manifest: manifest({
    id: "fs", version: "1.0.0", purpose: "read-write files in the workspace (mutations)",
    environments: ["local", "container"], proposalKind: "fs",
    constraintsVocab: ["paths", "exclusive"], concurrency: "parallel",
    idempotent: true, riskClass: ["write"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "fs") throw new Error("mismatch");
    const { op, path, contentRef, patch, expectedBeforeHash } = proposal.args;
    let beforeHash: string | null = null;
    let afterBytes: Uint8Array;
    try {
      const before = ctx.environment.readFile(path);
      beforeHash = sha(before);
    } catch {
      beforeHash = null; // file does not exist yet
    }
    switch (op) {
      case "write": {
        if (expectedBeforeHash !== undefined && beforeHash !== expectedBeforeHash) {
          throw new Error(
            `CAS precondition failed on "${path}": expectedBeforeHash was "${expectedBeforeHash ?? "null"}", but actual beforeHash is "${beforeHash ?? "null"}" (EFFECT_UNKNOWN)`,
          );
        }
        const bytes = ctx.artifactBytes(contentRef!);
        if (!bytes) throw new Error(`content ${contentRef} not found in artifact staging`);
        afterBytes = bytes;
        break;
      }
      case "append": {
        const addition = ctx.artifactBytes(contentRef!);
        if (!addition) throw new Error(`content ${contentRef} not found in artifact staging`);
        const prior = beforeHash !== null ? ctx.environment.readFile(path) : new Uint8Array();
        afterBytes = new Uint8Array([...prior, ...addition]);
        break;
      }
      case "patch": {
        if (beforeHash === null) throw new Error(`cannot patch nonexistent file ${path}`);
        const original = new TextDecoder().decode(ctx.environment.readFile(path));
        const patched = applyUnifiedDiff(original, patch!);
        afterBytes = new TextEncoder().encode(patched);
        break;
      }
      case "mkdir": {
        afterBytes = new Uint8Array(0);
        break;
      }
    }
    let afterHash: string;
    if (op === "mkdir") {
      // directories have no content hash; hash the path identity
      afterHash = sha(new TextEncoder().encode(`dir:${path}`));
    } else {
      const r = ctx.environment.putFile(path, afterBytes!);
      afterHash = r.afterHash;
    }
    // capture the diff as evidence when content changed
    let diffRef: string | null = null;
    const beforeText = beforeHash !== null ? new TextDecoder().decode(ctx.environment.readFile(path)) : "";
    void beforeText; // (post-write read shows after-state; diff captured from inputs)
    const diffText = op === "patch" ? patch! : op === "write" || op === "append" ? "(content write)" : "(mkdir)";
    diffRef = ctx.capture(new TextEncoder().encode(diffText));
    return {
      observationKind: "observation.fs",
      observation: { op, path, beforeHash, afterHash, diffRef },
    };
  },
};

// ---------------------------------------------------------------------------
// shell — execute an argv vector in the environment (no shell interpreter)
// ---------------------------------------------------------------------------

export const shellImpl: CapabilityImpl = {
  manifest: manifest({
    id: "shell", version: "1.0.0", purpose: "execute commands in an environment (argv only, no shell)",
    environments: ["local", "container"], proposalKind: "shell",
    constraintsVocab: ["argvClass"], concurrency: "exclusive",
    idempotent: false, riskClass: ["execute"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal; isolationProfile: string }) {
    if (proposal.capability !== "shell") throw new Error("mismatch");
    const result = await ctx.environment.exec({
      argv: proposal.args.argv,
      cwd: proposal.args.cwd,
      timeoutMs: opts.timeoutMs,
      env: ctx.secrets,
      signal: opts.signal,
      isolationProfile: opts.isolationProfile,
    });
    const out = ctx.environment.output(result.outputHandle);
    const outputRef = ctx.capture(out.bytes);
    return {
      observationKind: "observation.shell",
      observation: {
        argv: proposal.args.argv,
        cwd: proposal.args.cwd,
        exit: result.exit,
        signal: result.signal,
        outputRef,
        truncated: out.truncated,
        durationMs: result.durationMs,
        envIdentity: ctx.environment.identity,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// git — narrow, op-mapped subcommand surface
// ---------------------------------------------------------------------------

export const gitImpl: CapabilityImpl = {
  manifest: manifest({
    id: "git", version: "1.0.0", purpose: "version-control state and commits",
    environments: ["local", "container"], proposalKind: "git",
    constraintsVocab: ["paths"], concurrency: "exclusive",
    idempotent: false, riskClass: ["write"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "git") throw new Error("mismatch");
    const a = proposal.args;
    const argv: Argv =
      a.op === "status" ? ["git", "status", "--porcelain"]
      : a.op === "diff" ? ["git", "diff", "--", ...(a.paths ?? [])]
      : a.op === "add" ? ["git", "add", ...(a.paths ?? [])]
      : a.op === "commit" ? ["git", "commit", "-m", a.message ?? "(forge)"]
      : ["git", "rev-parse", "HEAD"];
    const result = await ctx.environment.exec({
      argv, cwd: "." as never, timeoutMs: opts.timeoutMs, env: ctx.secrets, signal: opts.signal,
      isolationProfile: (ctx as any).isolationProfile ?? "sandboxed",
    });
    const out = ctx.environment.output(result.outputHandle);
    const outputRef = ctx.capture(out.bytes);
    let commitHash: string | null = null;
    if (a.op === "commit" || a.op === "rev-parse") {
      const first = new TextDecoder().decode(out.bytes).trim().split("\n")[0] ?? "";
      if (/^[0-9a-f]{40}$/.test(first)) commitHash = first;
    }
    return {
      observationKind: "observation.git",
      observation: { op: a.op, exit: result.exit, outputRef, commitHash, envIdentity: ctx.environment.identity },
    };
  },
};

// ---------------------------------------------------------------------------
// search — workspace grep/glob (read-only)
// ---------------------------------------------------------------------------

export const searchImpl: CapabilityImpl = {
  manifest: manifest({
    id: "search", version: "1.0.0", purpose: "search the workspace (grep/glob, read-only)",
    environments: ["local", "container"], proposalKind: "search",
    constraintsVocab: [], concurrency: "parallel",
    idempotent: true, riskClass: ["read"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "search") throw new Error("mismatch");
    const { query, mode, pathPrefix } = proposal.args;
    const results: string[] = [];

    // Scoped read: a pathPrefix confines the search to one file or subtree.
    // Empty query with a pathPrefix returns the full content (line-capped) —
    // this is the "read exact file" affordance.
    const scanFile = (childRel: string) => {
      let text: string;
      try {
        const bytes = ctx.environment.readFile(childRel as never);
        text = new TextDecoder().decode(bytes);
      } catch {
        return;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const hit = mode === "glob"
          ? matchGlob(childRel, query)
          : query.length === 0
            ? true
            : mode === "symbol"
              ? lines[i]!.includes(query)
              : lines[i]!.toLowerCase().includes(query.toLowerCase());
        if (hit) {
          results.push(mode === "glob" ? childRel : `${childRel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (results.length >= 500) return;
        }
      }
    };

    if (pathPrefix && mode !== "glob") {
      const norm = pathPrefix.replace(/\\/g, "/").replace(/^\.\//, "");
      // Try exact file first; if it's a directory, walk it scoped.
      let isFile = false;
      try {
        ctx.environment.readFile(norm as never);
        isFile = true;
      } catch {
        isFile = false;
      }
      if (isFile) {
        scanFile(norm);
        const outputRef = ctx.capture(new TextEncoder().encode(results.join("\n")));
        return {
          observationKind: "observation.search",
          observation: { mode, query, matchCount: results.length, resultsRef: outputRef },
        };
      }
      const walkScoped = (dirRel: string) => {
        const entries = ctx.environment.readDir ? ctx.environment.readDir(dirRel as never) : [];
        for (const entry of entries) {
          if (entry.name === ".forge" || entry.name === "node_modules" || entry.name === ".git") continue;
          const childRel = dirRel === "" || dirRel === "." ? entry.name : `${dirRel}/${entry.name}`;
          if (entry.isDirectory) {
            walkScoped(childRel);
            if (results.length >= 500) return;
          } else if (entry.isFile) {
            scanFile(childRel);
            if (results.length >= 500) return;
          }
        }
      };
      walkScoped(norm);
      const outputRef = ctx.capture(new TextEncoder().encode(results.join("\n")));
      return {
        observationKind: "observation.search",
        observation: { mode, query, matchCount: results.length, resultsRef: outputRef },
      };
    }

    const walk = (dirRel: string) => {
      const entries = ctx.environment.readDir ? ctx.environment.readDir(dirRel as never) : [];
      for (const entry of entries) {
        if (entry.name === ".forge" || entry.name === "node_modules" || entry.name === ".git") continue;
        const childRel = dirRel === "" || dirRel === "." ? entry.name : `${dirRel}/${entry.name}`;
        if (entry.isDirectory) {
          walk(childRel);
          if (results.length >= 500) return;
        } else if (entry.isFile) {
          if (mode === "glob") {
            if (matchGlob(childRel, query) && (!pathPrefix || childRel.startsWith(pathPrefix.replace(/\\/g, "/").replace(/^\.\//, "")))) {
              results.push(childRel);
            }
          } else {
            scanFile(childRel);
            if (results.length >= 500) return;
          }
        }
      }
    };
    walk(".");
    const outputRef = ctx.capture(new TextEncoder().encode(results.join("\n")));
    return {
      observationKind: "observation.search",
      observation: { mode, query, matchCount: results.length, resultsRef: outputRef },
    };
  },
};

function matchGlob(path: string, pattern: string): boolean {
  const re = "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$";
  return new RegExp(re).test(path);
}

// ---------------------------------------------------------------------------
// verify — run a criterion's check (command-shaped criteria exec; structural
// criteria check via environment reads). Runtime-initiated; Gate-checked.
// ---------------------------------------------------------------------------

export const verifyImpl: CapabilityImpl = {
  manifest: manifest({
    id: "verify", version: "1.0.0", purpose: "execute completion criteria (mechanical checks)",
    environments: ["local", "container"], proposalKind: "verify",
    constraintsVocab: [], concurrency: "exclusive",
    idempotent: true, riskClass: ["execute"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "verify") throw new Error("mismatch");
    const expr = ctx.criterionResolver(proposal.args.criterionRef);
    if (!expr) throw new Error(`criterion ${proposal.args.criterionRef} not found`);
    if (expr.kind === "command-exit" || expr.kind === "test-suite") {
      const result = await ctx.environment.exec({
        argv: expr.argv, cwd: "." as never, timeoutMs: opts.timeoutMs, env: ctx.secrets, signal: opts.signal,
        isolationProfile: (ctx as any).isolationProfile ?? "sandboxed",
      });
      const out = ctx.environment.output(result.outputHandle);
      const outputRef = ctx.capture(out.bytes);
      const matched = result.exit !== null && result.exit === (expr.kind === "command-exit" ? expr.expect : 0);
      return {
        observationKind: "observation.verify",
        observation: { criterionId: proposal.args.criterionRef, via: "command", command: expr.argv, exit: result.exit, outputRef, matched },
      };
    }
    if (expr.kind === "file-state") {
      let exists = true;
      let bytes: Uint8Array | null = null;
      try {
        bytes = ctx.environment.readFile(expr.path);
      } catch {
        exists = false;
      }
      let matched = expr.expect === "exists" ? exists : exists;
      if (exists && expr.expect === "hash" && bytes) matched = sha(bytes) === expr.hash;
      if (exists && expr.expect === "diff-contains" && bytes) {
        matched = new TextDecoder().decode(bytes).includes(expr.pattern!);
      }
      const outputRef = bytes ? ctx.capture(bytes.subarray(0, OUTPUT_MAX_BYTES)) : null;
      return {
        observationKind: "observation.verify",
        observation: { criterionId: proposal.args.criterionRef, via: "file-state", command: null, exit: null, outputRef, matched },
      };
    }
    if (expr.kind === "artifact-exists") {
      const present = ctx.artifactBytes(expr.hash) !== null;
      return {
        observationKind: "observation.verify",
        observation: { criterionId: proposal.args.criterionRef, via: "artifact-exists", command: null, exit: null, outputRef: present ? expr.hash : null, matched: present },
      };
    }
    // http criterion: verification of a URL happens through the http capability
    // (gated); a bare verify cannot fetch. Report as unmatched with no claim.
    return {
      observationKind: "observation.verify",
      observation: { criterionId: proposal.args.criterionRef, via: "http", command: null, exit: null, outputRef: null, matched: false },
    };
  },
};

// ---------------------------------------------------------------------------
// artifact — register a staged blob as a mission artifact
// ---------------------------------------------------------------------------

export const artifactImpl: CapabilityImpl = {
  manifest: manifest({
    id: "artifact", version: "1.0.0", purpose: "register content-addressed outputs as mission artifacts",
    environments: ["local", "container"], proposalKind: "artifact",
    constraintsVocab: ["paths"], concurrency: "parallel",
    idempotent: true, riskClass: ["write"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),
  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "artifact") throw new Error("mismatch");
    const { contentRef, path } = proposal.args;
    const bytes = ctx.artifactBytes(contentRef);
    if (!bytes) throw new Error(`content ${contentRef} not found in artifact staging`);
    const hash = sha(bytes);
    return {
      observationKind: "observation.artifact",
      observation: { hash, bytes: bytes.byteLength, sourcePath: path ?? null },
    };
  },
};

export function builtinCapabilities(): Map<string, CapabilityImpl> {
  const map = new Map<string, CapabilityImpl>();
  for (const impl of [
    fsImpl,
    shellImpl,
    gitImpl,
    httpImpl,
    searchImpl,
    verifyImpl,
    artifactImpl,
    webSearchImpl,
    webFetchImpl,
    mcpCallImpl,
    mcpServerStartImpl,
    mcpServerStopImpl,
    docParseImpl,
  ]) {
    map.set(impl.manifest.id, impl);
  }
  return map;
}

export * from "./manifests.js";
export * from "./registry.js";
export * from "./defaultRegistry.js";

