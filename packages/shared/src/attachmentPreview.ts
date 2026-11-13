export const CSV_PREVIEW_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
// Parsing is synchronous CPU on the server request path (task #19): above this
// the preview falls back to the download card.
export const XLSX_PREVIEW_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
// Markdown previews show at most this many bytes of the file; a larger file
// previews its beginning, cut at a whole line, with `truncated: true` (task
// #164). Sized by measured render cost, not transfer: a ~1 MB agent-style
// report took ~2 s to render (~3 s until its mermaid diagram) on an M4 in a
// production build, 512 KB under 1 s.
export const MARKDOWN_PREVIEW_BYTE_LIMIT = 512 * 1024;
// Ceiling on the JSON-encoded markdown payload. Escaping inflates ordinary
// markdown ~3%, so this only refuses pathological (control-character heavy)
// content; the operative limit is MARKDOWN_PREVIEW_BYTE_LIMIT.
export const MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT = 2 * MARKDOWN_PREVIEW_BYTE_LIMIT;
// Text previews read at most this many bytes of the file.
export const TEXT_PREVIEW_BYTE_LIMIT = 96 * 1024;

const NEWLINE_BYTE = 0x0a;

/**
 * The longest prefix of a byte-capped read that ends on a whole line: through
 * the last newline, so a truncated text or markdown preview never ends mid-line
 * (or mid-fence). A prefix with no newline at all falls back to the last
 * complete UTF-8 character, so a strict decoder never sees a split sequence.
 * Only meaningful for a prefix that was actually truncated.
 */
export function previewPrefixAtLineBoundary<TBuffer extends ArrayBufferLike>(bytes: Uint8Array<TBuffer>): Uint8Array<TBuffer> {
  const newline = bytes.lastIndexOf(NEWLINE_BYTE);
  if (newline >= 0) return bytes.subarray(0, newline + 1);
  return bytes.subarray(0, utf8CompletePrefixLength(bytes));
}

function utf8CompletePrefixLength(bytes: Uint8Array): number {
  // Walk back over at most three continuation bytes to the lead byte of the
  // last sequence; drop that sequence if it is shorter than its lead declares.
  let start = bytes.length - 1;
  while (start >= 0 && bytes.length - start <= 4 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!;
  const declared = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < declared ? start : bytes.length;
}

// Non-text/* MIME types that are still plain text in practice.
const TEXT_PREVIEW_MIME_TYPES = new Set([
  "text/plain",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
]);

const TEXT_PREVIEW_MIME_EXCLUSIONS = new Set([
  "text/markdown",
  "text/csv",
  "text/html",
]);

// Common text-like files that frequently arrive with a generic
// application/octet-stream MIME from upload clients.
const TEXT_PREVIEW_FILE_EXTENSIONS = [
  ".txt", ".text", ".log", ".ini", ".conf", ".cfg", ".properties", ".toml",
  ".yaml", ".yml", ".json", ".xml", ".sql", ".gradle",
  ".sh", ".bash", ".zsh",
  ".kt", ".kts", ".java", ".swift", ".ets",
  ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".py", ".rb", ".go", ".rs", ".c", ".h", ".cpp", ".hpp",
];

export function isTextPreviewCandidate(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (TEXT_PREVIEW_FILE_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) return true;
  if (TEXT_PREVIEW_MIME_TYPES.has(normalizedMime)) return true;
  return normalizedMime.startsWith("text/") && !TEXT_PREVIEW_MIME_EXCLUSIONS.has(normalizedMime);
}

export interface DiffAttachmentPreviewData {
  kind: "diff";
  stats: {
    files: number;
    hunks: number;
    additions: number;
    deletions: number;
  };
}

export interface CsvAttachmentPreviewData {
  kind: "csv";
  delimiter: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
}

export interface XlsxSheetPreviewData {
  name: string;
  headers: string[];
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
}

export interface XlsxAttachmentPreviewData {
  kind: "xlsx";
  sheets: XlsxSheetPreviewData[];
  sheetCount: number;
  truncated: boolean;
}

export interface MarkdownAttachmentPreviewData {
  kind: "markdown";
  markdown: string;
  /** Set when the preview is a line-cut prefix: bytes of the file shown. */
  previewByteLength?: number;
  /** Set alongside previewByteLength: the whole file's size in bytes. */
  sourceByteLength?: number;
}

export interface PdfAttachmentPreviewData {
  kind: "pdf";
}

export interface TextAttachmentPreviewData {
  kind: "text";
  text: string;
}

export type AttachmentPreviewData =
  | DiffAttachmentPreviewData
  | CsvAttachmentPreviewData
  | XlsxAttachmentPreviewData
  | MarkdownAttachmentPreviewData
  | PdfAttachmentPreviewData
  | TextAttachmentPreviewData;

// "unavailable" is transient (compute capacity, not the file): callers may
// retry later, and caches must not pin it.
export type AttachmentPreviewResponse =
  | { status: "ok"; data: AttachmentPreviewData; truncated?: boolean }
  | { status: "unsupported"; reason?: "unreadable" | "encrypted" | "corrupt" | "too_large" | "unsupported" | "unavailable" };

/**
 * What an attachment card shows before anyone opens the file: the kind and,
 * for diff/csv, its stats line. `GET /attachments/:id/preview?view=summary`
 * answers with this instead of the full payload (task #164): a channel of
 * markdown cards fetched every file's whole preview — up to
 * MARKDOWN_PREVIEW_BYTE_LIMIT each — just to print "Markdown document".
 */
export type AttachmentPreviewSummaryData =
  | DiffAttachmentPreviewData
  | { kind: "csv"; rowsShown: number; rowCount: number; columnCount: number }
  | { kind: "xlsx" | "markdown" | "pdf" | "text" };

export type AttachmentPreviewSummaryResponse =
  | { status: "ok"; data: AttachmentPreviewSummaryData; truncated?: boolean }
  | Extract<AttachmentPreviewResponse, { status: "unsupported" }>;

export function summarizeAttachmentPreviewResponse(response: AttachmentPreviewResponse): AttachmentPreviewSummaryResponse {
  if (response.status !== "ok") return response;
  const { data } = response;
  const summary: AttachmentPreviewSummaryData = data.kind === "diff"
    ? { kind: "diff", stats: data.stats }
    : data.kind === "csv"
      ? { kind: "csv", rowsShown: data.rows.length, rowCount: data.rowCount, columnCount: data.columnCount }
      : { kind: data.kind };
  return response.truncated === undefined
    ? { status: "ok", data: summary }
    : { status: "ok", data: summary, truncated: response.truncated };
}
