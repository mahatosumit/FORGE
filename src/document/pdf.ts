// FORGE Pure-TypeScript PDF Parser.
// Extracts structured per-page text, headings, metadata, and tables without heavyweight native binaries.

import { inflateSync } from "node:zlib";
import type { DocParseOptions, DocParseResult } from "./types.js";
import { PARSER_LIMITS, DocumentParseError } from "./types.js";

interface PdfObject {
  id: number;
  gen: number;
  dict: string;
  stream?: Uint8Array;
}

export function parsePdf(bytes: Uint8Array, opts?: DocParseOptions): DocParseResult {
  if (bytes.length < 10) {
    throw new DocumentParseError("CORRUPTED", "file too short to be a valid PDF document");
  }

  // 1. Verify %PDF- signature
  const headerStr = new TextDecoder("latin1").decode(bytes.subarray(0, 20));
  if (!headerStr.startsWith("%PDF-")) {
    throw new DocumentParseError("CORRUPTED", "missing %PDF- header magic");
  }

  // 2. Scan objects across the file
  const objects = scanPdfObjects(bytes);
  if (objects.size === 0) {
    throw new DocumentParseError("PARSE_ERROR", "no valid PDF objects found in document");
  }

  // 3. Extract metadata from /Info dictionary if present
  const metadata = extractPdfMetadata(objects);

  // 4. Resolve /Type /Page objects
  const pageObjs = resolvePdfPages(objects);
  const totalPages = Math.min(pageObjs.length, PARSER_LIMITS.MAX_PAGE_COUNT);

  if (totalPages === 0) {
    // Fallback: search all decoded text streams across objects if no /Page objects detected
    const fallbackText = extractAllTextStreams(objects);
    if (!fallbackText.trim()) {
      throw new DocumentParseError("PARSE_ERROR", "no readable pages or text content found in PDF");
    }

    const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
    const truncated = Buffer.byteLength(fallbackText, "utf8") > maxBytes;
    const output = truncated ? fallbackText.slice(0, maxBytes) : fallbackText;

    return {
      mime: "application/pdf",
      parser: "pdf-native",
      parserVersion: "1.0.0",
      status: "success",
      content: output,
      byteLength: bytes.byteLength,
      pageCount: 1,
      metadata: { ...metadata, totalPages: 1 },
      truncated,
    };
  }

  // 5. Extract text page by page
  const pageOutputs: string[] = [];
  const requestedPages = opts?.pages ? new Set(opts.pages) : null;

  for (let idx = 0; idx < totalPages; idx++) {
    const pageNum = idx + 1;
    if (requestedPages && !requestedPages.has(pageNum)) continue;

    const pageObj = pageObjs[idx]!;
    const contentRefs = extractContentRefs(pageObj.dict);
    const textPieces: string[] = [];

    for (const ref of contentRefs) {
      const streamObj = objects.get(ref);
      if (streamObj && streamObj.stream) {
        const decodedStream = decodeStream(streamObj.dict, streamObj.stream);
        if (decodedStream) {
          const extracted = extractTextFromStream(decodedStream);
          if (extracted) textPieces.push(extracted);
        }
      }
    }

    const pageText = textPieces.join("\n").trim();
    pageOutputs.push(`## Page ${pageNum}\n\n${pageText || "(no extractable text)"}`);
  }

  const fullContent = pageOutputs.join("\n\n---\n\n");
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const truncated = Buffer.byteLength(fullContent, "utf8") > maxBytes;
  const output = truncated ? fullContent.slice(0, maxBytes) : fullContent;

  return {
    mime: "application/pdf",
    parser: "pdf-native",
    parserVersion: "1.0.0",
    status: "success",
    content: output,
    byteLength: bytes.byteLength,
    pageCount: totalPages,
    metadata: {
      ...metadata,
      pageCount: totalPages,
      extractedPages: pageOutputs.length,
    },
    truncated,
  };
}

/**
 * Scan all `N M obj ... endobj` blocks in the raw byte stream.
 */
/**
 * Scan all `N M obj ... endobj` blocks in the raw byte stream, and unpack modern /ObjStm object streams.
 */
function scanPdfObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const map = new Map<number, PdfObject>();
  const latin1 = new TextDecoder("latin1").decode(bytes);

  const objRe = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)(?:endobj|\n(?=\d+\s+\d+\s+obj))/g;
  let match: RegExpExecArray | null;

  while ((match = objRe.exec(latin1)) !== null) {
    const id = parseInt(match[1]!, 10);
    const gen = parseInt(match[2]!, 10);
    const body = match[3]!;

    const streamIdx = match[0].indexOf("stream");
    const endstreamIdx = match[0].lastIndexOf("endstream");
    let dict = body;
    let stream: Uint8Array | undefined;

    if (streamIdx !== -1 && endstreamIdx > streamIdx) {
      dict = body.slice(0, body.indexOf("stream"));
      let streamDataStart = match.index + streamIdx + 6;
      if (bytes[streamDataStart] === 0x0d && bytes[streamDataStart + 1] === 0x0a) {
        streamDataStart += 2;
      } else if (bytes[streamDataStart] === 0x0a || bytes[streamDataStart] === 0x0d) {
        streamDataStart += 1;
      }

      const absEndstream = match.index + endstreamIdx;
      if (absEndstream >= streamDataStart && absEndstream <= bytes.length) {
        stream = bytes.subarray(streamDataStart, absEndstream);
      }
    }

    map.set(id, { id, gen, dict, stream });
  }

  // Unpack PDF 1.5+ Object Streams (/Type /ObjStm)
  for (const obj of Array.from(map.values())) {
    if (/\/Type\s*\/ObjStm\b/i.test(obj.dict) && obj.stream) {
      unpackObjectStream(obj, map);
    }
  }

  return map;
}

/**
 * Unpack compressed objects embedded inside an /ObjStm stream.
 */
function unpackObjectStream(stmObj: PdfObject, targetMap: Map<number, PdfObject>): void {
  const nMatch = /\/N\s+(\d+)/.exec(stmObj.dict);
  const firstMatch = /\/First\s+(\d+)/.exec(stmObj.dict);
  if (!nMatch || !firstMatch) return;

  const count = parseInt(nMatch[1]!, 10);
  const firstOffset = parseInt(firstMatch[1]!, 10);
  if (count <= 0 || firstOffset <= 0) return;

  const decompressed = decodeStream(stmObj.dict, stmObj.stream!);
  if (!decompressed || decompressed.length <= firstOffset) return;

  const headerStr = new TextDecoder("latin1").decode(decompressed.subarray(0, firstOffset)).trim();
  const tokens = headerStr.split(/\s+/).map((t) => parseInt(t, 10));
  if (tokens.length < count * 2) return;

  const dataStr = new TextDecoder("latin1").decode(decompressed.subarray(firstOffset));

  for (let i = 0; i < count; i++) {
    const subId = tokens[i * 2]!;
    const relOffset = tokens[i * 2 + 1]!;
    const nextOffset = i + 1 < count ? tokens[(i + 1) * 2 + 1]! : dataStr.length;

    if (relOffset < dataStr.length) {
      const subBody = dataStr.slice(relOffset, Math.min(nextOffset, dataStr.length)).trim();
      targetMap.set(subId, { id: subId, gen: 0, dict: subBody });
    }
  }
}

/**
 * Resolve all /Type /Page objects in strict document order by traversing /Root -> /Pages -> /Kids.
 */
function resolvePdfPages(objects: Map<number, PdfObject>): PdfObject[] {
  // 1. Locate Catalog (/Type /Catalog)
  let catalogObj: PdfObject | undefined;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog\b/i.test(obj.dict)) {
      catalogObj = obj;
      break;
    }
  }

  if (catalogObj) {
    const pagesRefMatch = /\/Pages\s*(\d+)\s+\d+\s+R/i.exec(catalogObj.dict);
    if (pagesRefMatch) {
      const rootPagesId = parseInt(pagesRefMatch[1]!, 10);
      const visited = new Set<number>();
      const orderedPages: PdfObject[] = [];

      function traversePages(id: number): void {
        if (visited.has(id)) return;
        visited.add(id);
        const node = objects.get(id);
        if (!node) return;

        if (/\/Type\s*\/Page\b/i.test(node.dict) && !/\/Type\s*\/Pages\b/i.test(node.dict)) {
          orderedPages.push(node);
          return;
        }

        // Parent node with /Kids [ ... ]
        const kidsMatch = /\/Kids\s*\[([\s\S]*?)\]/i.exec(node.dict);
        if (kidsMatch) {
          const refRe = /(\d+)\s+\d+\s+R/g;
          let m: RegExpExecArray | null;
          while ((m = refRe.exec(kidsMatch[1]!)) !== null) {
            traversePages(parseInt(m[1]!, 10));
          }
        }
      }

      traversePages(rootPagesId);
      if (orderedPages.length > 0) return orderedPages;
    }
  }

  // Fallback: collect all /Type /Page objects if catalog tree traversal is missing or broken
  const fallbackPages: PdfObject[] = [];
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Page\b/i.test(obj.dict) && !/\/Type\s*\/Pages\b/i.test(obj.dict)) {
      fallbackPages.push(obj);
    }
  }

  return fallbackPages;
}

/**
 * Extract content stream object IDs referenced by `/Contents ...`.
 */
function extractContentRefs(dict: string): number[] {
  const refs: number[] = [];

  const contentsMatch = /\/Contents\s*(\[\s*[^\]]+\]|\d+\s+\d+\s+R)/i.exec(dict);
  if (contentsMatch) {
    const target = contentsMatch[1]!;
    const refRe = /(\d+)\s+\d+\s+R/g;
    let rMatch: RegExpExecArray | null;
    while ((rMatch = refRe.exec(target)) !== null) {
      refs.push(parseInt(rMatch[1]!, 10));
    }
  }

  return refs;
}

/**
 * Decode stream based on /Filter (supports /FlateDecode, /Fl).
 */
function decodeStream(dict: string, streamBytes: Uint8Array): Uint8Array | null {
  if (/\/Filter\s*\/FlateDecode\b|\/Filter\s*\/Fl\b/i.test(dict)) {
    try {
      return inflateSync(Buffer.from(streamBytes));
    } catch {
      return null;
    }
  }
  return streamBytes;
}

/**
 * Extract text strings from content stream operators (BT ... ET, Tj, TJ, ', ", T*).
 */
function extractTextFromStream(streamBytes: Uint8Array): string {
  const text = new TextDecoder("latin1").decode(streamBytes);
  const outLines: string[] = [];

  const btRe = /BT([\s\S]*?)ET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRe.exec(text)) !== null) {
    const block = btMatch[1]!;
    const lineParts: string[] = [];
    let currentLine = "";

    let i = 0;
    while (i < block.length) {
      // 1. Literal string: ( ... )
      if (block[i] === "(") {
        const parsed = parsePdfLiteralString(block, i);
        if (parsed) {
          i = parsed.nextIndex;
          // Look ahead for operator: Tj, ', "
          const opMatch = /^\s*(Tj|'|")/i.exec(block.slice(i, i + 10));
          if (opMatch) {
            const op = opMatch[1]!;
            i += opMatch[0].length;
            if (op === "'" || op === '"') {
              if (currentLine.trim()) lineParts.push(currentLine.trim());
              currentLine = parsed.value;
            } else {
              currentLine += (currentLine ? " " : "") + parsed.value;
            }
          }
          continue;
        }
      }

      // 2. Hex string: < ... > Tj
      if (block[i] === "<" && block[i + 1] !== "<") {
        const endHex = block.indexOf(">", i);
        if (endHex !== -1) {
          const hexContent = block.slice(i + 1, endHex).replace(/\s+/g, "");
          const afterHex = block.slice(endHex + 1, endHex + 10);
          const opMatch = /^\s*(Tj|'|")/i.exec(afterHex);
          if (opMatch) {
            const decoded = decodeHexPdfString(hexContent);
            i = endHex + 1 + opMatch[0].length;
            currentLine += (currentLine ? " " : "") + decoded;
            continue;
          }
        }
      }

      // 3. TJ Array: [ ... ] TJ
      if (block[i] === "[") {
        const endBracket = findClosingBracket(block, i);
        if (endBracket !== -1) {
          const arrSlice = block.slice(i + 1, endBracket);
          const afterArr = block.slice(endBracket + 1, endBracket + 10);
          if (/^\s*TJ\b/i.test(afterArr)) {
            const tjText = parseTjArrayContent(arrSlice);
            if (tjText) {
              currentLine += (currentLine ? " " : "") + tjText;
            }
            const tjOpMatch = /^\s*TJ\b/i.exec(afterArr);
            i = endBracket + 1 + (tjOpMatch ? tjOpMatch[0].length : 2);
            continue;
          }
        }
      }

      // 4. Line breaking operators: T*, Td, TD
      const lineOpMatch = /^\s*(T\*|(?:\S+\s+\S+\s+T[dD]))/i.exec(block.slice(i, i + 30));
      if (lineOpMatch) {
        if (currentLine.trim()) {
          lineParts.push(currentLine.trim());
          currentLine = "";
        }
        i += lineOpMatch[0].length;
        continue;
      }

      i++;
    }

    if (currentLine.trim()) {
      lineParts.push(currentLine.trim());
    }

    if (lineParts.length > 0) {
      outLines.push(lineParts.join("\n"));
    }
  }

  return outLines.join("\n").trim();
}

/**
 * Tokenize inside a [ ... ] TJ array handling strings, hex, and kerning numbers.
 */
function parseTjArrayContent(arrContent: string): string {
  let result = "";
  let i = 0;

  while (i < arrContent.length) {
    if (arrContent[i] === "(") {
      const parsed = parsePdfLiteralString(arrContent, i);
      if (parsed) {
        result += parsed.value;
        i = parsed.nextIndex;
        continue;
      }
    }

    if (arrContent[i] === "<" && arrContent[i + 1] !== "<") {
      const endHex = arrContent.indexOf(">", i);
      if (endHex !== -1) {
        const hex = arrContent.slice(i + 1, endHex).replace(/\s+/g, "");
        result += decodeHexPdfString(hex);
        i = endHex + 1;
        continue;
      }
    }

    // Number (kerning/displacement)
    const numMatch = /^[-+]?\d*\.?\d+/.exec(arrContent.slice(i));
    if (numMatch) {
      const val = parseFloat(numMatch[0]);
      // Standard heuristic: large negative displacement indicates word space
      if (val <= -150 && result.length > 0 && !result.endsWith(" ")) {
        result += " ";
      }
      i += numMatch[0].length;
      continue;
    }

    i++;
  }

  return result.trim();
}

/**
 * Parse a balanced/escaped PDF literal string: (hello \(world\)).
 */
function parsePdfLiteralString(s: string, start: number): { value: string; nextIndex: number } | null {
  if (s[start] !== "(") return null;
  let depth = 1;
  let i = start + 1;
  let result = "";

  while (i < s.length && depth > 0) {
    const ch = s[i]!;

    if (ch === "\\") {
      if (i + 1 < s.length) {
        const next = s[i + 1]!;
        if (next === "n") { result += "\n"; i += 2; continue; }
        if (next === "r") { result += "\r"; i += 2; continue; }
        if (next === "t") { result += "\t"; i += 2; continue; }
        if (next === "(" || next === ")" || next === "\\") { result += next; i += 2; continue; }
        const octMatch = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
        if (octMatch) {
          result += String.fromCharCode(parseInt(octMatch[0], 8));
          i += 1 + octMatch[0].length;
          continue;
        }
        result += next;
        i += 2;
        continue;
      }
    }

    if (ch === "(") {
      depth++;
      result += ch;
    } else if (ch === ")") {
      depth--;
      if (depth > 0) result += ch;
    } else {
      result += ch;
    }
    i++;
  }

  return { value: result, nextIndex: i };
}

function findClosingBracket(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractAllTextStreams(objects: Map<number, PdfObject>): string {
  const lines: string[] = [];
  for (const obj of objects.values()) {
    if (obj.stream) {
      const dec = decodeStream(obj.dict, obj.stream);
      if (dec) {
        const txt = extractTextFromStream(dec);
        if (txt) lines.push(txt);
      }
    }
  }
  return lines.join("\n");
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function decodeHexPdfString(hex: string): string {
  // UTF-16BE BOM check: FEFF
  if (hex.length >= 4 && hex.slice(0, 4).toUpperCase() === "FEFF") {
    let str = "";
    for (let i = 4; i + 3 < hex.length; i += 4) {
      str += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return str;
  }

  let str = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return str;
}

function extractPdfMetadata(objects: Map<number, PdfObject>): Record<string, string> {
  const meta: Record<string, string> = {};

  for (const obj of objects.values()) {
    if (/\/Title\b|\/Author\b|\/Subject\b|\/Creator\b/i.test(obj.dict)) {
      const titleMatch = /\/Title\s*\(([^)]+)\)/i.exec(obj.dict);
      const authorMatch = /\/Author\s*\(([^)]+)\)/i.exec(obj.dict);
      const creatorMatch = /\/Creator\s*\(([^)]+)\)/i.exec(obj.dict);

      if (titleMatch) meta["title"] = decodePdfString(titleMatch[1]!);
      if (authorMatch) meta["author"] = decodePdfString(authorMatch[1]!);
      if (creatorMatch) meta["creator"] = decodePdfString(creatorMatch[1]!);
    }
  }

  return meta;
}
