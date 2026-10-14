// FORGE OpenXML Office Document Parsers (DOCX, PPTX, XLSX).
// Extracts structured text, headings, slides, tables, and metadata into deterministic Markdown.

import { ZipReader } from "./zip.js";
import type { DocParseOptions, DocParseResult } from "./types.js";
import { PARSER_LIMITS, DocumentParseError } from "./types.js";

/**
 * Parse Microsoft Word documents (.docx) into structured Markdown.
 */
export function parseDocx(bytes: Uint8Array, opts?: DocParseOptions): DocParseResult {
  let zip: ZipReader;
  try {
    zip = ZipReader.fromUint8Array(bytes);
  } catch (err) {
    throw new DocumentParseError("CORRUPTED", `invalid docx archive: ${String(err)}`, err);
  }

  if (!zip.has("word/document.xml")) {
    throw new DocumentParseError("CORRUPTED", "docx missing word/document.xml");
  }

  const xml = zip.readText("word/document.xml");
  const metadata = extractCoreMetadata(zip);

  const lines: string[] = [];
  let tableCount = 0;

  // Simple, deterministic OpenXML regex tokenizer
  // Split on <w:p> (paragraphs) and <w:tbl> (tables)
  const blockRe = /<(w:p|w:tbl)[^>]*>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(xml)) !== null) {
    const tag = match[1];
    const content = match[2]!;

    if (tag === "w:p") {
      // Check heading style
      const styleMatch = /<w:pStyle\s+[^>]*w:val="([^"]+)"/i.exec(content);
      const style = styleMatch ? styleMatch[1]!.toLowerCase() : "";
      const text = extractDocxParagraphText(content);

      if (!text.trim()) continue;

      if (style.includes("heading1") || style.includes("title")) {
        lines.push(`\n# ${text.trim()}\n`);
      } else if (style.includes("heading2")) {
        lines.push(`\n## ${text.trim()}\n`);
      } else if (style.includes("heading3")) {
        lines.push(`\n### ${text.trim()}\n`);
      } else if (/<w:numPr/i.test(content)) {
        lines.push(`- ${text.trim()}`);
      } else {
        lines.push(text.trim());
      }
    } else if (tag === "w:tbl") {
      tableCount++;
      const mdTable = parseDocxTable(content);
      if (mdTable) {
        lines.push(`\n${mdTable}\n`);
      }
    }
  }

  const fullText = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const truncated = Buffer.byteLength(fullText, "utf8") > maxBytes;
  const output = truncated ? fullText.slice(0, maxBytes) : fullText;

  return {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    parser: "docx-openxml",
    parserVersion: "1.0.0",
    status: "success",
    content: output,
    byteLength: bytes.byteLength,
    metadata: {
      ...metadata,
      tableCount,
      lineCount: lines.length,
    },
    truncated,
  };
}

function extractDocxParagraphText(pXml: string): string {
  // Strip tracked changes deleted text
  const cleaned = pXml.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "");
  // Replace line breaks and tabs
  const formatted = cleaned
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t");

  const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let tMatch: RegExpExecArray | null;
  const pieces: string[] = [];
  while ((tMatch = tRe.exec(formatted)) !== null) {
    pieces.push(decodeXmlEntities(tMatch[1]!));
  }
  if (pieces.length > 0) return pieces.join("");
  return extractXmlText(cleaned);
}

function parseDocxTable(tableXml: string): string | null {
  const rows: string[][] = [];
  const rowRe = /<w:tr[^>]*>([\s\S]*?)<\/w:tr>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(tableXml)) !== null) {
    const cellRe = /<w:tc[^>]*>([\s\S]*?)<\/w:tc>/g;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
      cells.push(extractDocxParagraphText(cellMatch[1]!).trim().replace(/\|/g, "\\|"));
    }
    if (cells.length > 0) rows.push(cells);
  }

  if (rows.length === 0) return null;

  const colCount = Math.max(...rows.map((r) => r.length));
  const outLines: string[] = [];

  const header = rows[0]!;
  while (header.length < colCount) header.push("");
  outLines.push(`| ${header.join(" | ")} |`);
  outLines.push(`| ${header.map(() => "---").join(" | ")} |`);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    while (row.length < colCount) row.push("");
    outLines.push(`| ${row.join(" | ")} |`);
  }

  return outLines.join("\n");
}

/**
 * Parse Microsoft PowerPoint presentations (.pptx) into per-slide Markdown.
 */
export function parsePptx(bytes: Uint8Array, opts?: DocParseOptions): DocParseResult {
  let zip: ZipReader;
  try {
    zip = ZipReader.fromUint8Array(bytes);
  } catch (err) {
    throw new DocumentParseError("CORRUPTED", `invalid pptx archive: ${String(err)}`, err);
  }

  // Find slide files: ppt/slides/slide1.xml, ppt/slides/slide2.xml, ...
  const allFiles = zip.listFiles();
  const slideFiles = allFiles
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ""), 10);
      const numB = parseInt(b.replace(/\D/g, ""), 10);
      return numA - numB;
    });

  if (slideFiles.length === 0) {
    throw new DocumentParseError("CORRUPTED", "pptx contains no slide files in ppt/slides/");
  }

  const metadata = extractCoreMetadata(zip);
  const slideOutputs: string[] = [];
  const requestedPages = opts?.pages ? new Set(opts.pages) : null;

  for (let idx = 0; idx < slideFiles.length; idx++) {
    const slideNum = idx + 1;
    if (requestedPages && !requestedPages.has(slideNum)) continue;

    const slideFile = slideFiles[idx]!;
    const slideXml = zip.readText(slideFile);

    // Extract text boxes & shapes
    const paragraphs: string[] = [];
    const pRe = /<a:p[^>]*>([\s\S]*?)<\/a:p>/g;
    let pMatch: RegExpExecArray | null;

    while ((pMatch = pRe.exec(slideXml)) !== null) {
      const pText = extractXmlText(pMatch[1]!).trim();
      if (pText) paragraphs.push(pText);
    }

    // Check notes if available: ppt/notesSlides/notesSlide{N}.xml
    const noteFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    let notesText = "";
    if (zip.has(noteFile)) {
      const noteXml = zip.readText(noteFile);
      const nTexts: string[] = [];
      let nMatch: RegExpExecArray | null;
      while ((nMatch = pRe.exec(noteXml)) !== null) {
        const nt = extractXmlText(nMatch[1]!).trim();
        if (nt && !nt.includes("Click to edit Master")) nTexts.push(nt);
      }
      if (nTexts.length > 0) notesText = `\n*Speaker Notes: ${nTexts.join(" ; ")}*`;
    }

    const title = paragraphs[0] ? paragraphs[0] : `Slide ${slideNum}`;
    const body = paragraphs.slice(1).map((p) => `- ${p}`).join("\n");

    slideOutputs.push(`## Slide ${slideNum} — ${title}\n\n${body}${notesText}`.trim());
  }

  const fullText = slideOutputs.join("\n\n---\n\n");
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const truncated = Buffer.byteLength(fullText, "utf8") > maxBytes;
  const output = truncated ? fullText.slice(0, maxBytes) : fullText;

  return {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    parser: "pptx-openxml",
    parserVersion: "1.0.0",
    status: "success",
    content: output,
    byteLength: bytes.byteLength,
    pageCount: slideFiles.length,
    metadata: {
      ...metadata,
      slideCount: slideFiles.length,
      extractedSlides: slideOutputs.length,
    },
    truncated,
  };
}

/**
 * Parse Microsoft Excel spreadsheets (.xlsx) into structured Markdown tables.
 */
export function parseXlsx(bytes: Uint8Array, opts?: DocParseOptions): DocParseResult {
  let zip: ZipReader;
  try {
    zip = ZipReader.fromUint8Array(bytes);
  } catch (err) {
    throw new DocumentParseError("CORRUPTED", `invalid xlsx archive: ${String(err)}`, err);
  }

  if (!zip.has("xl/workbook.xml")) {
    throw new DocumentParseError("CORRUPTED", "xlsx missing xl/workbook.xml");
  }

  // 1. Shared Strings Table
  const sharedStrings: string[] = [];
  if (zip.has("xl/sharedStrings.xml")) {
    const sstXml = zip.readText("xl/sharedStrings.xml");
    const siRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch: RegExpExecArray | null;
    while ((siMatch = siRe.exec(sstXml)) !== null) {
      sharedStrings.push(extractXmlText(siMatch[1]!));
    }
  }

  // 2. Sheet mapping from workbook.xml
  const wbXml = zip.readText("xl/workbook.xml");
  const sheetNames: string[] = [];
  const sheetTagRe = /<sheet\b([^>]*)\/?>/g;
  let shMatch: RegExpExecArray | null;
  while ((shMatch = sheetTagRe.exec(wbXml)) !== null) {
    const attrs = shMatch[1]!;
    const nameMatch = /\bname="([^"]*)"/i.exec(attrs);
    const name = nameMatch ? decodeXmlEntities(nameMatch[1]!) : `Sheet${sheetNames.length + 1}`;
    sheetNames.push(name);
  }

  // 3. Worksheets
  const sheetOutputs: string[] = [];
  const requestedSheet = opts?.sheet ? opts.sheet.toLowerCase() : null;

  for (let idx = 0; idx < Math.max(1, sheetNames.length); idx++) {
    const sheetNum = idx + 1;
    const sheetName = sheetNames[idx] || `Sheet${sheetNum}`;
    if (requestedSheet && sheetName.toLowerCase() !== requestedSheet) continue;

    const sheetPath = `xl/worksheets/sheet${sheetNum}.xml`;
    if (!zip.has(sheetPath)) continue;

    const sheetXml = zip.readText(sheetPath);
    const table = parseSheetXml(sheetXml, sharedStrings);

    sheetOutputs.push(`### Sheet: ${sheetName}\n\n${table}`);
  }

  const fullText = sheetOutputs.join("\n\n---\n\n");
  const maxBytes = opts?.maxBytes ?? PARSER_LIMITS.DEFAULT_MAX_OUTPUT_BYTES;
  const truncated = Buffer.byteLength(fullText, "utf8") > maxBytes;
  const output = truncated ? fullText.slice(0, maxBytes) : fullText;

  return {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parser: "xlsx-openxml",
    parserVersion: "1.0.0",
    status: "success",
    content: output,
    byteLength: bytes.byteLength,
    sheetCount: sheetNames.length,
    metadata: {
      sheets: sheetNames.join(", "),
      totalSheets: sheetNames.length,
    },
    truncated,
  };
}

function parseSheetXml(xml: string, sharedStrings: string[]): string {
  const rowRe = /<row\s+[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const grid: Map<number, Map<number, string>> = new Map();
  let maxCol = 0;
  let rowCount = 0;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowIdx = parseInt(rowMatch[1]!, 10);
    const rowContent = rowMatch[2]!;
    const rowMap = new Map<number, string>();
    let runningCol = 1;

    const cellTagRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellTagRe.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";

      const rMatch = /\br="([A-Za-z]+)(\d+)"/i.exec(attrs);
      let colIdx: number;
      if (rMatch) {
        colIdx = columnLettersToIndex(rMatch[1]!.toUpperCase());
        runningCol = colIdx + 1;
      } else {
        colIdx = runningCol++;
      }

      const tMatch = /\bt="([^"]+)"/i.exec(attrs);
      const type = tMatch ? tMatch[1]! : "";

      let textVal = "";
      if (type === "inlineStr" || body.includes("<is>")) {
        const isMatch = /<is\b[\s\S]*?<t\b[^>]*>([\s\S]*?)<\/t>/i.exec(body);
        if (isMatch) textVal = decodeXmlEntities(isMatch[1]!);
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body);
        const val = vMatch ? vMatch[1]!.trim() : "";
        if (type === "s") {
          const sstIdx = parseInt(val, 10);
          textVal = !isNaN(sstIdx) && sharedStrings[sstIdx] !== undefined ? sharedStrings[sstIdx]! : val;
        } else if (type === "b") {
          textVal = val === "1" ? "TRUE" : "FALSE";
        } else {
          textVal = val;
        }
      }

      rowMap.set(colIdx, textVal);
      if (colIdx > maxCol) maxCol = colIdx;
    }

    grid.set(rowIdx, rowMap);
    rowCount++;
    if (rowCount >= PARSER_LIMITS.MAX_SHEET_ROWS) break;
  }

  if (grid.size === 0) return "(empty worksheet)";

  const sortedRowIndices = Array.from(grid.keys()).sort((a, b) => a - b);
  const colLimit = Math.min(maxCol, PARSER_LIMITS.MAX_SHEET_COLS);

  const outLines: string[] = [];
  const headerIdx = sortedRowIndices[0]!;
  const headerRow = grid.get(headerIdx)!;

  const headerCols: string[] = [];
  for (let c = 1; c <= colLimit; c++) {
    headerCols.push(cleanCell(headerRow.get(c) || indexToColumnLetters(c)));
  }
  outLines.push(`| ${headerCols.join(" | ")} |`);
  outLines.push(`| ${headerCols.map(() => "---").join(" | ")} |`);

  for (let i = 1; i < sortedRowIndices.length; i++) {
    const rIdx = sortedRowIndices[i]!;
    const row = grid.get(rIdx)!;
    const rowCols: string[] = [];
    for (let c = 1; c <= colLimit; c++) {
      rowCols.push(cleanCell(row.get(c) || ""));
    }
    outLines.push(`| ${rowCols.join(" | ")} |`);
  }

  return outLines.join("\n");
}

function columnLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx;
}

function indexToColumnLetters(col: number): string {
  let temp = col;
  let letter = "";
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter || "A";
}

function extractCoreMetadata(zip: ZipReader): Record<string, string> {
  const meta: Record<string, string> = {};
  if (zip.has("docProps/core.xml")) {
    const xml = zip.readText("docProps/core.xml");
    const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/i.exec(xml);
    const creator = /<dc:creator[^>]*>([^<]+)<\/dc:creator>/i.exec(xml);
    if (title) meta["title"] = title[1]!.trim();
    if (creator) meta["author"] = creator[1]!.trim();
  }
  return meta;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractXmlText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function cleanCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
