// FORGE Pure-TypeScript PKZIP Archive Reader.
// Parses Central Directory headers and decompresses OpenXML packages (.docx, .pptx, .xlsx)
// with built-in decompression bomb and memory boundary protection.

import { inflateRawSync } from "node:zlib";
import { DocumentParseError } from "./types.js";

const MAX_ZIP_ENTRIES = 2_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MiB
const MAX_SINGLE_ENTRY_BYTES = 30 * 1024 * 1024; // 30 MiB
const MAX_COMPRESSION_RATIO = 100;

interface ZipEntryHeader {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipReader {
  private entries = new Map<string, ZipEntryHeader>();
  private totalUncompressedSize = 0;
  private cumulativeDecompressedBytes = 0;

  constructor(private readonly buffer: Buffer) {
    this.parseCentralDirectory();
  }

  public static fromUint8Array(bytes: Uint8Array): ZipReader {
    return new ZipReader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private parseCentralDirectory(): void {
    const buf = this.buffer;
    if (buf.length < 22) {
      throw new DocumentParseError("CORRUPTED", "file too short to be a valid zip archive");
    }

    // 1. Locate End of Central Directory Record (EOCD signature 0x06054b50)
    // Scan backwards from end of buffer (comment can be up to 65535 bytes)
    let eocdOffset = -1;
    const maxScan = Math.min(buf.length - 22, 65535 + 22);
    for (let i = buf.length - 22; i >= buf.length - 22 - maxScan; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset === -1) {
      throw new DocumentParseError("CORRUPTED", "end of central directory record not found");
    }

    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);

    if (totalEntries > MAX_ZIP_ENTRIES) {
      throw new DocumentParseError("OVERSIZED", `archive exceeds max entry limit (${totalEntries} > ${MAX_ZIP_ENTRIES})`);
    }

    if (cdOffset + cdSize > buf.length) {
      throw new DocumentParseError("CORRUPTED", "central directory points beyond archive bounds");
    }

    // 2. Parse Central Directory entries
    let offset = cdOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (offset + 46 > buf.length) break;
      const sig = buf.readUInt32LE(offset);
      if (sig !== 0x02014b50) break; // Central Directory header signature

      const method = buf.readUInt16LE(offset + 10);
      const compressedSize = buf.readUInt32LE(offset + 20);
      const uncompressedSize = buf.readUInt32LE(offset + 24);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const localOffset = buf.readUInt32LE(offset + 42);

      const nameStart = offset + 46;
      if (nameStart + nameLen > buf.length) break;
      const rawName = buf.toString("utf8", nameStart, nameStart + nameLen);
      const name = this.normalizePath(rawName);

      // Check declared compression ratio for decompression bomb indicator
      if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO && uncompressedSize > 1024 * 1024) {
        throw new DocumentParseError("OVERSIZED", `suspicious compression ratio (${Math.round(uncompressedSize / compressedSize)}:1) for "${name}" (potential zip bomb)`);
      }

      // Guard total uncompressed size (zip bomb protection)
      this.totalUncompressedSize += uncompressedSize;
      if (this.totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new DocumentParseError("OVERSIZED", "zip uncompressed size exceeds maximum safety bound (100MB)");
      }

      this.entries.set(name, {
        name,
        compressionMethod: method,
        compressedSize,
        uncompressedSize,
        localHeaderOffset: localOffset,
      });

      offset += 46 + nameLen + extraLen + commentLen;
    }
  }

  public listFiles(): string[] {
    return Array.from(this.entries.keys());
  }

  public has(filename: string): boolean {
    return this.entries.has(this.normalizePath(filename));
  }

  public read(filename: string): Buffer {
    const normName = this.normalizePath(filename);
    const entry = this.entries.get(normName);
    if (!entry) {
      throw new DocumentParseError("PARSE_ERROR", `file "${filename}" not found in zip archive`);
    }

    if (entry.uncompressedSize > MAX_SINGLE_ENTRY_BYTES) {
      throw new DocumentParseError("OVERSIZED", `file "${filename}" exceeds single entry size bound`);
    }

    const buf = this.buffer;
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > buf.length) {
      throw new DocumentParseError("CORRUPTED", `invalid local header offset for "${filename}"`);
    }

    const localSig = buf.readUInt32LE(localOffset);
    if (localSig !== 0x04034b50) {
      throw new DocumentParseError("CORRUPTED", `invalid local header signature for "${filename}"`);
    }

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + entry.compressedSize;

    if (dataEnd > buf.length) {
      throw new DocumentParseError("CORRUPTED", `compressed data for "${filename}" exceeds buffer`);
    }

    const compressedSlice = buf.subarray(dataStart, dataEnd);
    let decompressed: Buffer;

    if (entry.compressionMethod === 0) {
      // Stored (no compression)
      decompressed = Buffer.from(compressedSlice);
    } else if (entry.compressionMethod === 8) {
      // Deflate
      try {
        decompressed = inflateRawSync(compressedSlice, { maxOutputLength: MAX_SINGLE_ENTRY_BYTES });
      } catch (err) {
        throw new DocumentParseError("CORRUPTED", `failed to decompress "${filename}": ${String(err)}`, err);
      }
    } else {
      throw new DocumentParseError("UNSUPPORTED_FORMAT", `unsupported zip compression method (${entry.compressionMethod})`);
    }

    // Guard actual expansion ratio
    if (compressedSlice.length > 0 && decompressed.length / compressedSlice.length > MAX_COMPRESSION_RATIO && decompressed.length > 1024 * 1024) {
      throw new DocumentParseError("OVERSIZED", `decompressed expansion ratio exceeds safety bound (potential zip bomb)`);
    }

    // Cumulative decompressed size guard across multiple read() operations
    this.cumulativeDecompressedBytes += decompressed.length;
    if (this.cumulativeDecompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new DocumentParseError("OVERSIZED", "cumulative uncompressed size exceeds maximum safety bound (100MB)");
    }

    return decompressed;
  }

  public readText(filename: string): string {
    const b = this.read(filename);
    return b.toString("utf8");
  }
}
