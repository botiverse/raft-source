import { CSV_PREVIEW_MAX_FILE_SIZE_BYTES, type CsvAttachmentPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";
import { decodeUtf8Text } from "./text.js";

export const CSV_PREVIEW_BYTE_LIMIT = 128 * 1024;
export const CSV_PREVIEW_PAYLOAD_BYTE_LIMIT = 32 * 1024;
export const CSV_PREVIEW_MAX_ROWS = 200;
export const CSV_PREVIEW_MAX_COLUMNS = 12;

const CSV_MIME_TYPES = new Set([
  "text/csv",
  "application/csv",
]);
const LEGACY_EXCEL_MIME_TYPE = "application/vnd.ms-excel";
const LEGACY_EXCEL_EXTENSIONS = [".xls", ".xlt", ".xla", ".xlm", ".xlc", ".xlw"];

function normalizedMimeType(mimeType: string | null | undefined): string {
  return mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
}

function isLegacyExcelFilename(filename: string): boolean {
  const lowerName = filename.toLowerCase();
  return LEGACY_EXCEL_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

export function isCsvAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  if (isLegacyExcelFilename(lowerName)) return false;
  return lowerName.endsWith(".csv") || CSV_MIME_TYPES.has(normalizedMimeType(mimeType));
}

function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", "\t", ";"];
  return candidates
    .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ",";
}

export function parseCsvRows(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

export function buildCsvPreview(text: string): CsvAttachmentPreviewData | null {
  const delimiter = detectDelimiter(text);
  const parsed = parseCsvRows(text, delimiter);
  if (parsed.length === 0) return null;

  const columnCount = Math.max(...parsed.map((row) => row.length));
  const headers = parsed[0].slice(0, CSV_PREVIEW_MAX_COLUMNS);
  const rows = parsed.slice(1, CSV_PREVIEW_MAX_ROWS + 1).map((row) => row.slice(0, CSV_PREVIEW_MAX_COLUMNS));
  const rowCount = Math.max(0, parsed.length - 1);

  const preview: CsvAttachmentPreviewData = {
    kind: "csv",
    delimiter,
    headers,
    rows,
    rowCount,
    columnCount,
  };

  while (preview.rows.length > 0 && Buffer.byteLength(JSON.stringify(preview), "utf8") > CSV_PREVIEW_PAYLOAD_BYTE_LIMIT) {
    preview.rows.pop();
  }

  if (rowCount > 0 && preview.rows.length === 0) return null;

  return preview;
}

/**
 * CSV is a text format, but upload clients sometimes label legacy binary Excel
 * files (`.xls`) as `application/vnd.ms-excel`.  Buffer#toString silently
 * replaces malformed UTF-8, which turns those files into a convincing-looking
 * (but meaningless) CSV table.  Decode strictly and reject binary control
 * characters before handing content to the parser.
 */
function decodeCsvPreviewText(buffer: Buffer): string | null {
  // Legacy `.xls` files are OLE Compound Files. Reject the well-known magic
  // before decoding so a mislabeled binary workbook can never become a table.
  const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (buffer.subarray(0, oleHeader.length).equals(oleHeader)) return null;

  const text = decodeUtf8Text(buffer);
  if (text == null) return null;

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint <= 0x08)
      || (codePoint >= 0x0b && codePoint <= 0x0c)
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f
    ) {
      return null;
    }
  }

  return text;
}

export const csvPreviewProvider: AttachmentPreviewProvider<CsvAttachmentPreviewData> = {
  kind: "csv",
  trustLevel: "data",
  streamByteCap: CSV_PREVIEW_BYTE_LIMIT,
  payloadByteCap: CSV_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => (
    // Legacy Excel MIME is ambiguous: it is used both for text CSV exports and
    // binary `.xls`. Keep it in the candidate set so buildPreview can inspect
    // the bytes and retain text CSV compatibility, but never classify it as
    // CSV from metadata alone.
    (isCsvAttachment(attachment.filename, attachment.mimeType)
      || (normalizedMimeType(attachment.mimeType) === LEGACY_EXCEL_MIME_TYPE
        && !isLegacyExcelFilename(attachment.filename)))
    && attachment.sizeBytes <= CSV_PREVIEW_MAX_FILE_SIZE_BYTES
  ),
  async buildPreview({ buffer }) {
    const text = decodeCsvPreviewText(buffer);
    return text == null ? null : buildCsvPreview(text);
  },
};
