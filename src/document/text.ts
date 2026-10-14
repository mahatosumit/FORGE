// FORGE Native Text, Markdown, CSV, JSON, XML, and YAML Parsers.
// Deterministic parsing without external heavyweight document dependencies.

import type { DocParseOptions, DocParseResult } from "./types.js";
import { PARSER_LIMITS } from "./types.js";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse plain text or Markdown documents.
 */
export function parsePlainText(
  bytes: Uint8Array,
  filename: string,
  isMarkdown: boolean,
  opts?: DocParseOptions,
): DocParseResult {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const raw = stripBom(decoder.decode(bytes));

  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  let content = raw;
  let truncated = false;

  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }

  const lines = raw.split("\n");
  const headings = isMarkdown ? lines.filter((l) => /^#{1,6}\s+/.test(l.trim())).length : 0;

  return {
    mime: isMarkdown ? "text/markdown" : "text/plain",
    parser: isMarkdown ? "markdown-native" : "text-native",
    parserVersion: "1.0.0",
    status: "success",
    content,
    byteLength: bytes.byteLength,
    metadata: {
      lineCount: lines.length,
      characterCount: raw.length,
      headingCount: headings,
    },
    truncated,
  };
}

/**
 * Parse RFC 4180 CSV files into deterministic Markdown tables with summary stats.
 */
export function parseCsv(bytes: Uint8Array, opts?: DocParseOptions): DocParseResult {
  const text = stripBom(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  const rows = parseCsvTokens(text, PARSER_LIMITS.MAX_SHEET_ROWS);

  if (rows.length === 0) {
    return {
      mime: "text/csv",
      parser: "csv-native",
      parserVersion: "1.0.0",
      status: "success",
      content: "(empty csv file)",
      byteLength: bytes.byteLength,
      metadata: { rowCount: 0, columnCount: 0 },
      truncated: false,
    };
  }

  const maxRows = Math.min(rows.length, PARSER_LIMITS.MAX_SHEET_ROWS);
  const maxCols = Math.min(rows[0]?.length ?? 0, PARSER_LIMITS.MAX_SHEET_COLS);
  const header = rows[0]!.slice(0, maxCols);

  const lines: string[] = [];
  lines.push(`| ${header.map((h) => cleanCell(h)).join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (let i = 1; i < maxRows; i++) {
    const row = rows[i]!;
    const padded = header.map((_, colIdx) => cleanCell(row[colIdx] ?? ""));
    lines.push(`| ${padded.join(" | ")} |`);
  }

  let truncated = rows.length > maxRows || (rows[0]?.length ?? 0) > maxCols;
  if (rows.length > maxRows) {
    lines.push(`\n*... [${rows.length - maxRows} additional rows truncated]*`);
  }

  const content = lines.join("\n");
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const finalContent = content.length > maxBytes ? content.slice(0, maxBytes) : content;
  if (content.length > maxBytes) truncated = true;

  return {
    mime: "text/csv",
    parser: "csv-native",
    parserVersion: "1.0.0",
    status: "success",
    content: finalContent,
    byteLength: bytes.byteLength,
    metadata: {
      rowCount: rows.length,
      columnCount: rows[0]?.length ?? 0,
      previewRows: Math.min(rows.length, maxRows),
    },
    truncated,
  };
}

/**
 * Tokenize CSV text handling quotes, escapes (""), commas, semicolons, tabs, and multiline cells.
 */
export function parseCsvTokens(text: string, maxRows = PARSER_LIMITS.MAX_SHEET_ROWS): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  // Auto-detect delimiter from first non-empty line
  const firstLine = text.split("\n")[0] ?? "";
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";

  let i = 0;
  while (i < text.length) {
    if (rows.length >= maxRows) break;
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      currentRow.push(currentField.trim());
      currentField = "";
      i++;
      continue;
    }

    if (char === "\r") {
      i++;
      continue;
    }

    if (char === "\n") {
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === "")) {
        rows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if ((currentField || currentRow.length > 0) && rows.length < maxRows) {
    currentRow.push(currentField.trim());
    if (currentRow.length > 0 && !(currentRow.length === 1 && currentRow[0] === "")) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function cleanCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/**
 * Parse JSON and JSONL documents with schema summarization for large files.
 */
export function parseJson(bytes: Uint8Array, isJsonLines: boolean, opts?: DocParseOptions): DocParseResult {
  const text = stripBom(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;

  if (isJsonLines) {
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const parsedSamples: unknown[] = [];
    let parseErrors = 0;

    for (let i = 0; i < Math.min(lines.length, 25); i++) {
      try {
        parsedSamples.push(JSON.parse(lines[i]!));
      } catch {
        parseErrors++;
      }
    }

    const preview = JSON.stringify(parsedSamples, null, 2);
    const summary = `JSONL file: ${lines.length} lines total.\nSample of first ${parsedSamples.length} records:\n${preview}`;
    const truncated = lines.length > 25 || Buffer.byteLength(summary, "utf8") > maxBytes;

    return {
      mime: "application/x-ndjson",
      parser: "jsonl-native",
      parserVersion: "1.0.0",
      status: "success",
      content: summary.slice(0, maxBytes),
      byteLength: bytes.byteLength,
      metadata: {
        totalLines: lines.length,
        sampledLines: parsedSamples.length,
        parseErrors,
      },
      truncated,
    };
  }

  try {
    const parsed = JSON.parse(text);
    const formatted = JSON.stringify(parsed, null, 2);
    let content = formatted;
    let truncated = false;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      // Summarize large JSON
      const schemaSummary = summarizeJsonStructure(parsed);
      const boundedSample = formatted.slice(0, maxBytes - 1000);
      content = `--- JSON Schema Summary ---\n${schemaSummary}\n\n--- Bounded Preview ---\n${boundedSample}\n... [remainder truncated]`;
      truncated = true;
    }

    return {
      mime: "application/json",
      parser: "json-native",
      parserVersion: "1.0.0",
      status: "success",
      content,
      byteLength: bytes.byteLength,
      metadata: {
        isObject: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
        isArray: Array.isArray(parsed),
        itemCount: Array.isArray(parsed) ? parsed.length : typeof parsed === "object" && parsed !== null ? Object.keys(parsed).length : 1,
      },
      truncated,
    };
  } catch (err) {
    return {
      mime: "application/json",
      parser: "json-native",
      parserVersion: "1.0.0",
      status: "parse_error",
      content: text.slice(0, 1000),
      byteLength: bytes.byteLength,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      truncated: false,
    };
  }
}

function summarizeJsonStructure(val: unknown, depth = 0): string {
  if (depth > 3) return "...";
  if (val === null) return "null";
  if (typeof val !== "object") return typeof val;

  if (Array.isArray(val)) {
    const sampleType = val.length > 0 ? summarizeJsonStructure(val[0], depth + 1) : "unknown";
    return `Array<${sampleType}> (length: ${val.length})`;
  }

  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj);
  const props = keys.slice(0, 15).map((k) => `  ${"  ".repeat(depth)}${k}: ${summarizeJsonStructure(obj[k], depth + 1)}`);
  if (keys.length > 15) props.push(`  ${"  ".repeat(depth)}... (${keys.length - 15} more keys)`);
  return `{\n${props.join("\n")}\n${"  ".repeat(depth)}}`;
}

/**
 * Parse XML / YAML text files safely.
 */
export function parseStructuredText(
  bytes: Uint8Array,
  kind: "xml" | "yaml",
  opts?: DocParseOptions,
): DocParseResult {
  const text = stripBom(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const truncated = Buffer.byteLength(text, "utf8") > maxBytes;
  const content = truncated ? text.slice(0, maxBytes) : text;

  return {
    mime: kind === "xml" ? "application/xml" : "application/yaml",
    parser: `${kind}-native`,
    parserVersion: "1.0.0",
    status: "success",
    content,
    byteLength: bytes.byteLength,
    truncated,
  };
}
