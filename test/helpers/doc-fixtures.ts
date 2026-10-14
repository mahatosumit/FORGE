// Deterministic in-memory document generators for testing FORGE doc_parse capability.
// Produces valid minimal binary fixtures for PDF, DOCX, PPTX, XLSX, PNG, and BMP.

import { deflateRawSync } from "node:zlib";

/**
 * Build a valid in-memory ZIP archive from a map of relative file paths to contents.
 */
export function createTestZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const fileEntries: Array<{ nameBuf: Buffer; rawLen: number; compLen: number; offset: number }> = [];
  const buffers: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const compressed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method = Deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(0, 14); // crc32
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    fileEntries.push({ nameBuf, rawLen: raw.length, compLen: compressed.length, offset });
    buffers.push(local, compressed);
    offset += local.length + compressed.length;
  }

  const cdStart = offset;
  for (const entry of fileEntries) {
    const cd = Buffer.alloc(46 + entry.nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(8, 10); // method = Deflate
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0, 14); // date
    cd.writeUInt32LE(0, 16); // crc32
    cd.writeUInt32LE(entry.compLen, 20);
    cd.writeUInt32LE(entry.rawLen, 24);
    cd.writeUInt16LE(entry.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attr
    cd.writeUInt32LE(0, 38); // external attr
    cd.writeUInt32LE(entry.offset, 42); // local header offset
    entry.nameBuf.copy(cd, 46);
    buffers.push(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(fileEntries.length, 8); // entries on disk
  eocd.writeUInt16LE(fileEntries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // central directory size
  eocd.writeUInt32LE(cdStart, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  buffers.push(eocd);

  return new Uint8Array(Buffer.concat(buffers));
}

/**
 * Create a valid minimal DOCX file in memory.
 */
export function createTestDocx(opts: {
  title?: string;
  headings?: string[];
  paragraphs?: string[];
  table?: string[][];
}): Uint8Array {
  let bodyXml = "";

  if (opts.title) {
    bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${opts.title}</w:t></w:r></w:p>`;
  }

  for (const h of opts.headings ?? []) {
    bodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${h}</w:t></w:r></w:p>`;
  }

  for (const p of opts.paragraphs ?? []) {
    bodyXml += `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`;
  }

  if (opts.table && opts.table.length > 0) {
    bodyXml += "<w:tbl>";
    for (const row of opts.table) {
      bodyXml += "<w:tr>";
      for (const cell of row) {
        bodyXml += `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`;
      }
      bodyXml += "</w:tr>";
    }
    bodyXml += "</w:tbl>";
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  const coreXml = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${opts.title ?? "Test Document"}</dc:title><dc:creator>FORGE Test</dc:creator></cp:coreProperties>`;

  return createTestZip({
    "word/document.xml": docXml,
    "docProps/core.xml": coreXml,
  });
}

/**
 * Create a valid minimal PPTX file in memory.
 */
export function createTestPptx(slides: Array<{ title: string; bullets: string[]; notes?: string }>): Uint8Array {
  const files: Record<string, string> = {
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
  };

  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]!;
    const slideNum = i + 1;
    let sXml = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s.title}</a:t></a:r></a:p>`;
    for (const b of s.bullets) {
      sXml += `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`;
    }
    sXml += `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/slide${slideNum}.xml`] = sXml;

    if (s.notes) {
      files[`ppt/notesSlides/notesSlide${slideNum}.xml`] = `<?xml version="1.0"?><p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
    }
  }

  return createTestZip(files);
}

/**
 * Create a valid minimal XLSX file in memory.
 */
export function createTestXlsx(sheets: Record<string, string[][]>): Uint8Array {
  const sharedStrings: string[] = [];
  const stringIndexMap = new Map<string, number>();

  function getStringId(s: string): number {
    if (stringIndexMap.has(s)) return stringIndexMap.get(s)!;
    const id = sharedStrings.length;
    sharedStrings.push(s);
    stringIndexMap.set(s, id);
    return id;
  }

  const files: Record<string, string> = {};
  const sheetNames = Object.keys(sheets);
  let wbXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>`;

  for (let i = 0; i < sheetNames.length; i++) {
    const name = sheetNames[i]!;
    const num = i + 1;
    wbXml += `<sheet name="${name}" sheetId="${num}" r:id="rId${num}"/>`;

    const data = sheets[name]!;
    let sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;

    for (let r = 0; r < data.length; r++) {
      const row = data[r]!;
      sheetXml += `<row r="${r + 1}">`;
      for (let c = 0; c < row.length; c++) {
        const val = row[c]!;
        const colLetter = String.fromCharCode(65 + c);
        const cellRef = `${colLetter}${r + 1}`;
        const sId = getStringId(val);
        sheetXml += `<c r="${cellRef}" t="s"><v>${sId}</v></c>`;
      }
      sheetXml += `</row>`;
    }
    sheetXml += `</sheetData></worksheet>`;
    files[`xl/worksheets/sheet${num}.xml`] = sheetXml;
  }
  wbXml += `</sheets></workbook>`;
  files["xl/workbook.xml"] = wbXml;

  let sstXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`;
  for (const str of sharedStrings) {
    sstXml += `<si><t>${str}</t></si>`;
  }
  sstXml += `</sst>`;
  files["xl/sharedStrings.xml"] = sstXml;

  return createTestZip(files);
}

/**
 * Create a valid minimal PDF file in memory.
 */
export function createTestPdf(pages: string[], metadata?: { title?: string; author?: string }): Uint8Array {
  const parts: string[] = ["%PDF-1.4\n"];
  const offsets: number[] = [0];

  function addObj(id: number, content: string): void {
    const str = `${id} 0 obj\n${content}\nendobj\n`;
    parts.push(str);
  }

  // 1: Catalog
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);

  // Page IDs: start at 4, each page gets a content stream at ID + 100
  const pageIds: number[] = [];
  const contentMap = new Map<number, number>();
  for (let i = 0; i < pages.length; i++) {
    const pageId = 4 + i;
    const contentId = 100 + i;
    pageIds.push(pageId);
    contentMap.set(pageId, contentId);
  }

  // 2: Pages tree
  addObj(2, `<< /Type /Pages /Kids [ ${pageIds.map((id) => `${id} 0 R`).join(" ")} ] /Count ${pages.length} >>`);

  // 3: Info dictionary
  const infoParts: string[] = [];
  if (metadata?.title) infoParts.push(`/Title (${metadata.title})`);
  if (metadata?.author) infoParts.push(`/Author (${metadata.author})`);
  addObj(3, `<< ${infoParts.join(" ")} >>`);

  // Page objects and content streams
  for (let i = 0; i < pages.length; i++) {
    const pageId = pageIds[i]!;
    const contentId = contentMap.get(pageId)!;
    const text = pages[i]!;

    addObj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] /Contents ${contentId} 0 R >>`);

    const streamData = `BT\n/F1 12 Tf\n100 700 Td\n(${text}) Tj\nET\n`;
    addObj(contentId, `<< /Length ${streamData.length} >>\nstream\n${streamData}endstream`);
  }

  parts.push("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 200 /Root 1 0 R /Info 3 0 R >>\nstartxref\n100\n%%EOF\n");

  const fullStr = parts.join("");
  return new TextEncoder().encode(fullStr);
}

/**
 * Create a minimal valid 1x1 PNG.
 */
export function createTestPng(width = 1, height = 1): Uint8Array {
  const buf = Buffer.alloc(24);
  buf.writeUInt8(0x89, 0);
  buf.writeUInt8(0x50, 1); // P
  buf.writeUInt8(0x4e, 2); // N
  buf.writeUInt8(0x47, 3); // G
  buf.writeUInt8(0x0d, 4);
  buf.writeUInt8(0x0a, 5);
  buf.writeUInt8(0x1a, 6);
  buf.writeUInt8(0x0a, 7);

  // IHDR chunk
  buf.writeUInt32BE(13, 8); // length
  buf.write("IHDR", 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return new Uint8Array(buf);
}

/**
 * Create a minimal valid BMP.
 */
export function createTestBmp(width = 1, height = 1): Uint8Array {
  const buf = Buffer.alloc(26);
  buf.write("BM", 0);
  buf.writeUInt32LE(26, 2); // file size
  buf.writeUInt32LE(26, 10); // offset
  buf.writeUInt32LE(40, 14); // DIB header size
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return new Uint8Array(buf);
}

/**
 * Create a PDF with escaped parens, hex UTF-16BE strings, and TJ kerning arrays.
 */
export function createAdversarialPdf(): Uint8Array {
  const parts: string[] = ["%PDF-1.4\n"];

  function addObj(id: number, content: string): void {
    parts.push(`${id} 0 obj\n${content}\nendobj\n`);
  }

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>`);
  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] /Contents 4 0 R >>`);

  // Stream contains:
  // 1. Escaped parens in Tj: (Security \(Classified\) \\ Path) Tj
  // 2. TJ with kerning vs space: [ (K) 10 (e) 10 (r) 10 (n) -250 (Space) ] TJ
  // 3. Hex string with UTF-16BE in TJ: [ <FEFF00410075006400690074> ] TJ
  // 4. Line break operator: ' (Second line text)
  const streamData = [
    "BT",
    "/F1 12 Tf",
    "100 700 Td",
    "(Security \\(Classified\\) \\\\ Path) Tj",
    "T*",
    "[ (K) 10 (e) 10 (r) 10 (n) -250 (Space) ] TJ",
    "T*",
    "[ <FEFF00410075006400690074> ] TJ",
    "(Second line text) '",
    "ET",
  ].join("\n");

  addObj(4, `<< /Length ${streamData.length} >>\nstream\n${streamData}\nendstream`);
  parts.push("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n");

  return new TextEncoder().encode(parts.join(""));
}

/**
 * Create a PDF where page order in /Kids is [ 20 0 R 10 0 R ] (non-sequential object IDs).
 */
export function createNonSequentialPagePdf(): Uint8Array {
  const parts: string[] = ["%PDF-1.4\n"];

  function addObj(id: number, content: string): void {
    parts.push(`${id} 0 obj\n${content}\nendobj\n`);
  }

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [ 20 0 R 10 0 R ] /Count 2 >>`);

  // Object 10: Page 2
  addObj(10, `<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>`);
  const s2 = "BT\n(Content of Second Page) Tj\nET";
  addObj(11, `<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`);

  // Object 20: Page 1
  addObj(20, `<< /Type /Page /Parent 2 0 R /Contents 21 0 R >>`);
  const s1 = "BT\n(Content of First Page) Tj\nET";
  addObj(21, `<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`);

  parts.push("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 30 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n");

  return new TextEncoder().encode(parts.join(""));
}

/**
 * Create a DOCX with tracked changes deleted text and adjacent formatted runs.
 */
export function createFormattedRunDocx(): Uint8Array {
  const bodyXml = [
    '<w:p><w:r><w:t>auto</w:t></w:r><w:r><w:t>matic</w:t></w:r><w:r><w:t> token</w:t></w:r></w:p>',
    '<w:p><w:del><w:r><w:t>DELETED SENSITIVE DATA</w:t></w:r></w:del><w:r><w:t>Active Data</w:t></w:r></w:p>',
  ].join("");

  const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`;
  return createTestZip({
    "word/document.xml": docXml,
  });
}

/**
 * Create an XLSX with reverse attribute ordering and boolean / styled cell definitions.
 */
export function createFlexibleAttrXlsx(): Uint8Array {
  // sheetId comes before name in <sheet>
  const wbXml = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet sheetId="2" name="ReversedAttrs" r:id="rId1"/></sheets></workbook>`;
  const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c s="99" t="s" r="A1"><v>0</v></c><c t="b" r="B1"><v>1</v></c></row></sheetData></worksheet>`;
  const sstXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>DynamicValue</t></si></sst>`;

  return createTestZip({
    "xl/workbook.xml": wbXml,
    "xl/worksheets/sheet1.xml": sheetXml,
    "xl/sharedStrings.xml": sstXml,
  });
}

/**
 * Create a modern PDF 1.5+ using /Type /ObjStm object stream containing compressed objects.
 */
export function createObjStmPdf(): Uint8Array {
  const parts: string[] = ["%PDF-1.5\n"];

  function addObj(id: number, content: string): void {
    parts.push(`${id} 0 obj\n${content}\nendobj\n`);
  }

  // 1: Catalog
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  // 2: Pages root
  addObj(2, `<< /Type /Pages /Kids [ 10 0 R ] /Count 1 >>`);

  // Compressed sub-object inside Object Stream:
  // Sub-object 10: Page dictionary << /Type /Page /Parent 2 0 R /Contents 20 0 R >>
  const sub10 = "<< /Type /Page /Parent 2 0 R /Contents 20 0 R >>";
  const header = `10 0\n`;
  const streamData = header + sub10;

  // 3: Object Stream object
  addObj(3, `<< /Type /ObjStm /N 1 /First ${header.length} /Length ${streamData.length} >>\nstream\n${streamData}\nendstream`);

  // 20: Content stream for page 10
  const c20 = "BT\n(Unpacked from PDF 1.5 Object Stream) Tj\nET";
  addObj(20, `<< /Length ${c20.length} >>\nstream\n${c20}\nendstream`);

  parts.push("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 30 /Root 1 0 R >>\nstartxref\n100\n%%EOF\n");
  return new TextEncoder().encode(parts.join(""));
}

