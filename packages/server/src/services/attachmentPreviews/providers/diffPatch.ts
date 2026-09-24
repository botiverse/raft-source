import type { DiffAttachmentPreviewData } from "@botiverse/raft-shared";
import type { AttachmentPreviewProvider } from "../types.js";

export const DIFF_PREVIEW_BYTE_LIMIT = 256 * 1024;
export const DIFF_PREVIEW_PAYLOAD_BYTE_LIMIT = 8 * 1024;

const DIFF_PATCH_MIME_TYPES = new Set([
  "text/x-diff",
  "text/x-patch",
  "application/x-patch",
]);

export function isDiffPatchAttachment(filename: string, mimeType: string | null | undefined): boolean {
  const lowerName = filename.toLowerCase();
  const normalizedMime = mimeType?.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return lowerName.endsWith(".diff") || lowerName.endsWith(".patch") || DIFF_PATCH_MIME_TYPES.has(normalizedMime);
}

export function buildDiffPatchPreview(text: string): DiffAttachmentPreviewData | null {
  const lines = text.split(/\r?\n/);
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  const files = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
      files.add(match?.[2] ?? line);
      continue;
    }
    if (line.startsWith("Index: ")) {
      files.add(line.slice("Index: ".length).trim());
      continue;
    }
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      files.add(line.slice(4).replace(/^b\//, "").trim());
      continue;
    }
    if (line.startsWith("@@")) {
      hunks += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  if (hunks === 0 && additions === 0 && deletions === 0 && files.size === 0) return null;

  return {
    kind: "diff",
    stats: {
      files: files.size || 1,
      hunks,
      additions,
      deletions,
    },
  };
}

export const diffPatchPreviewProvider: AttachmentPreviewProvider<DiffAttachmentPreviewData> = {
  kind: "diff",
  trustLevel: "data",
  streamByteCap: DIFF_PREVIEW_BYTE_LIMIT,
  payloadByteCap: DIFF_PREVIEW_PAYLOAD_BYTE_LIMIT,
  canPreview: (attachment) => isDiffPatchAttachment(attachment.filename, attachment.mimeType),
  async buildPreview({ buffer }) {
    return buildDiffPatchPreview(buffer.toString("utf8"));
  },
};
