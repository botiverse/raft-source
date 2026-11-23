/**
 * slock.attachment.upload_finished — how a composer attachment upload ended
 * (#triage:#545). People reported image uploads that "sometimes hang
 * forever"; no request in the path had a timeout and nothing recorded how
 * uploads end, so neither the hang nor its fix could be measured. One event
 * per upload attempt, when it settles.
 *
 * Fields (closed sets; no filename, id, URL, message or exact size):
 *   route           legacy | direct | unknown (failed before the transport
 *                   was chosen, e.g. resolving the thread channel)
 *   outcome         ok | error | timeout | cancelled
 *   timeout_phase   which step ran out of time (AttachmentUploadPhase), null
 *                   unless outcome = timeout
 *   error_code      the upload error's contract code (e.g. UPLOAD_STALLED,
 *                   UPLOAD_OBJECT_PUT_UNCERTAIN), null when ok/cancelled or
 *                   the error had none
 *   size_bucket     size of the file actually sent (after any resize),
 *                   bucketed as in slock.attachment.direct_put_failed
 *   elapsed_bucket  from the upload's start to its end, bucketed likewise
 *   duration_ms     the same, in whole milliseconds
 *   client_scheme   app (Raft Desktop) / https / http / other
 *   resized         whether a large photo was resized before sending
 *                   (attachmentImageResize.ts)
 *   resize_outcome  why it was or was not (ImageResizeOutcome), null when the
 *                   upload failed before the file was prepared
 *   resize_ratio_pct  sent size as a whole percentage of the original, null
 *                   unless resized
 */

import { AttachmentUploadClientError, AttachmentUploadTimeoutError } from "./directAttachmentUpload";
import type { AttachmentUploadPhase, AttachmentUploadRoute } from "./directAttachmentUpload";
import { directPutClientScheme, directPutElapsedBucket, directPutSizeBucket } from "./directPutFailureTrace";
import type { PreparedAttachmentFile } from "./attachmentImageResize";
import { emitWebEvent } from "./webAuthTrace";
import type { WebEventName } from "./webAuthTrace";

/** Narrowed from the registry: dropping the name there stops this compiling. */
type AttachmentUploadFinishedTraceEventName = Extract<WebEventName, "slock.attachment.upload_finished">;

const UPLOAD_FINISHED: AttachmentUploadFinishedTraceEventName = "slock.attachment.upload_finished";

type UploadFinishedEmitter = (
  name: AttachmentUploadFinishedTraceEventName,
  attrs: Record<string, unknown>,
) => void;

let emitter: UploadFinishedEmitter = emitWebEvent;

/** Test seam: observe emissions without coupling to the trace pipeline. */
export function __setUploadFinishedEmitterForTest(next: UploadFinishedEmitter | null): void {
  emitter = next ?? emitWebEvent;
}

export type AttachmentUploadOutcome = "ok" | "error" | "timeout" | "cancelled";

export type AttachmentUploadFinished = Readonly<{
  route: AttachmentUploadRoute | null;
  sizeBytes: number;
  durationMs: number;
  /** Absent for a success. */
  error?: unknown;
  cancelled?: boolean;
  /** How the file was prepared; null/absent when it never got that far. */
  resize?: Pick<PreparedAttachmentFile, "file" | "outcome" | "originalBytes"> | null;
}>;

function currentProtocol(): string | undefined {
  try {
    return globalThis.location?.protocol;
  } catch {
    return undefined;
  }
}

export function attachmentUploadFinishedAttrs(finished: AttachmentUploadFinished): Record<string, unknown> {
  const { error, cancelled = false } = finished;
  const failed = !cancelled && error !== undefined;
  const timeout = failed && error instanceof AttachmentUploadTimeoutError ? error : null;
  const outcome: AttachmentUploadOutcome = cancelled
    ? "cancelled"
    : timeout ? "timeout" : failed ? "error" : "ok";
  const phase: AttachmentUploadPhase | null = timeout?.phase ?? null;
  const durationMs = Math.max(0, Math.round(finished.durationMs));
  const resize = finished.resize ?? null;
  const resized = resize?.outcome === "resized";
  return {
    route: finished.route ?? "unknown",
    outcome,
    timeout_phase: phase,
    error_code: failed && error instanceof AttachmentUploadClientError ? error.code : null,
    size_bucket: directPutSizeBucket(finished.sizeBytes),
    elapsed_bucket: directPutElapsedBucket(durationMs),
    duration_ms: durationMs,
    client_scheme: directPutClientScheme(currentProtocol()),
    resized,
    resize_outcome: resize?.outcome ?? null,
    resize_ratio_pct: resized && resize.originalBytes > 0
      ? Math.round((resize.file.size / resize.originalBytes) * 100)
      : null,
  };
}

export function reportAttachmentUploadFinished(finished: AttachmentUploadFinished): void {
  try {
    emitter(UPLOAD_FINISHED, attachmentUploadFinishedAttrs(finished));
  } catch {
    // Telemetry must never be able to break an upload.
  }
}
