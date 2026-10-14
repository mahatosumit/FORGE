// FORGE MIME and Document Format Detection.
// Combines magic-byte signatures and extension cross-checks.
// Detects spoofed extensions and unsupported binary payloads safely.

export interface FormatDetection {
  mime: string;
  category: "pdf" | "office" | "image" | "text" | "unknown";
  subtype: "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "json" | "markdown" | "text" | "xml" | "yaml" | "png" | "jpeg" | "webp" | "gif" | "bmp" | "unknown";
  mismatch: boolean;
}

const EXT_MAP: Record<string, { mime: string; subtype: FormatDetection["subtype"]; category: FormatDetection["category"] }> = {
  ".pdf": { mime: "application/pdf", subtype: "pdf", category: "pdf" },
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", subtype: "docx", category: "office" },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", subtype: "pptx", category: "office" },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", subtype: "xlsx", category: "office" },
  ".csv": { mime: "text/csv", subtype: "csv", category: "text" },
  ".json": { mime: "application/json", subtype: "json", category: "text" },
  ".jsonl": { mime: "application/x-ndjson", subtype: "json", category: "text" },
  ".md": { mime: "text/markdown", subtype: "markdown", category: "text" },
  ".markdown": { mime: "text/markdown", subtype: "markdown", category: "text" },
  ".txt": { mime: "text/plain", subtype: "text", category: "text" },
  ".xml": { mime: "application/xml", subtype: "xml", category: "text" },
  ".yaml": { mime: "application/yaml", subtype: "yaml", category: "text" },
  ".yml": { mime: "application/yaml", subtype: "yaml", category: "text" },
  ".png": { mime: "image/png", subtype: "png", category: "image" },
  ".jpg": { mime: "image/jpeg", subtype: "jpeg", category: "image" },
  ".jpeg": { mime: "image/jpeg", subtype: "jpeg", category: "image" },
  ".webp": { mime: "image/webp", subtype: "webp", category: "image" },
  ".gif": { mime: "image/gif", subtype: "gif", category: "image" },
  ".bmp": { mime: "image/bmp", subtype: "bmp", category: "image" },
  // Common code files treated as text
  ".ts": { mime: "text/plain", subtype: "text", category: "text" },
  ".tsx": { mime: "text/plain", subtype: "text", category: "text" },
  ".js": { mime: "text/plain", subtype: "text", category: "text" },
  ".jsx": { mime: "text/plain", subtype: "text", category: "text" },
  ".html": { mime: "text/html", subtype: "text", category: "text" },
  ".css": { mime: "text/css", subtype: "text", category: "text" },
  ".py": { mime: "text/plain", subtype: "text", category: "text" },
  ".rs": { mime: "text/plain", subtype: "text", category: "text" },
  ".go": { mime: "text/plain", subtype: "text", category: "text" },
  ".sh": { mime: "text/plain", subtype: "text", category: "text" },
  ".zip": { mime: "application/zip", subtype: "unknown", category: "office" },
};

export function detectFormat(bytes: Uint8Array, filename: string): FormatDetection {
  const dotIndex = filename.lastIndexOf(".");
  const ext = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  const expected = EXT_MAP[ext];

  // 1. Magic bytes detection
  // PDF: %PDF-
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    const mismatch = expected ? expected.category !== "pdf" : false;
    return { mime: "application/pdf", category: "pdf", subtype: "pdf", mismatch };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    const mismatch = expected ? expected.subtype !== "png" : false;
    return { mime: "image/png", category: "image", subtype: "png", mismatch };
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const mismatch = expected ? expected.subtype !== "jpeg" : false;
    return { mime: "image/jpeg", category: "image", subtype: "jpeg", mismatch };
  }

  // GIF: GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    const mismatch = expected ? expected.subtype !== "gif" : false;
    return { mime: "image/gif", category: "image", subtype: "gif", mismatch };
  }

  // BMP: BM (42 4D)
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const mismatch = expected ? expected.subtype !== "bmp" : false;
    return { mime: "image/bmp", category: "image", subtype: "bmp", mismatch };
  }

  // WEBP: RIFF .... WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const mismatch = expected ? expected.subtype !== "webp" : false;
    return { mime: "image/webp", category: "image", subtype: "webp", mismatch };
  }

  // ZIP / PKZIP: PK\x03\x04
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    if (expected && expected.category === "office") {
      return { mime: expected.mime, category: "office", subtype: expected.subtype, mismatch: false };
    }
    // Ambiguous zip without office extension
    return { mime: "application/zip", category: "office", subtype: "unknown", mismatch: expected?.category !== "office" };
  }

  // If extension is expected as PDF or Office or Image, but bytes don't match magic signature:
  if (expected && (expected.category === "pdf" || expected.category === "office" || expected.category === "image")) {
    return {
      mime: "application/octet-stream",
      category: "unknown",
      subtype: "unknown",
      mismatch: true,
    };
  }

  // 2. Text / Source detection
  if (expected && expected.category === "text") {
    const isText = isLikelyUtf8Text(bytes);
    if (!isText) {
      return { mime: "application/octet-stream", category: "unknown", subtype: "unknown", mismatch: true };
    }
    return { mime: expected.mime, category: "text", subtype: expected.subtype, mismatch: false };
  }

  // Check if bytes are valid UTF-8 text
  if (isLikelyUtf8Text(bytes)) {
    return { mime: "text/plain", category: "text", subtype: "text", mismatch: false };
  }

  return { mime: "application/octet-stream", category: "unknown", subtype: "unknown", mismatch: false };
}

function isLikelyUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, 4096);
  let nullCount = 0;
  let controlCount = 0;

  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    if (b === 0) nullCount++;
    else if (b < 32 && b !== 9 && b !== 10 && b !== 13) controlCount++;
  }

  // Binary files contain null bytes or substantial non-whitespace control characters
  if (nullCount > 0) return false;
  if (controlCount / sample.length > 0.05) return false;

  return true;
}
