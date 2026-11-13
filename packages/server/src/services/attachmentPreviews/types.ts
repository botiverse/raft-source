import type { AttachmentPreviewData } from "@botiverse/raft-shared";
import type { ResolvedAttachment } from "../attachmentRecord";

export type AttachmentPreviewTrustLevel = "data" | "sandbox";

export interface AttachmentPreviewProvider<TData extends AttachmentPreviewData = AttachmentPreviewData> {
  kind: TData["kind"];
  trustLevel: AttachmentPreviewTrustLevel;
  streamByteCap: number;
  payloadByteCap: number;
  canPreview(attachment: ResolvedAttachment): boolean;
  buildPreview(args: {
    attachment: ResolvedAttachment;
    buffer: Buffer;
    truncated: boolean;
  }): Promise<TData | null>;
}
