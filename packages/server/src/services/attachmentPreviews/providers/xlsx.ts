import { crc32, inflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";
import { XLSX_PREVIEW_MAX_FILE_SIZE_BYTES, type XlsxAttachmentPreviewData, type XlsxSheetPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";

export const XLSX_PREVIEW_BYTE_LIMIT = XLSX_PREVIEW_MAX_FILE_SIZE_BYTES;
export const XLSX_PREVIEW_PAYLOAD_BYTE_LIMIT = 64 * 1024;
export const XLSX_PREVIEW_MAX_SHEETS = 20;
export const XLSX_PREVIEW_MAX_ROWS = 200;
export const XLSX_PREVIEW_MAX_COLUMNS = 20;
export const XLSX_PREVIEW_MAX_CELLS = 10_000;
const XLSX_MAX_ZIP_ENTRIES = 512;
const XLSX_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function isXlsxAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lowerName.endsWith(".xlsx") || XLSX_MIME_TYPES.has(normalizedMime);
}

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** ZIP64 extras can override sizes even without a 0xffffffff sentinel. */
function hasSupportedZipExtras(buffer: Buffer, start: number, length: number): boolean {
  const end = start + length;
  if (end > buffer.length) return false;
  for (let cursor = start; cursor < end;) {
    if (cursor + 4 > end) return false;
    const kind = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    if (kind === 0x0001) return false;
    cursor += 4 + size;
    if (cursor > end) return false;
  }
  return true;
}

/**
 * Check the same local records and end record that SheetJS consumes, not just
 * central-directory declarations. Also inflate with a hard output bound first:
 * consistent but forged small lengths must not admit an oversized stream.
 * No unvalidated workbook bytes reach the SheetJS allocator/ZIP decoder.
 */
function hasSafeZipEnvelope(buffer: Buffer): boolean {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return false;
  let eocd = -1;
  // SheetJS scans backwards for the last signature, including the ZIP comment.
  // A later embedded signature must not select a different directory there.
  for (let offset = buffer.length - 4; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > buffer.length) return false;
  if (eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) return false;
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) return false;
  if (buffer.readUInt16LE(eocd + 8) !== entries) return false;
  if (entries === 0 || entries > XLSX_MAX_ZIP_ENTRIES) return false;
  if (centralOffset + centralSize !== eocd) return false;

  let cursor = centralOffset;
  let totalUncompressed = 0;
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) return false;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const filenameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nextCentral = nameStart + filenameLength + extraLength + commentLength;
    // Only stored/DEFLATE, optional data descriptor and UTF-8 names are used.
    // Bits 1/2 encode DEFLATE compression level; encrypted/unknown flags reject.
    if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) return false;
    if (buffer.readUInt16LE(cursor + 34) !== 0 || nextCentral > eocd) return false;
    if (!hasSupportedZipExtras(buffer, nameStart + filenameLength, extraLength)) return false;
    if (uncompressedSize > XLSX_MAX_ENTRY_UNCOMPRESSED_BYTES) return false;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > XLSX_MAX_UNCOMPRESSED_BYTES) return false;

    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) return false;
    if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method) return false;
    const localChecksum = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > centralOffset || localNameLength !== filenameLength) return false;
    if (!buffer.subarray(localNameStart, localNameStart + localNameLength).equals(buffer.subarray(nameStart, nameStart + filenameLength))) return false;
    if (!hasSupportedZipExtras(buffer, localNameStart + localNameLength, localExtraLength)) return false;

    let localEnd = dataEnd;
    if (flags & 8) {
      // Streaming ZIP writers may leave zero sizes/CRC in the local header.
      // Nonzero fields must agree; the descriptor itself must be exact.
      if ((localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
        || (localChecksum !== 0 && localChecksum !== checksum)) return false;
      if (localEnd + 12 > centralOffset) return false;
      if (buffer.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > centralOffset
        || buffer.readUInt32LE(localEnd) !== checksum
        || buffer.readUInt32LE(localEnd + 4) !== compressedSize
        || buffer.readUInt32LE(localEnd + 8) !== uncompressedSize) return false;
      localEnd += 12;
      // SheetJS cannot locate a stored entry's descriptor from a zero local size.
      if (method === 0 && localCompressedSize !== compressedSize) return false;
    } else if (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize || localChecksum !== checksum) {
      return false;
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    let inflated: Buffer;
    if (method === 0) {
      if (compressedSize !== uncompressedSize) return false;
      inflated = compressed;
    } else {
      try {
        // Node's info:true form returns the buffer plus consumed-input count;
        // the installed Node type declarations only model the Buffer form.
        const result = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, uncompressedSize),
          info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== compressedSize) return false;
        inflated = result.buffer;
      } catch {
        return false;
      }
    }
    if (inflated.length !== uncompressedSize || crc32(inflated) !== checksum) return false;
    localRanges.push({ start: localOffset, end: localEnd });
    cursor = nextCentral;
  }
  if (cursor !== eocd) return false;
  localRanges.sort((a, b) => a.start - b.start);
  return localRanges.every((range, index) => index === 0 || range.start >= localRanges[index - 1].end);
}

function getSheetRange(sheet: XLSX.WorkSheet): XLSX.Range | null {
  const reference = sheet["!fullref"] ?? sheet["!ref"];
  if (!reference) return null;
  try {
    return XLSX.utils.decode_range(reference);
  } catch {
    return null;
  }
}

function buildSheetPreview(name: string, sheet: XLSX.WorkSheet): XlsxSheetPreviewData {
  const range = getSheetRange(sheet);
  const originalRows = range ? Math.max(0, range.e.r - range.s.r + 1) : 0;
  const originalColumns = range ? Math.max(0, range.e.c - range.s.c + 1) : 0;
  const rowLimit = Math.min(XLSX_PREVIEW_MAX_ROWS + 1, XLSX_PREVIEW_MAX_CELLS);
  const columnLimit = Math.min(XLSX_PREVIEW_MAX_COLUMNS, XLSX_PREVIEW_MAX_CELLS);
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    // Keep empty rows inside the declared range. Omitting them would make
    // `rows.length` smaller than `rowCount`, causing a normal sparse sheet to
    // be reported as truncated by the preview registry.
    blankrows: true,
    range: range ? {
      s: range.s,
      e: {
        r: Math.min(range.e.r, range.s.r + Math.max(0, rowLimit - 1)),
        c: Math.min(range.e.c, range.s.c + Math.max(0, columnLimit - 1)),
      },
    } : undefined,
  })
    .slice(0, rowLimit)
    .map((row) => row.slice(0, Math.min(columnLimit, originalColumns)).map(cellToString));

  const headers = rows[0] ?? [];
  const previewRows = rows.slice(1, XLSX_PREVIEW_MAX_ROWS + 1);
  const rowCount = Math.max(0, originalRows - 1);
  const columnCount = originalColumns;
  const truncated = originalRows > XLSX_PREVIEW_MAX_ROWS + 1
    || originalColumns > XLSX_PREVIEW_MAX_COLUMNS
    || originalRows * originalColumns > XLSX_PREVIEW_MAX_CELLS;

  return {
    name,
    headers,
    rows: previewRows,
    rowCount,
    columnCount,
    truncated,
  };
}

/**
 * Parse XLSX as inert cell data. SheetJS reads the workbook structure but does
 * not execute formulas, macros, links, or scripts; formula text is excluded by
 * `cellFormula: false`, and all HTML/style metadata is discarded.
 */
export function buildXlsxPreview(buffer: Buffer): XlsxAttachmentPreviewData | null {
  if (buffer.length === 0 || buffer.length > XLSX_PREVIEW_BYTE_LIMIT || !hasSafeZipEnvelope(buffer)) return null;
  try {
    const workbook = XLSX.read(buffer, {
      type: "buffer",
      WTF: false,
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      cellDates: false,
      bookDeps: false,
      bookFiles: false,
      bookProps: false,
      bookSheets: false,
      bookVBA: false,
      sheetRows: XLSX_PREVIEW_MAX_ROWS + 1,
    });
    const allNames = workbook.SheetNames;
    const names = allNames.slice(0, XLSX_PREVIEW_MAX_SHEETS);
    const sheets = names.map((name) => buildSheetPreview(name, workbook.Sheets[name]));
    const preview: XlsxAttachmentPreviewData = {
      kind: "xlsx",
      sheets,
      sheetCount: allNames.length,
      truncated: allNames.length > XLSX_PREVIEW_MAX_SHEETS || sheets.some((sheet) => sheet.truncated),
    };
    while (Buffer.byteLength(JSON.stringify(preview), "utf8") > XLSX_PREVIEW_PAYLOAD_BYTE_LIMIT) {
      const target = [...preview.sheets].reverse().find((sheet) => sheet.rows.length > 0);
      if (!target) return null;
      target.rows.pop();
      target.truncated = true;
      preview.truncated = true;
    }
    return preview;
  } catch {
    return null;
  }
}

export const xlsxPreviewProvider: AttachmentPreviewProvider<XlsxAttachmentPreviewData> = {
  kind: "xlsx",
  trustLevel: "data",
  streamByteCap: XLSX_PREVIEW_BYTE_LIMIT,
  payloadByteCap: XLSX_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => (
    isXlsxAttachment(attachment.filename, attachment.mimeType)
    && attachment.sizeBytes <= XLSX_PREVIEW_MAX_FILE_SIZE_BYTES
  ),
  async buildPreview({ buffer }) {
    return buildXlsxPreview(buffer);
  },
};
