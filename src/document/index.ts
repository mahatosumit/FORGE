// FORGE Document Ingestion Engine — Unified Governed Entry Point.
// Coordinates format detection, safe parser dispatch, size enforcement, and error normalization.

import { detectFormat, type FormatDetection } from "./detect.js";
import { parsePlainText, parseCsv, parseJson, parseStructuredText } from "./text.js";
import { parseDocx, parsePptx, parseXlsx } from "./office.js";
import { parsePdf } from "./pdf.js";
import { parseImage } from "./image.js";
import type { DocParseOptions, DocParseResult } from "./types.js";
import { PARSER_LIMITS, DocumentParseError } from "./types.js";

export * from "./types.js";
export * from "./detect.js";
export * from "./text.js";
export * from "./office.js";
export * from "./pdf.js";
export * from "./image.js";

export async function parseDocument(
  bytes: Uint8Array,
  filename: string,
  opts?: DocParseOptions,
): Promise<DocParseResult> {
  const startTime = Date.now();

  // 1. Guard input file size limit
  if (bytes.byteLength > PARSER_LIMITS.DEFAULT_MAX_INPUT_BYTES) {
    return {
      mime: "application/octet-stream",
      parser: "core-guard",
      parserVersion: "1.0.0",
      status: "parse_error",
      content: "",
      byteLength: bytes.byteLength,
      error: `file size (${bytes.byteLength} bytes) exceeds maximum input bound of ${PARSER_LIMITS.DEFAULT_MAX_INPUT_BYTES} bytes`,
      truncated: false,
    };
  }

  // 2. Detect format
  const detection = detectFormat(bytes, filename);

  // 3. Spoofed extension protection
  if (detection.mismatch) {
    return {
      mime: detection.mime,
      parser: "detector",
      parserVersion: "1.0.0",
      status: "parse_error",
      content: "",
      byteLength: bytes.byteLength,
      error: `format mismatch detected: file extension does not match binary magic signatures`,
      truncated: false,
    };
  }

  // 4. Dispatch to appropriate parser
  try {
    switch (detection.subtype) {
      case "pdf":
        return parsePdf(bytes, opts);

      case "docx":
        return parseDocx(bytes, opts);

      case "pptx":
        return parsePptx(bytes, opts);

      case "xlsx":
        return parseXlsx(bytes, opts);

      case "csv":
        return parseCsv(bytes, opts);

      case "json": {
        const isJsonLines = filename.endsWith(".jsonl");
        return parseJson(bytes, isJsonLines, opts);
      }

      case "markdown":
        return parsePlainText(bytes, filename, true, opts);

      case "text":
        return parsePlainText(bytes, filename, false, opts);

      case "xml":
        return parseStructuredText(bytes, "xml", opts);

      case "yaml":
        return parseStructuredText(bytes, "yaml", opts);

      case "png":
      case "jpeg":
      case "webp":
      case "gif":
      case "bmp":
        return parseImage(bytes, detection.mime, opts);

      default:
        // Try falling back to plain text if readable
        if (detection.category === "text") {
          return parsePlainText(bytes, filename, false, opts);
        }
        return {
          mime: detection.mime,
          parser: "unsupported",
          parserVersion: "1.0.0",
          status: "unsupported_format",
          content: "",
          byteLength: bytes.byteLength,
          error: `unsupported document format for "${filename}" (${detection.mime})`,
          truncated: false,
        };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      mime: detection.mime,
      parser: `${detection.subtype}-parser`,
      parserVersion: "1.0.0",
      status: "parse_error",
      content: "",
      byteLength: bytes.byteLength,
      error: `failed to parse document: ${errorMsg}`,
      truncated: false,
    };
  }
}
