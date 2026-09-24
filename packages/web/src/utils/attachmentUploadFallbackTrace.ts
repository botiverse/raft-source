/**
 * slock.attachment.upload_capability_fallback — why a browser upload degraded
 * to the legacy path instead of taking the direct-upload route.
 *
 * Task #187. Before this, the capability probe fell back ONLY on 404 and threw
 * on everything else, so a 500 / timeout / network blip killed the upload
 * outright — that is the 2026-08-02 production outage shape, where a mounted-
 * router failure surfaced as `500 Failed to serve attachment` and users simply
 * could not upload. The fallback is now "degrade unless direct upload is
 * explicitly enabled", which means the interesting question stops being "did it
 * fail?" and becomes **"how often are we silently on the legacy path, and why?"**
 * Without this event that question has no answer: a fail-safe that hides its own
 * triggering is indistinguishable from a healthy system.
 *
 * Fields:
 *   reason       why we fell back — see UploadFallbackReason
 *   http_status  numeric status when the probe produced one, else null
 *   error_name   the error's own `name` (e.g. `AxiosError`, `TypeError`)
 *   error_code   the error's own `code` (e.g. `ECONNABORTED`, `ERR_NETWORK`)
 *
 * ⭐ `error_name` / `error_code` exist because of @tygg's tracing requirement,
 * gated by @Eric: **a fail-safe must not swallow the error it degrades on.**
 * My first version carried only `reason` + `http_status`, which collapsed a
 * TIMEOUT and a NETWORK failure into a single `capability_unreachable` with
 * `http_status: null` — the two most different causes on that branch, made
 * indistinguishable in the name of low cardinality. A 500 vs 503 was already
 * separable via `http_status`; "why did it never answer" was not. These two
 * fields make every fallback reconstructable.
 *
 * Cardinality is deliberately NOT the priority here (per the same requirement).
 * It stays naturally bounded anyway: both come from the error object's own
 * enum-ish fields, not from free text.
 *
 * Still deliberately NOT recorded: the error MESSAGE, filename, mime type,
 * channel id, byte size. Messages are free-form and can carry URLs; the code
 * and name give the diagnostic without that risk. Volume is bounded at one per
 * upload attempt, so no throttling is needed.
 *
 * Scope boundary (@Huarong, @Eric — #proj-release): this family covers the
 * PRE-SESSION capability probe only. Failures during the object PUT happen
 * AFTER a session exists and must never silently fall back to legacy upload
 * here. A request-streaming transport rejection may retry the same conditional
 * object PUT once with a plain File body; if that attempt is also uncertain,
 * PR #5884's contract still applies — recovery, then a retryable
 * `UPLOAD_OBJECT_PUT_UNCERTAIN` with the session preserved.
 */

import { emitWebTrace } from "./webAuthTrace";
import type { UploadCapabilityFallbackTraceEventName } from "./webAuthTrace";

/**
 * The event this module may emit. Typed against the central registry rather
 * than `string`, which is the tooth: if the name is ever dropped from
 * `WebTraceEventName`, assigning `emitWebTrace` to this seam stops compiling.
 * The previous `as unknown as` cast made the emitter accept any `string`, so
 * this family worked at runtime while sitting outside the registry's
 * compile-time contract entirely — a rename or a registry refactor would have
 * gone unnoticed by the type system (@Cody, review of `a2223d1bf`).
 */
const UPLOAD_CAPABILITY_FALLBACK: UploadCapabilityFallbackTraceEventName =
  "slock.attachment.upload_capability_fallback";

type FallbackEmitter = (
  name: UploadCapabilityFallbackTraceEventName,
  attrs: Record<string, unknown>,
) => void;

let emitter: FallbackEmitter = emitWebTrace;

/** Test seam: observe emissions without coupling to the trace pipeline. */
export function __setUploadFallbackEmitterForTest(next: FallbackEmitter | null): void {
  emitter = next ?? emitWebTrace;
}

/**
 * Why the upload took the legacy path. Closed set so the field stays
 * query-safe and low cardinality.
 *
 * `capability_*` are anomalies — the probe did not give us a usable answer.
 * `not_enabled` / `below_threshold` are the normal, healthy reasons and are
 * emitted too: without them the anomaly count has no denominator, and "direct
 * upload is off everywhere" looks identical to "direct upload is broken".
 */
export type UploadFallbackReason =
  | "capability_not_found"      // 404 — router not mounted (the pre-#187 case)
  | "capability_server_error"   // 5xx
  | "capability_client_error"   // other 4xx
  | "capability_timeout"        // the probe ran out of time
  | "capability_network"        // could not reach the server at all
  | "capability_unreachable"    // no status and no recognisable cause
  | "not_enabled"               // server says direct upload is off
  | "below_threshold";          // enabled, but this file is under the cutoff

/** The error's own identifying fields — never its free-form message. */
export type UploadFallbackErrorIdentity = Readonly<{
  name: string | null;
  code: string | null;
}>;

export function reportUploadCapabilityFallback(
  reason: UploadFallbackReason,
  httpStatus: number | null,
  error?: UploadFallbackErrorIdentity,
): void {
  try {
    emitter(UPLOAD_CAPABILITY_FALLBACK, {
      reason,
      http_status: httpStatus,
      error_name: error?.name ?? null,
      error_code: error?.code ?? null,
    });
  } catch {
    // Telemetry must never be able to break an upload. This is the fail-safe
    // path itself: throwing here would defeat the entire point of #187.
  }
}
