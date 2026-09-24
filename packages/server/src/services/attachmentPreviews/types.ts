import type { AttachmentPreviewData } from "@botiverse/raft-shared";
import type { attachments } from "../../db/schema.js";

export type AttachmentPreviewTrustLevel = "data" | "sandbox";

export interface AttachmentPreviewProvider<TData extends AttachmentPreviewData = AttachmentPreviewData> {
  kind: TData["kind"];
  trustLevel: AttachmentPreviewTrustLevel;
  streamByteCap: number;
  payloadByteCap: number;
  canPreview(attachment: typeof attachments.$inferSelect): boolean;
  buildPreview(args: {
    attachment: typeof attachments.$inferSelect;
    buffer: Buffer;
    truncated: boolean;
  }): Promise<TData | null>;
}
