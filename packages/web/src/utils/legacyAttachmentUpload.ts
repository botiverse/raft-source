import {
  ATTACHMENT_TRANSFER_IDLE_TIMEOUT_MS,
  ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
  AttachmentUploadTimeoutError,
  scheduleUploadDeadline,
} from "./directAttachmentUpload";
import type { ScheduleUploadDeadline } from "./directAttachmentUpload";
import type { AxiosInstance } from "axios";
import type { AttachmentUploadResponse } from "../features/composer/composerTypes";

export const LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS = ATTACHMENT_TRANSFER_IDLE_TIMEOUT_MS;

/** The answer deadline once every byte is sent (#triage:#545), shared with the direct PUT. */
export const LEGACY_ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS = ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS;

export async function uploadLegacyAttachmentWithIdleTimeout<T>(options: Readonly<{
  signal?: AbortSignal;
  upload: (context: Readonly<{
    signal: AbortSignal;
    markProgress: () => void;
    markTransferComplete: () => void;
  }>) => Promise<T>;
  idleTimeoutMs?: number;
  responseTimeoutMs?: number;
  scheduleDeadline?: ScheduleUploadDeadline;
}>): Promise<T> {
  const {
    signal,
    upload,
    idleTimeoutMs = LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
    responseTimeoutMs = LEGACY_ATTACHMENT_UPLOAD_RESPONSE_TIMEOUT_MS,
    scheduleDeadline = scheduleUploadDeadline,
  } = options;
  signal?.throwIfAborted();

  const requestController = new AbortController();
  let expired: AttachmentUploadTimeoutError | null = null;
  let transferComplete = false;
  let cancelDeadline: () => void = () => undefined;
  let rejectOnDeadline: (error: AttachmentUploadTimeoutError) => void = () => undefined;
  const deadlineReached = new Promise<never>((_resolve, reject) => {
    rejectOnDeadline = reject;
  });
  deadlineReached.catch(() => undefined);

  const abortFromCaller = () => requestController.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const armDeadline = (phase: "transfer" | "response", timeoutMs: number) => {
    cancelDeadline();
    cancelDeadline = scheduleDeadline(() => {
      expired = new AttachmentUploadTimeoutError(phase);
      rejectOnDeadline(expired);
      // Abort so a late answer cannot land: the attachment it would carry
      // stays unattached, and a retry uploads afresh.
      requestController.abort(expired);
    }, timeoutMs);
  };

  const markProgress = () => {
    if (expired || transferComplete || requestController.signal.aborted) return;
    armDeadline("transfer", idleTimeoutMs);
  };

  // Server-side saving is not a stalled browser transfer: the idle window
  // gives way to the longer response deadline.
  const markTransferComplete = () => {
    if (expired || transferComplete || requestController.signal.aborted) return;
    transferComplete = true;
    armDeadline("response", responseTimeoutMs);
  };

  armDeadline("transfer", idleTimeoutMs);
  try {
    const result = await Promise.race([
      upload({
        signal: requestController.signal,
        markProgress,
        markTransferComplete,
      }),
      deadlineReached,
    ]);
    if (expired) throw expired;
    return result;
  } catch (error) {
    if (expired) throw expired;
    throw error;
  } finally {
    cancelDeadline();
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * The legacy multipart POST of one composer attachment, under the stall and
 * answer deadlines above. `file` is what is sent (a resized photo, possibly).
 */
export async function postLegacyAttachment(options: Readonly<{
  api: Pick<AxiosInstance, "post">;
  channelId: string;
  file: File;
  signal?: AbortSignal;
  /** 1–99 while bytes move; the caller sets 100 once the upload settles. */
  onProgress: (progress: number) => void;
}>): Promise<Readonly<{ id: string; thumbnailUrl: string | null }>> {
  const { api, channelId, file, signal, onProgress } = options;
  return uploadLegacyAttachmentWithIdleTimeout({
    signal,
    upload: async ({ signal: requestSignal, markProgress, markTransferComplete }) => {
      const formData = new FormData();
      formData.append("channelId", channelId);
      formData.append("files", file);
      let uploadedBytes = 0;
      const { data } = await api.post<AttachmentUploadResponse>(
        "/attachments/upload",
        formData,
        {
          headers: { "Content-Type": "multipart/form-data" },
          signal: requestSignal,
          onUploadProgress: (event) => {
            if (event.loaded <= uploadedBytes) return;
            uploadedBytes = event.loaded;
            markProgress();
            if ((event.total !== undefined && event.loaded >= event.total) || event.progress === 1) {
              markTransferComplete();
            }
            if (!event.total) return;
            onProgress(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
          },
        },
      );
      const attachment = data.attachments[0];
      if (!attachment?.id) throw new Error("Upload response did not include an attachment id");
      return { id: attachment.id, thumbnailUrl: attachment.thumbnailUrl ?? null };
    },
  });
}
