// Send-route (agent-api/send) failure classification for observability traces.
//
// Task #79 / PR-S2. Same discipline as the runtime-models route-failure work
// (#73, ./routeFailure.ts) but a SEPARATE closed set: the agent-api/send route
// has a different failure domain (validation + membership + internal persist),
// so reusing `RouteFailureSubkind` would manufacture false consistency. This is
// its own `SendRouteSubkind`.
//
// Background: `POST /internal/agent-api/send` has well-structured 4xx early
// returns (target/content/agent/forbidden/not-found/archived) but its outer
// catch collapses everything else into an opaque `500 "Failed to send message"`
// — including `MentionValidationError`, which is really an input-validation
// failure, not a server-internal one. This module makes the failure reason
// observable as a closed-set `error_subkind` so 5xx hotspots on this route can
// be split (input-validation vs genuine server-internal) without reading source.
//
// Contract discipline (owner: O11y contract / @Leiysky; ratify msg
// #proj-daemon:6676803a / 310b4ac5):
//   * `SendRouteSubkind` is a CLOSED SET ratified in that msg — it is the
//     source of truth. New values follow the §A.2 ratify-msg-id flow.
//   * Classify only from STRUCTURALLY-KNOWN sources (typed errors / explicit
//     branches). NEVER derive a subkind by string-matching a free-form message.
//   * `unknown` is the outer catch-all ONLY — a climbing `unknown` rate is a
//     taxonomy-drift signal, not a resting bucket.
//   * All 9 values are emittable (unlike #73's reserved `daemon_threw`): the
//     send route does not depend on a future protocol change to populate any
//     bucket.
//
// NOTE: this PR classifies `mention_validation` (making the latent "input error
// returned as 500" bug VISIBLE) but does NOT change the HTTP status — the
// 500→4xx behavior fix is a separate PR (risk-isolated per ratify decision).

import { addTraceEvent } from "./semanticTrace.js";
import { sanitizeRouteErrorMessage } from "./routeFailure.js";

/**
 * Closed-set classification of why an agent-api/send request failed AFTER
 * reaching the server route handler. Ratified set (#proj-daemon:6676803a):
 *
 *  - `bad_request` — pure request validation (missing/invalid target or
 *    content, deprecated `--continue`, `--anyway` without draft, self-DM).
 *  - `agent_not_found` — acting agent missing or serverId mismatch (401).
 *  - `freshness_not_enabled` — freshness interface requested but disabled (403).
 *  - `target_forbidden` — caller may not write to the resolved target (403).
 *  - `target_not_found` — target peer / channel not found (404).
 *  - `channel_archived` — target channel archived (409, typed catch).
 *  - `mention_validation` — MentionValidationError from message build (invalid
 *    mention id/handle, mention not in content / not visible). Input-validation;
 *    currently surfaces as 500 (status-fix is a separate PR).
 *  - `server_internal` — genuine server-side failure: broadcast/DB write,
 *    attestedSend record, orchestrator error, etc.
 *  - `unknown` — outer catch-all. Never guessed from a message. Drift signal.
 */
export type SendRouteSubkind =
  | "bad_request"
  | "agent_not_found"
  | "freshness_not_enabled"
  | "target_forbidden"
  | "target_not_found"
  | "channel_archived"
  | "mention_validation"
  | "server_internal"
  | "unknown";

/**
 * Full observable closed set — every value that may appear in a trace
 * `error_subkind` (all 9 ratified). This is the OUTPUT vocabulary of
 * `resolveSendRouteSubkind`. Cross-checked against `SendRouteSubkind` via the
 * exhaustiveness test.
 */
export const OBSERVABLE_SEND_ROUTE_SUBKINDS = [
  "bad_request",
  "agent_not_found",
  "freshness_not_enabled",
  "target_forbidden",
  "target_not_found",
  "channel_archived",
  "mention_validation",
  "server_internal",
  "unknown",
] as const satisfies readonly SendRouteSubkind[];

/**
 * Taggable known set — the values a CALL-SITE may explicitly tag via
 * `SendRouteError`. This DELIBERATELY EXCLUDES `unknown`: per contract, `unknown`
 * is the resolver's non-Error / unclassifiable catch-all and a taxonomy-drift
 * signal — it must never be tagged at a throw site (that would defeat its
 * meaning). `server_internal` is also resolver-derived (default for genuine
 * Errors), so a call-site uses an explicit tag only for the structurally-known
 * branches; tagging `server_internal` explicitly is allowed but rarely needed.
 */
export const TAGGABLE_SEND_ROUTE_SUBKINDS = [
  "bad_request",
  "agent_not_found",
  "freshness_not_enabled",
  "target_forbidden",
  "target_not_found",
  "channel_archived",
  "mention_validation",
  "server_internal",
] as const satisfies readonly SendRouteSubkind[];

/**
 * The full observable vocabulary type (resolver output). 9 values.
 */
export type ObservableSendRouteSubkind = (typeof OBSERVABLE_SEND_ROUTE_SUBKINDS)[number];

/**
 * The constructor-accepted type for `SendRouteError`. 8 values — excludes
 * `unknown`. Derived from the array so the two cannot drift.
 */
export type TaggableSendRouteSubkind = (typeof TAGGABLE_SEND_ROUTE_SUBKINDS)[number];

/**
 * An error carrying a structurally-known send-route subkind, tagged at the
 * throw/branch site so the failure event can classify it without inspecting the
 * message. Accepts only TAGGABLE values — `unknown` is unconstructable here (by
 * type + runtime guard), because `unknown` may only arise as the resolver's
 * catch-all, never as a deliberate tag.
 */
export class SendRouteError extends Error {
  readonly subkind: TaggableSendRouteSubkind;

  constructor(subkind: TaggableSendRouteSubkind, message: string) {
    super(message);
    this.name = "SendRouteError";
    // Defense-in-depth: type blocks `unknown`/invalid statically; a wire/dynamic
    // value cast through `as any` is rejected at runtime so it can never reach a
    // trace as a tagged value.
    if (!(TAGGABLE_SEND_ROUTE_SUBKINDS as readonly string[]).includes(subkind)) {
      throw new Error(`SendRouteError: subkind "${subkind}" is not a taggable send-route value (unknown is resolver-only)`);
    }
    this.subkind = subkind;
  }
}

/**
 * Predicate the classifier uses to recognize a MentionValidationError WITHOUT
 * importing messageService into the tracing layer (avoids a layering cycle:
 * tracing must not depend on services). We match on the structural `name`
 * marker the error class sets — this is a typed-class identity check on a
 * constant the class itself assigns, NOT free-form message sniffing.
 */
function isMentionValidationError(err: unknown): boolean {
  return err instanceof Error && err.name === "MentionValidationError";
}

/**
 * Resolve the send-route subkind for a value thrown into the outer catch.
 * Order: explicit `SendRouteError` tag → known typed errors (mention
 * validation) → genuine server-internal default for real Errors → `unknown`
 * for non-Error throws. Never inspects `err.message`.
 */
export function resolveSendRouteSubkind(err: unknown): ObservableSendRouteSubkind {
  if (err instanceof SendRouteError) {
    return err.subkind;
  }
  if (isMentionValidationError(err)) {
    return "mention_validation";
  }
  if (err instanceof Error) {
    return "server_internal";
  }
  return "unknown";
}

const SEND_ROUTE_FAILURE_EVENT = "agent_api_send.request.failed";

/**
 * Emit the standardized send-route failure trace event for a STRUCTURED 4xx
 * early-return branch (which has no thrown error to classify). Keeps the
 * structured-4xx branches observable on the same closed-set surface as the
 * outer-catch path, so all ratified subkinds — not just the catch-path ones —
 * actually appear in traces. `http_status` records the response code so a
 * trace consumer can pair subkind ↔ status without reading source.
 */
export function traceSendRouteFailure(subkind: TaggableSendRouteSubkind, httpStatus: number): void {
  addTraceEvent(SEND_ROUTE_FAILURE_EVENT, {
    error_subkind: subkind,
    http_status: httpStatus,
  });
}

/**
 * Emit the standardized send-route failure event for the OUTER CATCH path,
 * where an actual error was thrown. Classifies structurally (never sniffs the
 * message) and includes a bounded, sanitized message for diagnostics.
 */
export function traceSendRouteCatch(err: unknown, httpStatus: number): void {
  addTraceEvent(SEND_ROUTE_FAILURE_EVENT, {
    error_class: err instanceof Error ? err.name : typeof err,
    error_subkind: resolveSendRouteSubkind(err),
    error_message: sanitizeRouteErrorMessage(err instanceof Error ? err.message : String(err ?? "")),
    http_status: httpStatus,
  });
}
