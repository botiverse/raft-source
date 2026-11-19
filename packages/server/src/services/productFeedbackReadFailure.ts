import { ProductFeedbackConversationError } from "./productFeedbackConversationService";
import { ProductFeedbackSourceUnavailableError } from "./productFeedbackApps";
import { isTransientHandsFailure, ProductFeedbackRouteBindingError } from "./productFeedbackRouteBindingService";

/**
 * Hands slow or refusing for a moment, as on a fresh task right after a deploy
 * (v1.21.49 switch: 95 list 503s from binding and read timeouts and the open
 * breaker). Configuration and authorization failures are not: those stay
 * errors so they are seen. Shared by the list route's degraded answer and the
 * merged list's per-app drop (productFeedbackMergedList.ts).
 */
export function transientFeedbackReadFailure(error: unknown): { step: "binding" | "read"; reason: string } | null {
  if (error instanceof ProductFeedbackRouteBindingError) {
    return error.reason === "circuit_open" || isTransientHandsFailure(error.reason)
      ? { step: "binding", reason: error.reason }
      : null;
  }
  if (!(error instanceof ProductFeedbackConversationError) || error.code !== "feedback_service_unavailable") return null;
  const { stage, upstreamStatus } = error.diagnostic;
  const transient = stage === "breaker_open"
    || stage === "upstream_transport"
    || stage === "reporter_session_transport"
    || ((stage === "upstream_response" || stage === "reporter_session_response") && upstreamStatus !== null && upstreamStatus >= 500);
  return transient ? { step: "read", reason: stage } : null;
}

/**
 * What a failed list read was, for the request span: the code the client got,
 * the step that failed, its fixed reason, and Hands' HTTP status when it
 * answered. The request span alone shows a 503 and its duration, so which of
 * the two 503 codes it was and whether Hands timed out or answered 5xx had to
 * be guessed from the duration (2026-11-15: 16 list 503s in ten hours, 12 of
 * them at exactly 5 s). Fixed codes and one status number only: never the
 * user, the ticket, or anything Hands sent in a body.
 */
export function feedbackListFailureTraceAttrs(error: unknown): {
  code: "feedback_integration_unavailable" | "feedback_service_unavailable";
  step: "source" | "binding" | "read" | "unknown";
  reason: string;
  upstream_status: number | null;
} {
  if (error instanceof ProductFeedbackSourceUnavailableError) {
    return { code: "feedback_integration_unavailable", step: "source", reason: error.reason, upstream_status: null };
  }
  if (error instanceof ProductFeedbackRouteBindingError) {
    const status = /^hands_status_(\d{3})$/.exec(error.reason);
    return {
      code: "feedback_integration_unavailable",
      step: "binding",
      reason: error.reason,
      upstream_status: status ? Number(status[1]) : null,
    };
  }
  if (
    error instanceof ProductFeedbackConversationError
    && (error.code === "feedback_integration_unavailable" || error.code === "feedback_service_unavailable")
  ) {
    return { code: error.code, step: "read", reason: error.diagnostic.stage, upstream_status: error.diagnostic.upstreamStatus };
  }
  return { code: "feedback_service_unavailable", step: "unknown", reason: "unclassified", upstream_status: null };
}
