import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { AttachmentUploadClientError } from "./directAttachmentUpload";

export const LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS = 60_000;

type ScheduleIdleDeadline = (onTimeout: () => void, timeoutMs: number) => () => void;

const scheduleIdleDeadline: ScheduleIdleDeadline = (onTimeout, timeoutMs) => {
  const handle = setClockTimeout(onTimeout, timeoutMs);
  return () => clearClockTimeout(handle);
};

export async function uploadLegacyAttachmentWithIdleTimeout<T>(options: Readonly<{
  signal?: AbortSignal;
  upload: (context: Readonly<{
    signal: AbortSignal;
    markProgress: () => void;
    markTransferComplete: () => void;
  }>) => Promise<T>;
  idleTimeoutMs?: number;
  scheduleDeadline?: ScheduleIdleDeadline;
}>): Promise<T> {
  const {
    signal,
    upload,
    idleTimeoutMs = LEGACY_ATTACHMENT_UPLOAD_IDLE_TIMEOUT_MS,
    scheduleDeadline = scheduleIdleDeadline,
  } = options;
  signal?.throwIfAborted();

  const requestController = new AbortController();
  let deadlineExpired = false;
  let transferComplete = false;
  let cancelDeadline: () => void = () => undefined;

  const abortFromCaller = () => requestController.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  const armDeadline = () => {
    if (deadlineExpired || transferComplete || requestController.signal.aborted) return;
    cancelDeadline();
    cancelDeadline = scheduleDeadline(() => {
      deadlineExpired = true;
      requestController.abort();
    }, idleTimeoutMs);
  };

  const markTransferComplete = () => {
    if (deadlineExpired || transferComplete || requestController.signal.aborted) return;
    transferComplete = true;
    cancelDeadline();
    cancelDeadline = () => undefined;
  };

  armDeadline();
  try {
    const result = await upload({
      signal: requestController.signal,
      markProgress: armDeadline,
      markTransferComplete,
    });
    if (deadlineExpired) {
      throw new AttachmentUploadClientError(
        "UPLOAD_STALLED",
        "The upload stopped making progress. Tap to retry.",
        true,
      );
    }
    return result;
  } catch (error) {
    if (deadlineExpired) {
      throw new AttachmentUploadClientError(
        "UPLOAD_STALLED",
        "The upload stopped making progress. Tap to retry.",
        true,
      );
    }
    throw error;
  } finally {
    cancelDeadline();
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
