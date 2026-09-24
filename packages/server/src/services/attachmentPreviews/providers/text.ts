import { TextDecoder } from "node:util";
import { isTextPreviewCandidate, type TextAttachmentPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";

export const TEXT_PREVIEW_BYTE_LIMIT = 96 * 1024;
export const TEXT_PREVIEW_PAYLOAD_BYTE_LIMIT = 128 * 1024;

export function isTextAttachment(filename: string, mimeType: string | null | undefined): boolean {
  return isTextPreviewCandidate(filename, mimeType);
}

export function decodeUtf8Text(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export function buildTextPreview(text: string): TextAttachmentPreviewData | null {
  if (text.trim().length === 0) return null;
  return { kind: "text", text };
}

export const textPreviewProvider: AttachmentPreviewProvider<TextAttachmentPreviewData> = {
  kind: "text",
  trustLevel: "data",
  streamByteCap: TEXT_PREVIEW_BYTE_LIMIT,
  payloadByteCap: TEXT_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => isTextAttachment(attachment.filename, attachment.mimeType),
  async buildPreview({ buffer }) {
    const text = decodeUtf8Text(buffer);
    if (text == null) return null;
    return buildTextPreview(text);
  },
};
