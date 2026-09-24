import type { MarkdownAttachmentPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";

export const MARKDOWN_PREVIEW_BYTE_LIMIT = 128 * 1024;
export const MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT = 64 * 1024;

const MARKDOWN_MIME_TYPES = new Set([
  "text/markdown",
  "text/x-markdown",
]);

export function isMarkdownAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lowerName.endsWith(".md") || lowerName.endsWith(".markdown") || MARKDOWN_MIME_TYPES.has(normalizedMime);
}

export function buildMarkdownPreview(text: string): MarkdownAttachmentPreviewData | null {
  const markdown = text.trim();
  if (!markdown) return null;
  return { kind: "markdown", markdown };
}

export const markdownPreviewProvider: AttachmentPreviewProvider<MarkdownAttachmentPreviewData> = {
  kind: "markdown",
  trustLevel: "data",
  streamByteCap: MARKDOWN_PREVIEW_BYTE_LIMIT,
  payloadByteCap: MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => isMarkdownAttachment(attachment.filename, attachment.mimeType),
  async buildPreview({ buffer }) {
    return buildMarkdownPreview(buffer.toString("utf8"));
  },
};
