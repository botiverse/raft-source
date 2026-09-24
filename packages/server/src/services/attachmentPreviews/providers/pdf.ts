import type { PdfAttachmentPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";

export const PDF_PREVIEW_BYTE_LIMIT = 4;
export const PDF_PREVIEW_PAYLOAD_BYTE_LIMIT = 512;

export function isPdfAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lowerName.endsWith(".pdf") || normalizedMime === "application/pdf";
}

export const pdfPreviewProvider: AttachmentPreviewProvider<PdfAttachmentPreviewData> = {
  kind: "pdf",
  trustLevel: "sandbox",
  streamByteCap: PDF_PREVIEW_BYTE_LIMIT,
  payloadByteCap: PDF_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => isPdfAttachment(attachment.filename, attachment.mimeType),
  async buildPreview({ buffer }) {
    // `%PDF` is the stable file signature for real PDF payloads. Keep the
    // preview unsupported for renamed arbitrary files rather than framing them.
    return buffer.toString("latin1").startsWith("%PDF") ? { kind: "pdf" } : null;
  },
};
