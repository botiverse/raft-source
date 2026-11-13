import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, Response } from "express";
import { normalizeObservedRoutePattern } from "../middleware/requestObservability";
import { addTraceEvent, errorClassOf, getCurrentTraceContext, safeAddTraceEvent } from "../tracing/semanticTrace";
import { isPoolAcquireTimeoutError } from "../db/statementMetrics";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure";
import { errorDiagnosisAttrs } from "../tracing/queryTrace";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { RisingWaveNotConfiguredError, RisingWaveOverloadedError, RisingWaveReadError } from "../db/risingwave";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { risingWaveUnavailableResponsesTotal } from "../metrics";
import { refuse, RefusalError } from "../lib/refusal";

/** Seconds a client should wait before retrying a RisingWave-overloaded read. */
export const RISINGWAVE_OVERLOAD_RETRY_AFTER_SECONDS = 2;

export function findRisingWaveOverload(err: unknown): RisingWaveOverloadedError | null {
  for (let current = err, depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof RisingWaveOverloadedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The RisingWave pool was saturated (every connection busy past the acquire
 * timeout): a temporary overload, not a server bug. Answer 503 + Retry-After so
 * clients retry and 5xx-bug monitoring does not count it. There is deliberately
 * no Postgres fallback: these reads moved to RisingWave because the Postgres
 * versions are expensive, and shifting them onto the primary during an RW
 * slowdown would turn one incident into two (Tenny, 2026-10-06).
 */
export function respondToRisingWaveOverload(err: unknown, res: Response): boolean {
  const overload = findRisingWaveOverload(err);
  if (!overload) return false;
  res.setHeader("Retry-After", String(RISINGWAVE_OVERLOAD_RETRY_AFTER_SECONDS));
  sendRisingWaveUnavailable(res, {
    status: 503,
    code: "rw_overloaded",
    retryable: true,
    error: "Temporarily overloaded, retry shortly",
    errorClass: "RisingWaveOverloadedError",
  });
  return true;
}

/**
 * The typed RisingWave failure contract (task #162), for routes that adopted
 * it (`GET /api/channels/unread`): overload as above; RisingWave not
 * configured is 503 rw_unconfigured with no Retry-After (retrying will not
 * help); any other RisingWave read failure is 502 rw_read_failed. Everything
 * else returns false and stays the route's 500. Clients treat all three as
 * "not obtained", never as zero.
 */
export function respondToRisingWaveUnavailable(err: unknown, res: Response): boolean {
  if (respondToRisingWaveOverload(err, res)) return true;
  if (respondToRisingWaveUnconfigured(err, res)) return true;
  if (err instanceof RisingWaveReadError) {
    sendRisingWaveUnavailable(res, {
      status: 502,
      code: "rw_read_failed",
      retryable: true,
      error: "Read failed, retry shortly",
      errorClass: "RisingWaveReadError",
    });
    return true;
  }
  return false;
}

/** RisingWave not configured: 503 rw_unconfigured, no Retry-After (retrying will not help). */
function respondToRisingWaveUnconfigured(err: unknown, res: Response): boolean {
  if (!(err instanceof RisingWaveNotConfiguredError)) return false;
  sendRisingWaveUnavailable(res, {
    status: 503,
    code: "rw_unconfigured",
    retryable: false,
    error: "RisingWave is not configured",
    errorClass: "RisingWaveNotConfiguredError",
  });
  return true;
}

function sendRisingWaveUnavailable(res: Response, response: {
  status: 502 | 503;
  code: "rw_overloaded" | "rw_unconfigured" | "rw_read_failed";
  retryable: boolean;
  error: string;
  errorClass: string;
}): void {
  addTraceEvent(`server.route.${response.code}`, {
    event_kind: "route_error_response",
    outcome: "error",
    reason: response.code,
    http_status: response.status,
    error_class: response.errorClass,
  });
  // Also on the request's own span (server.http.request error_code), so
  // dashboards filter these by column instead of expanding span events.
  setRequestTraceErrorCode(res, response.code);
  risingWaveUnavailableResponsesTotal.inc({
    route_pattern: normalizeObservedRoutePattern(res.req),
    code: response.code,
    retryable: String(response.retryable),
  });
  res.status(response.status).json({
    error: response.error,
    code: response.code,
    retryable: response.retryable,
  });
}

interface JsonServerErrorOptions {
  error: string;
  code?: string;
  /** Fields the caller still needs in a 500's body (e.g. what was committed before the failure). */
  extraBody?: Record<string, string>;
  status?: number;
  logPrefix: string;
  err: unknown;
  /**
   * Answer RisingWave not configured as 503 rw_unconfigured (logged) instead
   * of 500, for the Activity reads served only from RisingWave (inbox,
   * followed threads, unread summary; Tenny, 2026-10-30). Other RisingWave
   * read failures keep the route's 500.
   */
  risingWaveUnconfiguredAs503?: boolean;
}

/**
 * Answer a DM target the caller can fix (ambiguous same-name peer, unknown
 * peer kind) with its 4xx status, stable code and suggestedNextAction. For
 * routes whose catch does not end in sendJsonServerError.
 */
export function respondToDmTargetResolutionError(err: unknown, res: Response): boolean {
  if (!(err instanceof DmTargetResolutionError)) return false;
  res.status(err.status).json(err.toResponseBody());
  return true;
}

/**
 * Body for a send whose transaction lost a deadlock/serialization race on every
 * bounded retry. It rolled back, so resending (same idempotency key) is safe.
 */
export function transientSendConflictBody() {
  return {
    error: "The message was not sent because of a temporary database conflict. Retry the send.",
    code: "send_transient_conflict",
    retryable: true,
    suggestedNextAction: "retry the same send (reuse the idempotencyKey)",
  };
}

// Letters only would be a node code like EPIPE, not a SQLSTATE: those always have a digit.
const SQLSTATE_RE = /^(?=.*[0-9])[0-9A-Z]{5}$/;
const NODE_ERROR_CODE_RE = /^E[A-Z0-9_]{1,40}$/;
const PG_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * What a bare route catch can safely say about a failure: the outer and innermost
 * error classes (pg's own errors have the class name "error"), and the SQLSTATE,
 * connection error code and constraint name from anywhere in the cause chain,
 * since drizzle wraps the pg error. A pool that gave no connection in time has no
 * code of its own, so it reads as acquire_timeout. Never the message: it can carry
 * user data.
 */
export function routeFailureAttrs(err: unknown): {
  error_class: string;
  cause_class: string;
  sqlstate: string;
  error_code: string;
  constraint: string;
} {
  let sqlstate = "none";
  let errorCode = "none";
  let constraint = "none";
  let innermost = err;
  for (let current = err, depth = 0; current && depth < 5; depth += 1) {
    innermost = current;
    const { code, constraint: name, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (sqlstate === "none" && typeof code === "string" && SQLSTATE_RE.test(code)) sqlstate = code;
    if (errorCode === "none") {
      if (typeof code === "string" && NODE_ERROR_CODE_RE.test(code)) errorCode = code;
      else if (isPoolAcquireTimeoutError(current)) errorCode = "acquire_timeout";
    }
    if (constraint === "none" && typeof name === "string" && PG_IDENTIFIER_RE.test(name)) constraint = name;
    current = cause;
  }
  return { error_class: errorClassOf(err), cause_class: errorClassOf(innermost), sqlstate, error_code: errorCode, constraint };
}

/** For a catch that answers its own 500: leaves the response alone, records why. */
export function addRouteFailureEvent(operation: string, err: unknown): void {
  safeAddTraceEvent("server.route.failure", () => ({
    event_kind: "route_failure",
    outcome: "error",
    operation,
    ...routeFailureAttrs(err),
  }));
}

export function sendJsonServerError(
  req: Request,
  res: Response,
  options: JsonServerErrorOptions,
): void {
  // A refusal thrown below a route that catches everything is still the
  // refusal, not a 500 (most routes end in `catch (err) { sendJsonServerError(…) }`).
  if (options.err instanceof RefusalError) {
    refuse(res, options.err.status, options.err.refusal);
    return;
  }
  // A route that wraps channel resolution in a generic catch must still tell
  // the caller how to fix an ambiguous or malformed DM target.
  if (respondToDmTargetResolutionError(options.err, res)) return;
  if (respondToRisingWaveOverload(options.err, res)) return;
  const correlationId = getCurrentTraceContext()?.traceId ?? randomUUID();
  const errorClass = errorClassOf(options.err);
  const rawMessage = options.err instanceof Error ? options.err.message : String(options.err ?? "");
  const sanitizedMessage = sanitizeRouteErrorMessage(rawMessage);
  const route = normalizeObservedRoutePattern(req);
  const unconfigured = options.risingWaveUnconfiguredAs503 === true
    && options.err instanceof RisingWaveNotConfiguredError;
  const status = unconfigured ? 503 : options.status ?? 500;

  console.error(options.logPrefix, {
    correlationId,
    method: req.method,
    route,
    status,
    errorClass,
    errorMessage: sanitizedMessage,
  });
  if (unconfigured) {
    respondToRisingWaveUnconfigured(options.err, res);
    return;
  }

  addTraceEvent("server.route.error_response", {
    event_kind: "route_error_response",
    outcome: "error",
    reason: "unexpected_server_error",
    http_status: status,
    correlation_id: correlationId,
    error_class: errorClass,
    error_message: sanitizedMessage,
    ...errorDiagnosisAttrs(options.err),
    "http.route": route,
  });

  res.setHeader("X-Slock-Error-Id", correlationId);
  res.status(status).json({
    error: options.error,
    ...(options.code ? { code: options.code } : {}),
    ...options.extraBody,
    correlationId,
  });
}

/**
 * The body parsers' own 4xx errors (`express.json()` and friends), which
 * otherwise reach Express's default handler and answer HTML: the refusal
 * envelope instead, with a sentence that says what to change.
 */
export function respondToBodyReadError(err: unknown, res: Response): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  switch (type) {
    case "entity.parse.failed":
      refuse(res, 400, { code: "INVALID_JSON", error: "The request body isn't valid JSON. Fix its syntax and send it again." });
      return true;
    case "entity.too.large": {
      const limit = (err as { limit?: unknown }).limit;
      const size = typeof limit === "number" && Number.isFinite(limit) ? ` (${limit} bytes)` : "";
      refuse(res, 413, { code: "BODY_TOO_LARGE", error: `The request body is larger than this route accepts${size}. Send a smaller body.` });
      return true;
    }
    case "encoding.unsupported":
      refuse(res, 415, { code: "UNSUPPORTED_CONTENT_ENCODING", error: "The request body's content encoding isn't supported. Send it uncompressed, or compressed with gzip, deflate or br." });
      return true;
    case "charset.unsupported":
      refuse(res, 415, { code: "UNSUPPORTED_CHARSET", error: "The request body's charset isn't supported. Send it as UTF-8." });
      return true;
    case "parameters.too.many":
      refuse(res, 413, { code: "TOO_MANY_PARAMETERS", error: "The request body has more form parameters than this route accepts. Send fewer." });
      return true;
    case "request.aborted":
    case "request.size.invalid":
      refuse(res, 400, { code: "INCOMPLETE_BODY", error: "The request body ended before it was complete. Send the request again." });
      return true;
    default:
      return false;
  }
}

export const globalJsonServerErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  // A DM target the caller can fix (ambiguous same-name peer, unknown peer
  // kind): answer with its 4xx status and machine-readable code.
  if (respondToDmTargetResolutionError(err, res)) return;
  if (respondToRisingWaveOverload(err, res)) return;

  if (err instanceof RefusalError) {
    refuse(res, err.status, err.refusal);
    return;
  }
  if (respondToBodyReadError(err, res)) return;

  const candidateStatus = Number((err as { status?: unknown; statusCode?: unknown } | null)?.status
    ?? (err as { statusCode?: unknown } | null)?.statusCode);
  if (Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus < 500) {
    next(err);
    return;
  }

  const status = Number.isInteger(candidateStatus) && candidateStatus >= 500 && candidateStatus < 600
    ? candidateStatus
    : 500;

  sendJsonServerError(req, res, {
    error: "Internal server error",
    code: "internal_server_error",
    status,
    logPrefix: "[Server] Unhandled route error",
    err,
  });
};
