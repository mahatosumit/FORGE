// FORGE capabilities — doc_parse.
// Governed document and multimodal ingestion capability.
// Executes approved file parses through the document engine, captures results
// as content-addressed artifacts, and records runtime-authored observations.

import type { CapabilityImpl, DispatchContext } from "../capability-host/types.js";
import type { Proposal } from "../contracts/index.js";
import { CapabilityManifestSchema } from "../contracts/grants.js";
import { parseDocument } from "../document/index.js";

export const docParseImpl: CapabilityImpl = {
  manifest: CapabilityManifestSchema.parse({
    id: "doc_parse",
    version: "1.0.0",
    purpose: "safely parse and extract structured text, tables, and metadata from documents (PDF, DOCX, PPTX, XLSX, CSV, JSON, Markdown, images)",
    environments: ["local", "container"],
    proposalKind: "doc_parse",
    constraintsVocab: ["paths"],
    concurrency: "parallel",
    idempotent: true,
    riskClass: ["read"],
    provenance: { pack: "core", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
  }),

  async run(proposal: Proposal, ctx: DispatchContext, opts: { timeoutMs: number; signal: AbortSignal }) {
    if (proposal.capability !== "doc_parse") throw new Error("mismatch");
    const { path, mode, maxBytes, pages, sheet, includeImages } = proposal.args;
    const startTime = Date.now();

    let bytes: Uint8Array;
    try {
      const limit = maxBytes ?? 50 * 1024 * 1024;
      if (typeof ctx.environment.stat === "function") {
        const fileStat = ctx.environment.stat(path);
        if (fileStat.size > limit) {
          throw new Error(`file size (${fileStat.size} bytes) exceeds maximum limit (${limit} bytes)`);
        }
      }
      bytes = ctx.environment.readFile(path);
      if (bytes.byteLength > limit) {
        throw new Error(`file size (${bytes.byteLength} bytes) exceeds maximum limit (${limit} bytes)`);
      }
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = `unable to read file "${path}": ${String(err instanceof Error ? err.message : err)}`;
      const errBytes = new TextEncoder().encode(JSON.stringify({ error: errorMsg }, null, 2));
      const contentRef = ctx.capture(errBytes);

      return {
        observationKind: "observation.doc_parse" as const,
        observation: {
          path,
          mime: "application/octet-stream",
          parser: "environment-fs",
          parserVersion: "1.0.0",
          status: "parse_error" as const,
          byteLength: 0,
          contentRef,
          error: errorMsg,
          truncated: false,
          durationMs,
        },
      };
    }

    const parseResult = await parseDocument(bytes, path, {
      mode,
      maxBytes,
      pages,
      sheet,
      includeImages,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    const durationMs = Date.now() - startTime;

    // Capture extracted content into content-addressed artifact store (inherits secret redaction)
    let contentRef: string | null = null;
    if (parseResult.content) {
      const contentBytes = new TextEncoder().encode(parseResult.content);
      contentRef = ctx.capture(contentBytes);
    } else if (parseResult.error) {
      const errBytes = new TextEncoder().encode(JSON.stringify({ error: parseResult.error }, null, 2));
      contentRef = ctx.capture(errBytes);
    }

    const observation: Record<string, unknown> = {
      path,
      mime: parseResult.mime,
      parser: parseResult.parser,
      parserVersion: parseResult.parserVersion,
      status: parseResult.status,
      byteLength: parseResult.byteLength,
      contentRef,
      error: parseResult.error ?? null,
      truncated: parseResult.truncated,
      durationMs,
    };
    if (parseResult.pageCount !== undefined) observation["pageCount"] = parseResult.pageCount;
    if (parseResult.sheetCount !== undefined) observation["sheetCount"] = parseResult.sheetCount;
    if (parseResult.imageCount !== undefined) observation["imageCount"] = parseResult.imageCount;
    if (parseResult.metadata !== undefined) observation["metadata"] = parseResult.metadata;

    return {
      observationKind: "observation.doc_parse" as const,
      observation,
    };
  },
};
