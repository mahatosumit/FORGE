// FORGE Document Ingestion & Parsing Subsystem — Shared Types & Limits.

export type DocParseMode = "text" | "markdown" | "structured" | "metadata";

export interface DocParseOptions {
  mode?: DocParseMode;
  maxBytes?: number;
  pages?: number[];
  sheet?: string;
  includeImages?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DocParseResult {
  mime: string;
  parser: string;
  parserVersion: string;
  status: "success" | "parse_error" | "unsupported_format" | "timeout";
  content: string;
  byteLength: number;
  pageCount?: number;
  sheetCount?: number;
  imageCount?: number;
  metadata?: Record<string, string | number | boolean>;
  error?: string | null;
  truncated: boolean;
}

export const PARSER_LIMITS = {
  DEFAULT_MAX_INPUT_BYTES: 50 * 1024 * 1024, // 50 MiB
  DEFAULT_MAX_OUTPUT_BYTES: 512 * 1024, // 512 KiB
  MAX_PAGE_COUNT: 500,
  MAX_SHEET_ROWS: 500,
  MAX_SHEET_COLS: 50,
  DEFAULT_TIMEOUT_MS: 30_000,
} as const;

export class DocumentParseError extends Error {
  constructor(
    public readonly code: "PARSE_ERROR" | "UNSUPPORTED_FORMAT" | "OVERSIZED" | "CORRUPTED",
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentParseError";
  }
}
