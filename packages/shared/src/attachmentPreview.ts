export const CSV_PREVIEW_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
export const XLSX_PREVIEW_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

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

export type AttachmentPreviewResponse =
  | { status: "ok"; data: AttachmentPreviewData; truncated?: boolean }
  | { status: "unsupported"; reason?: "unreadable" | "encrypted" | "corrupt" | "too_large" | "unsupported" };
