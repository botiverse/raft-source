import type { NotAttachedReason } from "../../utils/attachmentLimitPresentation";
import type { DirectAttachmentUploadSession } from "../../utils/directAttachmentUpload";

export interface PendingFile {
  id: string;
  file: File;
  preview: string | null; // object URL for image preview
  previewWidth?: number;
  previewHeight?: number;
  /** The browser decoded `preview` (see readLocalImageDimensions). */
  previewDecoded?: boolean;
  /** Preview sources an <img> failed to load; never shown again. */
  failedPreviewSrcs?: readonly string[];
  /** Server-generated raster thumbnail from the upload response (HEIC → WebP). */
  serverThumbnailUrl?: string | null;
  uploadStatus: "validating" | "queued" | "uploading" | "ready" | "error";
  uploadProgress: number;
  uploadClientRequestId: string;
  directUploadSession?: DirectAttachmentUploadSession;
  attachmentId?: string;
  uploadError?: string;
  uploadCanRetry?: boolean;
  /**
   * Picked but not attached, for a reason no plan changes (over every plan's
   * ceiling, too many, empty, the ceiling unknown): it stays in the row as a
   * failed file that says why until it is removed. Never uploaded.
   */
  notAttached?: { reason: NotAttachedReason; maxBytes: number | null };
}
export interface AttachmentUploadResponse {
  attachments: Array<{ id: string; thumbnailUrl?: string | null }>;
}
/**
 * A reference that rides on the next message (the conversation the personal
 * assistant was opened from, assistant/AssistantContextChip.tsx). Its chip
 * shows above the input; it is never sent alone: when a message with text is
 * sent, `token` is appended to that text on a line of its own, and `onSent`
 * runs once the message went.
 */
export interface ComposerReference {
  chip: React.ReactNode;
  /** A Raft reference token (raftRefs), rendered as a chip in the sent message. */
  token: string;
  onSent: () => void;
}
