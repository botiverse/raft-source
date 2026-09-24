// Route-failure error classification for server-side observability traces.
import { addTraceEvent } from "./semanticTrace.js";
//
// Background: `traceRouteFailure()` historically emitted only `error_class`
// (= `err.name`, which is almost always the generic "Error"), discarding both
// the message and any way to tell *why* a route failed. That made 5xx hotspots
// (e.g. the `runtime-models` 503s that dominate prod 5xx) impossible to push
// from "this route errors a lot" to a root-cause candidate without reading
// source. This module adds a closed-set `error_subkind` classifier plus a
// bounded, sanitized `error_message`.
//
// Design anchor: #proj-daemon:40c26bd4 (task #72 ratification thread); task #73
// is PR-S1, the server-side runtime-models slice. The `error_subkind` closed
// set below is the RATIFIED initial set (server-observable only). Contract
// discipline (owner: O11y contract / @Leiysky):
//   * `error_subkind` is a CLOSED SET. New values follow the §A.2 ratify-msg-id
//     flow — the ratify msg is canonical, not a mid-review proposal. Do NOT
//     derive a subkind by string-matching a free-form error message. Classify
//     only what the call-site structurally knows.
//   * `daemon_threw` is RESERVED: it is a real, named failure mode (the daemon
//     actively threw a classified error) that can only be emitted once the
//     daemon→server `machine:runtime_models:result` protocol carries a
//     structured `errorCode` (task #77). Until then this server never emits it.
//   * `unknown` is the outer catch-all ONLY — a climbing `unknown` rate is an
//     alerting signal that a real failure mode is unclassified, not a resting
//     state. Never guess a finer subkind to avoid `unknown`.
//
// Out of scope (deferred to daemon-side structured `detect_reason`, per anchor):
// the finer cache-missing vs no-detect split. This server maps the daemon's
// stable `"unsupported"` wire constant to `daemon_error_unsupported` and leaves
// everything finer to the daemon follow-up.

/**
 * Closed-set classification of why a server route handler failed.
 * Ratified initial set (design anchor #proj-daemon:40c26bd4):
 *
 * Emitted today (PR-S1 / path-(b), server-observable only):
 *  - `daemon_offline` — the server could not send to the daemon (WS not ready).
 *  - `daemon_timeout` — the server waited for a daemon response and timed out.
 *  - `daemon_error_unsupported` — daemon reported the runtime has no model
 *    detection support (stable wire constant `error: "unsupported"`).
 *  - `unknown` — outer catch-all. Any failure the call-site cannot structurally
 *    classify lands here. NEVER guessed from a free-form message. A rising rate
 *    is an alerting signal.
 *
 * Reserved (NOT emitted until path-(a) / task #77 lands):
 *  - `daemon_threw` — the daemon's detect path threw a classified error;
 *    requires a structured daemon `errorCode` to populate without string-match.
 */
export type RouteFailureSubkind =
  | "daemon_offline"
  | "daemon_timeout"
  | "daemon_error_unsupported"
  | "daemon_threw"
  | "unknown";

export type RouteFailureKind =
  | "daemon_unavailable"
  | "daemon_error"
  | "server_exception";

/**
 * Subkinds the server is allowed to EMIT in PR-S1 (path-(b)). `daemon_threw` is
 * part of the ratified taxonomy type above but requires a structured daemon
 * errorCode (task #77) to populate without string-matching, so it is
 * deliberately absent here.
 */
export const EMITTABLE_ROUTE_FAILURE_SUBKINDS = [
  "daemon_offline",
  "daemon_timeout",
  "daemon_error_unsupported",
  "unknown",
] as const satisfies readonly RouteFailureSubkind[];

/**
 * The subset of `RouteFailureSubkind` the server may actually emit today.
 * Derived from `EMITTABLE_ROUTE_FAILURE_SUBKINDS` so the two cannot drift.
 * Reserved values (`daemon_threw`) are excluded at the TYPE level — a
 * call-site that tries to construct one is a compile error, not just a
 * test/runtime failure. This keeps a reserved value from appearing in traces
 * before path-(a) lands (which would make the evidence enum lie about task #77
 * having shipped).
 */
export type EmittableRouteFailureSubkind = (typeof EMITTABLE_ROUTE_FAILURE_SUBKINDS)[number];

/**
 * An error whose route-failure subkind is known at the throw site. The server
 * sets this for failures it structurally understands (e.g. a detect-request
 * timeout originates inside the orchestrator, so the orchestrator tags it).
 * Free-form daemon errors are NOT wrapped — they fall through to `unknown`.
 *
 * Accepts only `EmittableRouteFailureSubkind`: reserved values are
 * unconstructable here by design.
 */
export class RouteFailureError extends Error {
  readonly subkind: EmittableRouteFailureSubkind;

  constructor(subkind: EmittableRouteFailureSubkind, message: string) {
    super(message);
    this.name = "RouteFailureError";
    // Defense-in-depth: the type guard blocks reserved values statically, but a
    // wire/dynamic value cast through `as any` could still slip past. Reject it
    // at runtime so a reserved value can never reach a trace before its
    // enabling path (e.g. task #77) lands.
    if (!(EMITTABLE_ROUTE_FAILURE_SUBKINDS as readonly string[]).includes(subkind)) {
      throw new Error(`RouteFailureError: subkind "${subkind}" is not emittable (reserved or unknown to the closed set)`);
    }
    this.subkind = subkind;
  }
}

/**
 * Resolve the subkind for an arbitrary thrown value. Only structurally-known
 * sources (a `RouteFailureError`) produce a non-`unknown` value here; anything
 * else is `unknown` by design — we never sniff a free-form message string.
 */
export function resolveRouteFailureSubkind(err: unknown): RouteFailureSubkind {
  if (err instanceof RouteFailureError) {
    return err.subkind;
  }
  return "unknown";
}

export function resolveRouteFailureKind(subkind: RouteFailureSubkind): RouteFailureKind {
  switch (subkind) {
    case "daemon_offline":
    case "daemon_timeout":
      return "daemon_unavailable";
    case "daemon_error_unsupported":
    case "daemon_threw":
      return "daemon_error";
    case "unknown":
      return "server_exception";
  }
}

const MAX_ERROR_MESSAGE_LENGTH = 240;

/**
 * Bounded, sanitized error message for trace attributes.
 *
 * Mirrors the #74 transport sanitizer (`sanitizeOriginalMessage` in
 * packages/cli/src/transportTrace.ts and `sanitizeTransportOriginalMessage` in
 * packages/daemon/src/agentCredentialProxy.ts) byte-for-byte: same redaction
 * patterns, same 240-char cap. Kept as a third copy intentionally so #73 does
 * not build on the unmerged #2241 branch.
 *
 * TODO(task #78): once #2241 and #73 both merge, collapse the cli/daemon/server
 * copies into one shared-package util (single source of truth) and add Bearer
 * redaction there across all three. Tracked by task #78 (sanitizer
 * consolidation, #proj-daemon) — do not let this comment rot.
 */
export function sanitizeRouteErrorMessage(message: string): string {
  if (/\bfailed query:/i.test(message)) {
    return "Database query failed";
  }
  const normalized = message
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt redacted]")
    .replace(/sk_(?:agent|machine|computer|daemon)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/sap_[A-Za-z0-9_-]+/g, "sap_[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`
    : normalized;
}

/**
 * Emit a route failure event with closed failure taxonomy. Call sites must pass
 * only structural context; do not add raw ids, raw paths, or unsanitized
 * messages here.
 */
export function traceRouteFailure(name: string, err: unknown, attrs: Record<string, unknown> = {}) {
  const errorSubkind = resolveRouteFailureSubkind(err);
  addTraceEvent(name, {
    error_class: err instanceof Error ? err.name : typeof err,
    error_kind: resolveRouteFailureKind(errorSubkind),
    error_subkind: errorSubkind,
    error_message: sanitizeRouteErrorMessage(err instanceof Error ? err.message : String(err ?? "")),
    ...attrs,
  });
}
