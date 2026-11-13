/**
 * slock.attachment.direct_put_failed — the direct (presigned R2) object PUT of
 * a large attachment failed, and what recovery then found.
 *
 * #triage:#327: Raft Desktop loads the web from `app://raft`, an origin the R2
 * bucket's CORS rule did not allow. The browser blocked the preflight, the XHR
 * failed with no status, recovery found no object, and the user saw "upload
 * response lost, retry" on every attempt. Nothing recorded it, so the only
 * signal was a user report. This event is one per failed PUT, emitted after
 * recovery has run (or was skipped), so an on-call reader can tell a CORS /
 * network block (`network_error`, no bytes sent, object not found) from a
 * flaky R2 (`http_status` 5xx, object later found).
 *
 * Tracing only: the upload behaviour is unchanged (PR #5884's contract, see
 * attachmentUploadFallbackTrace.ts — no fallback after a session exists).
 *
 * Fields:
 *   reason            network_error (no HTTP status) / http_status
 *   http_status       the PUT's status, null for network_error
 *   error_name        the error's own `name`, when the PUT threw
 *   error_code        the error's own `code`, when the PUT threw
 *   size_bucket       file size, bucketed (see DirectPutSizeBucket)
 *   elapsed_bucket    time from sending the PUT to its failure, bucketed
 *   sent_bucket       share of bytes the upload progress reported as sent,
 *                     null when no progress event was seen
 *   client_scheme     `app` (Raft Desktop) / `https` / `http` / `other` —
 *                     from `location.protocol` only, never the host
 *   recovery          found / not_found / failed / not_attempted
 *
 * Deliberately NOT recorded: the error message, URL, filename, mime type, ids,
 * exact byte size. A cancel is not a failure and emits nothing, also when it lands during
 * recovery or races a 4xx answer.
 */

import { emitWebEvent } from "./webAuthTrace";
import type { DirectPutFailureTraceEventName } from "./webAuthTrace";

const DIRECT_PUT_FAILED: DirectPutFailureTraceEventName = "slock.attachment.direct_put_failed";

type DirectPutFailureEmitter = (
  name: DirectPutFailureTraceEventName,
  attrs: Record<string, unknown>,
) => void;

let emitter: DirectPutFailureEmitter = emitWebEvent;

/** Test seam: observe emissions without coupling to the trace pipeline. */
export function __setDirectPutFailureEmitterForTest(next: DirectPutFailureEmitter | null): void {
  emitter = next ?? emitWebEvent;
}

export type DirectPutFailureReason = "network_error" | "http_status";
export type DirectPutSizeBucket = "<10MB" | "10-50MB" | "50-200MB" | ">200MB";
export type DirectPutElapsedBucket = "<1s" | "1-10s" | "10-60s" | "1-5m" | ">5m";
export type DirectPutSentBucket = "<10%" | "10-50%" | "50-90%" | "90-99%" | "100%";
export type DirectPutClientScheme = "app" | "https" | "http" | "other";
export type DirectPutRecovery = "found" | "not_found" | "failed" | "not_attempted";

export type DirectPutFailure = Readonly<{
  reason: DirectPutFailureReason;
  httpStatus: number | null;
  errorName: string | null;
  errorCode: string | null;
  sizeBytes: number;
  elapsedMs: number;
  /** Highest byte count upload progress reported, or null if none was seen. */
  bytesSent: number | null;
}>;

const MB = 1024 * 1024;

export function directPutSizeBucket(bytes: number): DirectPutSizeBucket {
  if (bytes < 10 * MB) return "<10MB";
  if (bytes < 50 * MB) return "10-50MB";
  if (bytes < 200 * MB) return "50-200MB";
  return ">200MB";
}

export function directPutElapsedBucket(ms: number): DirectPutElapsedBucket {
  if (ms < 1_000) return "<1s";
  if (ms < 10_000) return "1-10s";
  if (ms < 60_000) return "10-60s";
  if (ms < 300_000) return "1-5m";
  return ">5m";
}

export function directPutSentBucket(bytesSent: number | null, sizeBytes: number): DirectPutSentBucket | null {
  if (bytesSent === null || sizeBytes <= 0) return null;
  const ratio = bytesSent / sizeBytes;
  if (ratio >= 1) return "100%";
  if (ratio >= 0.9) return "90-99%";
  if (ratio >= 0.5) return "50-90%";
  if (ratio >= 0.1) return "10-50%";
  return "<10%";
}

export function directPutClientScheme(protocol: string | undefined): DirectPutClientScheme {
  if (protocol === "app:") return "app";
  if (protocol === "https:") return "https";
  if (protocol === "http:") return "http";
  return "other";
}

function currentProtocol(): string | undefined {
  try {
    return globalThis.location?.protocol;
  } catch {
    return undefined;
  }
}

export function reportDirectPutFailure(failure: DirectPutFailure, recovery: DirectPutRecovery): void {
  try {
    emitter(DIRECT_PUT_FAILED, {
      reason: failure.reason,
      http_status: failure.httpStatus,
      error_name: failure.errorName,
      error_code: failure.errorCode,
      size_bucket: directPutSizeBucket(failure.sizeBytes),
      elapsed_bucket: directPutElapsedBucket(failure.elapsedMs),
      sent_bucket: directPutSentBucket(failure.bytesSent, failure.sizeBytes),
      client_scheme: directPutClientScheme(currentProtocol()),
      recovery,
    });
  } catch {
    // Telemetry must never be able to break an upload.
  }
}
