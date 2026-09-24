import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, Response } from "express";
import { normalizeObservedRoutePattern } from "../middleware/requestObservability.js";
import { addTraceEvent, getCurrentTraceContext } from "../tracing/semanticTrace.js";
import { sanitizeRouteErrorMessage } from "../tracing/routeFailure.js";

interface JsonServerErrorOptions {
  error: string;
  code?: string;
  status?: number;
  logPrefix: string;
  err: unknown;
}

export function sendJsonServerError(
  req: Request,
  res: Response,
  options: JsonServerErrorOptions,
): void {
  const status = options.status ?? 500;
  const correlationId = getCurrentTraceContext()?.traceId ?? randomUUID();
  const errorClass = options.err instanceof Error ? options.err.name : typeof options.err;
  const rawMessage = options.err instanceof Error ? options.err.message : String(options.err ?? "");
  const sanitizedMessage = sanitizeRouteErrorMessage(rawMessage);
  const route = normalizeObservedRoutePattern(req);

  console.error(options.logPrefix, {
    correlationId,
    method: req.method,
    route,
    status,
    errorClass,
    errorMessage: sanitizedMessage,
  });

  addTraceEvent("server.route.error_response", {
    event_kind: "route_error_response",
    outcome: "error",
    reason: "unexpected_server_error",
    http_status: status,
    correlation_id: correlationId,
    error_class: errorClass,
    error_message: sanitizedMessage,
    "http.route": route,
  });

  res.setHeader("X-Slock-Error-Id", correlationId);
  res.status(status).json({
    error: options.error,
    ...(options.code ? { code: options.code } : {}),
    correlationId,
  });
}

export const globalJsonServerErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

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
