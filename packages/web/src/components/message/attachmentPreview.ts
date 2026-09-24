import { CSV_PREVIEW_MAX_FILE_SIZE_BYTES, isTextPreviewCandidate } from "@botiverse/raft-shared";
import { XLSX_PREVIEW_MAX_FILE_SIZE_BYTES } from "@botiverse/raft-shared";
import type { AttachmentPreviewData, AttachmentPreviewResponse, CsvAttachmentPreviewData, DiffAttachmentPreviewData, XlsxAttachmentPreviewData } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageAttachment } from "../../store/messageStore";

type FormatMessage = IntlShape["formatMessage"];

export type DiffAttachmentPreview = DiffAttachmentPreviewData;
export type CsvAttachmentPreview = CsvAttachmentPreviewData;
export type XlsxAttachmentPreview = XlsxAttachmentPreviewData;
export type DocumentAttachmentPreview = Extract<AttachmentPreviewData, { kind: "csv" | "xlsx" | "markdown" | "pdf" | "text" }>;
export type AttachmentPreview = AttachmentPreviewResponse;

export function isDiffPatchAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return filename.endsWith(".diff") || filename.endsWith(".patch") || mimeType === "text/x-diff" || mimeType === "text/x-patch" || mimeType === "application/x-patch";
}

export function formatDiffPatchStats(
  preview: DiffAttachmentPreview,
  formatMessage: FormatMessage,
): string {
  const { files, hunks, additions, deletions } = preview.stats;
  return `${formatMessage({ id: "message.diff.filesHunks" }, { files, hunks })} · +${additions} -${deletions}`;
}

const LEGACY_EXCEL_EXTENSIONS = [".xls", ".xlt", ".xla", ".xlm", ".xlc", ".xlw"];

export function isCsvAttachment(att: Pick<MessageAttachment, "filename" | "mimeType" | "sizeBytes">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  // `application/vnd.ms-excel` is also the standard MIME for legacy binary
  // `.xls`.  The browser has no content bytes at classification time, so only
  // trust that MIME when the filename independently identifies a CSV.  The
  // server still accepts text-labelled files and performs strict UTF-8/binary
  // validation before building a preview.
  const isLegacyExcel = LEGACY_EXCEL_EXTENSIONS.some((extension) => filename.endsWith(extension));
  const isCsv = !isLegacyExcel && (filename.endsWith(".csv") || mimeType === "text/csv" || mimeType === "application/csv" || mimeType === "application/vnd.ms-excel");
  return isCsv && (typeof att.sizeBytes !== "number" || att.sizeBytes <= CSV_PREVIEW_MAX_FILE_SIZE_BYTES);
}

export function isXlsxAttachment(att: Pick<MessageAttachment, "filename" | "mimeType" | "sizeBytes">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (filename.endsWith(".xlsx") || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    && (typeof att.sizeBytes !== "number" || att.sizeBytes <= XLSX_PREVIEW_MAX_FILE_SIZE_BYTES);
}

export function isMarkdownAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return filename.endsWith(".md") || filename.endsWith(".markdown") || mimeType === "text/markdown" || mimeType === "text/x-markdown";
}

export function isTextAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  return isTextPreviewCandidate(att.filename, att.mimeType);
}

export function isPdfAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return filename.endsWith(".pdf") || mimeType === "application/pdf";
}

export function isVideoPreviewAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return filename.endsWith(".mp4") || filename.endsWith(".webm") || filename.endsWith(".mov") || mimeType === "video/mp4" || mimeType === "video/webm" || mimeType === "video/quicktime";
}

export function isAudioPreviewAttachment(att: Pick<MessageAttachment, "filename" | "mimeType">): boolean {
  const filename = att.filename.toLowerCase();
  const mimeType = att.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    filename.endsWith(".mp3")
    || filename.endsWith(".wav")
    || filename.endsWith(".m4a")
    || filename.endsWith(".aac")
    || filename.endsWith(".ogg")
    || filename.endsWith(".oga")
    || filename.endsWith(".opus")
    || filename.endsWith(".weba")
    || filename.endsWith(".flac")
    || mimeType === "audio/mpeg"
    || mimeType === "audio/mp3"
    || mimeType === "audio/wav"
    || mimeType === "audio/x-wav"
    || mimeType === "audio/wave"
    || mimeType === "audio/aac"
    || mimeType === "audio/mp4"
    || mimeType === "audio/x-m4a"
    || mimeType === "audio/ogg"
    || mimeType === "audio/opus"
    || mimeType === "audio/webm"
    || mimeType === "audio/flac"
    || mimeType === "audio/x-flac"
  );
}

export function isDocumentPreviewAttachment(att: Pick<MessageAttachment, "filename" | "mimeType" | "sizeBytes">): boolean {
  return isCsvAttachment(att) || isXlsxAttachment(att) || isMarkdownAttachment(att) || isPdfAttachment(att) || isTextAttachment(att);
}

/**
 * HTML attachments previewable in the sandboxed frame. Shared so the chat body
 * and the forward composer cannot disagree about what counts as previewable.
 */
export function isHtmlPreviewAttachment(att: { mimeType?: string | null; filename: string }): boolean {
  const mimeType = (att.mimeType ?? "").split(";")[0]?.trim().toLowerCase();
  return mimeType === "text/html" || /\.html?$/i.test(att.filename);
}
