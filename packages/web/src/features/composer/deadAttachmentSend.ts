import type { IntlShape } from "react-intl";
import type { ApiErrorResponse } from "../../utils/apiErrorResponse";
import type { PendingFile } from "./composerTypes";

// Send refusals that mean an uploaded attachment id can never be linked again
// (server attachmentLinkingService). Re-sending the same ids fails forever; the
// file has to be uploaded again for a new id.
const DEAD_ATTACHMENT_CODES: ReadonlySet<string> = new Set([
  "attachment_not_found",
  "attachment_already_linked",
  "attachment_not_linked",
  "attachment_expired",
  "attachment_canceled",
]);

export function isDeadAttachmentSendError(response: ApiErrorResponse | undefined): boolean {
  return response?.code !== undefined && DEAD_ATTACHMENT_CODES.has(response.code);
}

/**
 * Restored files whose attachment id the server refused come back as failed
 * uploads, so the composer's Upload-failed banner shows and send stays blocked
 * until each is re-uploaded or removed. When the error names the attachment,
 * only that file is marked; otherwise every file with an id is. A retry starts
 * a brand-new upload (fresh client request id, no session to recover), so it
 * gets a new attachment id. Without a File blob there is nothing to re-upload:
 * no Retry, only Remove.
 */
export function markDeadAttachmentsForReupload(
  files: PendingFile[],
  response: ApiErrorResponse | undefined,
  formatMessage: IntlShape["formatMessage"],
): PendingFile[] {
  if (!isDeadAttachmentSendError(response)) return files;
  const named = files.filter((file) => file.attachmentId && response?.error?.includes(file.attachmentId));
  const dead = new Set((named.length > 0 ? named : files.filter((file) => file.attachmentId)).map((file) => file.id));
  if (dead.size === 0) return files;
  const uploadError = formatMessage({ id: "message.composer.attachmentNeedsReupload" });
  return files.map((file) => dead.has(file.id)
    ? {
        ...file,
        uploadStatus: "error",
        uploadProgress: 0,
        attachmentId: undefined,
        directUploadSession: undefined,
        uploadClientRequestId: crypto.randomUUID(),
        uploadError,
        uploadCanRetry: file.file instanceof Blob,
      }
    : file);
}
