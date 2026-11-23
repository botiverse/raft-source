import { ATTACHMENT_UPLOAD_CONTROL_TIMEOUT_MS, AttachmentUploadTimeoutError, withAttachmentUploadDeadline } from "../../utils/directAttachmentUpload";

/**
 * Bounds the composer's wait for a thread's delivery channel (#triage:#545):
 * a channel that never comes back fails the send or upload as retryable
 * instead of spinning. Callers already waiting share one request (no duplicate
 * thread creation from one send); when the deadline fires, `onTimeout` drops
 * that request so the retry asks afresh rather than waiting on a hung one
 * again. The server's thread creation is get-or-create on the parent message,
 * so an overlap still yields the same thread.
 */
export function boundChannelResolve(
  promise: Promise<string>,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<string> {
  return withAttachmentUploadDeadline({
    phase: "channel",
    timeoutMs: ATTACHMENT_UPLOAD_CONTROL_TIMEOUT_MS,
    signal,
    run: () => promise,
  }).catch((error: unknown) => {
    if (error instanceof AttachmentUploadTimeoutError) onTimeout();
    throw error;
  });
}
