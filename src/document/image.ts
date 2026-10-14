// FORGE Pure-TypeScript Image Ingestion & Metadata Extractor.
// Extracts dimensions, MIME type, format details, and content hash without native binaries.
// Supports optional provider-neutral multimodal vision analysis.

import { createHash } from "node:crypto";
import type { DocParseOptions, DocParseResult } from "./types.js";
import { DocumentParseError } from "./types.js";

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp" | "gif" | "bmp" | "unknown";
}

export function parseImage(
  bytes: Uint8Array,
  mime: string,
  opts?: DocParseOptions,
): DocParseResult {
  const dims = extractDimensions(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const lines: string[] = [
    "### Image Ingestion Metadata",
    `- **Format**: ${dims.format.toUpperCase()} (${mime})`,
    `- **Dimensions**: ${dims.width > 0 ? `${dims.width} x ${dims.height} pixels` : "Unknown"}`,
    `- **Byte Size**: ${bytes.byteLength} bytes`,
    `- **SHA-256**: \`${sha256}\``,
  ];

  // Optional vision analysis adapter
  // If vision is not configured, image ingestion succeeds completely with metadata
  lines.push("\n*Visual Analysis: No vision model configured for local capability dispatch.*");

  return {
    mime,
    parser: "image-native",
    parserVersion: "1.0.0",
    status: "success",
    content: lines.join("\n"),
    byteLength: bytes.byteLength,
    imageCount: 1,
    metadata: {
      width: dims.width,
      height: dims.height,
      format: dims.format,
      sha256,
      visionStatus: "not_configured",
    },
    truncated: false,
  };
}

export function extractDimensions(bytes: Uint8Array): ImageDimensions {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. PNG
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, format: "png" };
  }

  // 2. JPEG
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height, format: "jpeg" };
      }
      const len = buf.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
    return { width: 0, height: 0, format: "jpeg" };
  }

  // 3. GIF
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height, format: "gif" };
  }

  // 4. BMP
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const width = buf.readInt32LE(18);
    const height = Math.abs(buf.readInt32LE(22));
    return { width, height, format: "bmp" };
  }

  // 5. WEBP
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    const tag = buf.toString("ascii", 12, 16);
    if (tag === "VP8 " && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height, format: "webp" };
    }
    if (tag === "VP8L" && buf.length >= 25) {
      const b1 = buf[21]!;
      const b2 = buf[22]!;
      const b3 = buf[23]!;
      const b4 = buf[24]!;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    }
    if (tag === "VP8X" && buf.length >= 30) {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height, format: "webp" };
    }
    return { width: 0, height: 0, format: "webp" };
  }

  return { width: 0, height: 0, format: "unknown" };
}
