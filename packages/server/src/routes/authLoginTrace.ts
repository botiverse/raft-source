import type { EmailLoginRejectionReason } from "../services/userService.js";
import { addTraceEvent, getCurrentTraceContext } from "../tracing/semanticTrace.js";

/**
 * Records a failed email-login decision on the active HTTP request trace.
 *
 * `trace_id` is supplied by the trace envelope when ScopeDB projects this
 * event. The event itself contains only closed, low-cardinality diagnostics:
 * no user id, email, password, hash, or caller-supplied identifier.
 *
 * The returned trace id may be echoed as an opaque response header so a single
 * rejected request can be correlated without changing the public error body.
 */
export function recordEmailLoginRejectedTrace(
  reason: EmailLoginRejectionReason,
): string | undefined {
  addTraceEvent("auth.login.rejected", {
    event_kind: "auth_login",
    outcome: "rejected",
    reason,
    source: "email_login",
  });
  return getCurrentTraceContext()?.traceId;
}
