import {
  MARKDOWN_PREVIEW_BYTE_LIMIT,
  MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT,
  previewPrefixAtLineBoundary,
  type MarkdownAttachmentPreviewData,
} from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types";

export { MARKDOWN_PREVIEW_BYTE_LIMIT, MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT };

const MARKDOWN_MIME_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
]);

export function isMarkdownAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || MARKDOWN_MIME_TYPES.has(normalizedMime);
}

export function buildMarkdownPreview(
  text: string,
  truncation?: { previewByteLength: number; sourceByteLength: number },
): MarkdownAttachmentPreviewData | null {
  const markdown = text.trim();
  if (!markdown) return null;
  return truncation ? { kind: "markdown", markdown, ...truncation } : { kind: "markdown", markdown };
}

// A file over the limit previews its first MARKDOWN_PREVIEW_BYTE_LIMIT bytes,
// cut at the last whole line, rather than being refused (task #164): the
// stream truncation flag becomes the response's `truncated`, and the sizes let
// the viewer say how much of the file it shows.
export const markdownPreviewProvider: AttachmentPreviewProvider<MarkdownAttachmentPreviewData> = {
  kind: "markdown",
  trustLevel: "data",
  streamByteCap: MARKDOWN_PREVIEW_BYTE_LIMIT,
  payloadByteCap: MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => isMarkdownAttachment(attachment.filename, attachment.mimeType),
  async buildPreview({ attachment, buffer, truncated }) {
    if (!truncated) return buildMarkdownPreview(buffer.toString("utf8"));
    const shown = previewPrefixAtLineBoundary(buffer);
    return buildMarkdownPreview(Buffer.from(shown.buffer, shown.byteOffset, shown.byteLength).toString("utf8"), {
      previewByteLength: shown.byteLength,
      sourceByteLength: Math.max(attachment.sizeBytes, buffer.byteLength),
    });
  },
};
