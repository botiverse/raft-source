import type { AttachmentPreviewData, AttachmentPreviewResponse } from "@botiverse/raft-shared";
import type { attachments } from "../../db/schema.js";
import { getStorage } from "../storageService.js";
import { readStreamPrefix } from "./utils.js";
import type { AttachmentPreviewProvider } from "./types.js";
import { diffPatchPreviewProvider } from "./providers/diffPatch.js";
import { csvPreviewProvider } from "./providers/csv.js";
import { isXlsxAttachment, xlsxPreviewProvider } from "./providers/xlsx.js";
import { markdownPreviewProvider } from "./providers/markdown.js";
import { pdfPreviewProvider } from "./providers/pdf.js";
import { textPreviewProvider } from "./providers/text.js";

// Preview providers are ordered by specificity. The first matching provider
// owns the response shape, so generic text-like previews should stay last.
// Preview JSON is intentionally on-demand and recomputable; expensive upload-
// time artifacts such as image thumbnails remain attachment-row fields.
export const attachmentPreviewProviders: AttachmentPreviewProvider[] = [
  diffPatchPreviewProvider,
  csvPreviewProvider,
  xlsxPreviewProvider,
  markdownPreviewProvider,
  pdfPreviewProvider,
  textPreviewProvider,
];

export function getAttachmentPreviewProvider(attachment: typeof attachments.$inferSelect): AttachmentPreviewProvider | null {
  return attachmentPreviewProviders.find((provider) => provider.canPreview(attachment)) ?? null;
}

export function isAttachmentPreviewTruncated(data: AttachmentPreviewData, streamTruncated: boolean): boolean {
  return streamTruncated || (data.kind === "csv" && data.rows.length < data.rowCount)
    || (data.kind === "xlsx" && (
      data.truncated
      || data.sheets.length < data.sheetCount
      || data.sheets.some((sheet) => sheet.truncated || sheet.rows.length < sheet.rowCount)
    ));
}

export async function buildAttachmentPreviewResponse(attachment: typeof attachments.$inferSelect): Promise<AttachmentPreviewResponse> {
  const provider = getAttachmentPreviewProvider(attachment);
  if (!provider) {
    return {
      status: "unsupported",
      reason: isXlsxAttachment(attachment.filename, attachment.mimeType) ? "too_large" : "unsupported",
    };
  }

  const storage = getStorage();
  if (!storage) throw new Error("File storage is not configured on this server");

  const stream = await storage.get(attachment.storageKey);
  const { buffer, truncated } = await readStreamPrefix(stream, provider.streamByteCap);
  const data = await provider.buildPreview({ attachment, buffer, truncated });
  if (!data) return {
    status: "unsupported",
    reason: provider.kind === "xlsx" ? "unreadable" : "unsupported",
  };

  const payloadSize = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (payloadSize > provider.payloadByteCap) return { status: "unsupported", reason: "too_large" };

  return { status: "ok", data, truncated: isAttachmentPreviewTruncated(data, truncated) };
}
