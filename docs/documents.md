# Governed Document & Multimodal Ingestion Engine

FORGE implements a native, zero-external-binary document and multimodal ingestion engine governed by the Authority Gate and anchored to the cryptographic ledger.

Unlike systems that shell out to arbitrary Python scripts, invoke heavy unverified CLI tools, or feed untrusted documents directly to the LLM context, FORGE maintains its core invariant:

$$\text{Model} \to \text{doc\_parse Proposal} \to \text{Authority Gate} \to \text{Capability Host} \to \text{Document Parser} \to \text{Bounded Extraction} \to \text{Content-Addressed Artifact} \to \text{observation.doc\_parse} \to \text{Cryptographic Ledger} \to \text{Context Assembly}$$

---

## 1. Core Principles

1. **Gate Authority Invariant**: Inspecting any document requires an active grant covering the resolved workspace path. Path traversal (`../`), null-byte smuggling, and symlink escapes are rejected at the Gate.
2. **Untrusted Content Isolation**: All parsed textual content is classified as untrusted external data and fenced during context assembly with injection-resistant delimiters:
   ```text
   <<< UNTRUSTED_DOCUMENT_CONTENT (path: docs/spec.pdf, mime: application/pdf, parser: pdf) >>>
   ...
   <<< END_UNTRUSTED_DOCUMENT_CONTENT >>>
   ```
3. **Pure-TypeScript / Zero-Dependency Runtime**: Built purely with TypeScript and Node.js built-ins (`node:zlib`, `node:crypto`). No dependencies on `libreoffice`, `poppler-utils`, `pdfjs`, or python packages.
4. **Adversarial Input Hardening & Zip Bomb Protection**:
   - Deflate/Zip bomb safeguards: maximum uncompressed entry limits and expansion ratio checks.
   - Sniffing and spoofing validation: magic bytes are validated against declared extensions to catch disguised executables.
   - XML Bomb & Billion Laughs prevention: safe regex/SAX scanning without DTD entity expansion.
5. **Deterministic Ledger Anchoring**: Every extraction records a runtime-authored `observation.doc_parse` entry into `journal.jsonl`, storing extracted text and metadata as content-addressed SHA-256 artifacts in `.forge/artifacts/`.

---

## 2. Supported Formats & Extraction Capabilities

### Tier 1 — Native Text & Structured Data
- **Plain Text & Markdown** (`.txt`, `.md`): Clean UTF-8 extraction, control character sanitization.
- **CSV** (`.csv`): RFC 4180 compliant parsing, escaped quotes, multiline cells, delimiter detection, and tabular formatting.
- **JSON & JSONL** (`.json`, `.jsonl`): Parse and format; auto-summarizes structural schemas for oversized payloads.
- **YAML** (`.yaml`, `.yml`): Document and key-value mapping extraction.
- **XML / HTML** (`.xml`, `.html`, `.xhtml`): Tag stripping, attribute and entity decoding, tag hierarchy preservation.

### Tier 2 — Office Documents & PDF
- **PDF** (`.pdf`):
  - Pure-TypeScript PDF parser.
  - Page catalog and object stream resolution (`/Pages`, `/Kids`, `/MediaBox`).
  - `/FlateDecode` stream decompression via `node:zlib.inflateRawSync`.
  - Text operator parsing (`Tj`, `TJ`, `ET`, `BT`) with font encoding and spacing heuristics.
  - Page-range bounding (extract up to `maxPages`).
- **DOCX** (`.docx`):
  - Pure-TypeScript PKZIP central directory reader.
  - Extracts `word/document.xml`.
  - Preserves paragraphs, headings (`Heading 1-6`), bullet lists, and converts `w:tbl` tables into GitHub-flavored markdown tables.
- **PPTX** (`.pptx`):
  - Extracts `ppt/slides/slideN.xml` and `ppt/notesSlides/notesSlideN.xml`.
  - Formats content cleanly by slide numbers with presenter notes.
- **XLSX** (`.xlsx`):
  - Extracts `xl/workbook.xml`, `xl/sharedStrings.xml`, and `xl/worksheets/sheetN.xml`.
  - Resolves cell types (string, inline string, number, formula, boolean).
  - Formats each worksheet as a clean GitHub-flavored markdown table with column alignment.
  - Supports targeting specific sheets via `sheet` parameter.

### Tier 3 — Images & Visual Artifacts
- **Image Formats** (`.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.gif`):
  - Header inspection extracting image dimensions (width $\times$ height), color channels, and MIME type.
  - Content hashing and artifact capture.
  - Vision decoupling: returns image metadata and content reference immediately; vision status is flagged as `"unsupported"` (or ready for downstream vision provider).

---

## 3. Proposal & Observation Contracts

### Proposal Schema (`doc_parse`)
```json
{
  "capability": "doc_parse",
  "args": {
    "path": "docs/architecture.pdf",
    "mode": "auto",
    "maxBytes": 2097152,
    "pages": [1, 2, 3],
    "sheet": "Financials",
    "includeImages": false
  }
}
```

Parameters:
- `path` *(required)*: Relative path within granted workspace.
- `mode` *(optional, default: `"auto"`)*: Extraction mode:
  - `"auto"`: Intelligent parsing based on MIME/format.
  - `"text"`: Force plain-text extraction.
  - `"structure"`: Extract hierarchical structure, TOC, and metadata.
  - `"tables"`: Extract only tables (CSV/XLSX/DOCX).
  - `"metadata"`: Extract only document headers, dimensions, page counts, and authoring metadata.
- `maxBytes` *(optional, max: `2 MB`)*: Maximum extracted text bytes.
- `pages` *(optional)*: Array of 1-based page numbers to extract for PDF.
- `sheet` *(optional)*: Specific sheet name to extract for XLSX.
- `includeImages` *(optional)*: Include embedded images or image metadata.

### Observation Record (`observation.doc_parse`)
```json
{
  "kind": "observation.doc_parse",
  "author": "runtime",
  "body": {
    "path": "docs/architecture.pdf",
    "mime": "application/pdf",
    "parser": "pdf",
    "parserVersion": "1.0.0",
    "status": "success",
    "byteLength": 1048576,
    "contentRef": "9f83c12...",
    "metadataRef": "e3b0c44...",
    "pageCount": 12,
    "sheetCount": 0,
    "imageCount": 0,
    "truncated": false,
    "durationMs": 45
  }
}
```

---

## 4. Resource Limits & Quotas

| Parameter | Limit | Enforcement Point |
|---|---|---|
| Max File Size | 50 MB | Capability Host (`docParseImpl`) |
| Max Extracted Text | 2 MB | Document Parser (`truncateText`) |
| Max CSV Rows | 50,000 | Text Parser |
| Max CSV Columns | 500 | Text Parser |
| Max XLSX Sheets | 20 | Office Parser |
| Max XLSX Cells | 100,000 | Office Parser |
| Max Decompressed Ratio | 100:1 | PKZIP Reader (`MAX_EXPANSION_RATIO`) |
| Execution Timeout | 60 seconds | Capability Host Timeout Gate |

---

## 5. Security & Isolation Model

- **Safe Path Resolution**: Gate calls `resolveReal(path)` to verify the canonical target lies strictly within the granted filesystem path boundary before capability dispatch.
- **Fenced Model Prompts**: The parser's raw output is never concatenated directly into model instructions. It is wrapped in defensive delimiters that prevent prompt injection or hijacked system directives embedded inside malicious documents.
- **Secret Scrubbing**: Before persisting extracted document text into content-addressed artifacts or ledger observations, the redactor scrubs any active secrets.
