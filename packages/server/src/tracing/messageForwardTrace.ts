import type { NextFunction, Request, RequestHandler, Response } from "express";
import { noopTracer, type ActiveSpan, type Tracer } from "@botiverse/raft-shared";
import { getCurrentTraceContext, safeAddTraceEvent } from "./semanticTrace.js";

export type ForwardDiagnosticPhase =
  | "gate"
  | "validate"
  | "source_snapshot"
  | "resolve_authorize"
  | "persist_broadcast"
  | "response";

export type ForwardCommitState = "pre_commit" | "unknown" | "committed";
export type ForwardAdmissionStage = "auth" | "verified" | "server" | "limiter" | "handler";

type ForwardTraceState = {
  admissionStage: ForwardAdmissionStage;
  terminalRecorded: boolean;
  attemptSpan: ActiveSpan;
};

declare global {
  namespace Express {
    interface Request {
      forwardTraceState?: ForwardTraceState;
    }
  }
}

export function forwardCommitState(phase: ForwardDiagnosticPhase): ForwardCommitState {
  if (phase === "persist_broadcast") return "unknown";
  if (phase === "response") return "committed";
  return "pre_commit";
}

export function recordForwardTerminal(req: Request, input: {
  phase: ForwardDiagnosticPhase;
  outcome: "success" | "idempotent_replay" | "partial_failure" | "rejected" | "error";
  status: number;
  stableCode: string;
  errorClass: string;
  commitState?: ForwardCommitState;
}): void {
  if (req.forwardTraceState?.terminalRecorded) return;
  const attrs = {
    route_family: "message_forward",
    phase: input.phase,
    outcome: input.outcome,
    http_status: input.status,
    status_bucket: input.status === 0 ? "other" : input.status >= 500 ? "5xx" : input.status >= 400 ? "4xx" : "2xx",
    stable_code: input.stableCode,
    error_class: input.errorClass,
    commit_state: input.commitState ?? forwardCommitState(input.phase),
  };
  if (req.forwardTraceState) {
    req.forwardTraceState.terminalRecorded = true;
    req.forwardTraceState.attemptSpan.addEvent("messages.forward.terminal", attrs);
    req.forwardTraceState.attemptSpan.end(input.status >= 500 ? "error" : "ok", { attrs });
    return;
  }
  safeAddTraceEvent("messages.forward.terminal", () => attrs);
}

const NETWORK_ERROR_CODES = new Set(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ETIMEDOUT"]);

const ERROR_NAME_FAMILIES: Readonly<Record<string, { stableCode: string; errorClass: string }>> = {
  AbortError: { stableCode: "dependency_aborted", errorClass: "DependencyAbortError" },
  AggregateError: { stableCode: "unexpected_aggregate_error", errorClass: "AggregateError" },
  DrizzleQueryError: { stableCode: "database_error", errorClass: "DatabaseError" },
  FetchError: { stableCode: "dependency_network_error", errorClass: "DependencyNetworkError" },
  PostgresError: { stableCode: "database_error", errorClass: "DatabaseError" },
  RangeError: { stableCode: "unexpected_range_error", errorClass: "RangeError" },
  SocketError: { stableCode: "dependency_network_error", errorClass: "DependencyNetworkError" },
  StorageTimeoutError: { stableCode: "dependency_timeout", errorClass: "DependencyTimeoutError" },
  TimeoutError: { stableCode: "dependency_timeout", errorClass: "DependencyTimeoutError" },
  TypeError: { stableCode: "unexpected_type_error", errorClass: "TypeError" },
};

/**
 * Classify unexpected failures into a closed diagnostic taxonomy. Never emit
 * raw names, messages, provider codes, or constructor-controlled strings.
 */
export function boundedUnexpectedForwardError(error: unknown): { stableCode: string; errorClass: string; status: 500 } {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
    return { stableCode: "dependency_network_error", errorClass: "DependencyNetworkError", status: 500 };
  }
  const name = error instanceof Error ? error.name || error.constructor.name : "";
  const family = ERROR_NAME_FAMILIES[name];
  if (family) return { ...family, status: 500 };
  if (error instanceof Error) return { stableCode: "unexpected_error", errorClass: "Error", status: 500 };
  return { stableCode: "unexpected_non_error", errorClass: "NonErrorThrow", status: 500 };
}

export function classifyForwardAdmissionTerminal(
  stage: ForwardAdmissionStage,
  status: number,
): { stableCode: string; errorClass: string } {
  if (stage === "auth") {
    return status === 401
      ? { stableCode: "auth_required", errorClass: "AuthDenied" }
      : { stableCode: "auth_dependency_error", errorClass: "AuthDependencyError" };
  }
  if (stage === "verified") {
    if (status === 401) return { stableCode: "auth_required", errorClass: "AuthDenied" };
    return status === 403
      ? { stableCode: "account_not_ready", errorClass: "AccountAdmissionDenied" }
      : { stableCode: "account_resolution_error", errorClass: "AccountDependencyError" };
  }
  if (stage === "server") {
    if (status === 400) return { stableCode: "server_context_required", errorClass: "ServerContextDenied" };
    if (status === 403) return { stableCode: "server_membership_required", errorClass: "ServerMembershipDenied" };
    return { stableCode: "server_resolution_error", errorClass: "ServerDependencyError" };
  }
  if (stage === "limiter") {
    return status === 429
      ? { stableCode: "rate_limited", errorClass: "RateLimitDenied" }
      : { stableCode: "rate_limit_error", errorClass: "RateLimitDependencyError" };
  }
  return { stableCode: "handler_terminal_missing", errorClass: "TerminalGap" };
}

function isForwardPost(req: Request): boolean {
  return req.method === "POST" && req.originalUrl.split("?", 1)[0] === "/api/messages/forward";
}

/** Observe rejections that happen before the Forward router can execute. */
export function forwardAdmissionTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isForwardPost(req)) {
    next();
    return;
  }
  const tracer = (req.app?.get?.("serverTracer") as Tracer | undefined) ?? noopTracer;
  const attemptSpan = tracer.startSpan("server.message.forward", {
    parent: getCurrentTraceContext(),
    surface: "server",
    kind: "internal",
    attrs: { route_family: "message_forward" },
  });
  req.forwardTraceState = { admissionStage: "auth", terminalRecorded: false, attemptSpan };
  res.prependOnceListener("finish", () => {
    if (req.forwardTraceState?.terminalRecorded) return;
    const detail = classifyForwardAdmissionTerminal(req.forwardTraceState?.admissionStage ?? "auth", res.statusCode);
    recordForwardTerminal(req, {
      phase: "gate",
      outcome: res.statusCode >= 500 ? "error" : "rejected",
      status: res.statusCode,
      stableCode: detail.stableCode,
      errorClass: detail.errorClass,
      commitState: "pre_commit",
    });
  });
  res.prependOnceListener("close", () => {
    if (res.writableEnded || req.forwardTraceState?.terminalRecorded) return;
    const stage = req.forwardTraceState?.admissionStage ?? "auth";
    req.forwardTraceState?.attemptSpan.addEvent("messages.forward.client_disconnected", {
      route_family: "message_forward",
      admission_stage: stage,
      response_state: "closed",
    });
    // Before the handler starts, no Forward write can occur after disconnect.
    // Once the handler owns the attempt, disconnect is only a transport signal:
    // the handler may still commit and must retain authority over the terminal.
    if (stage !== "handler") {
      recordForwardTerminal(req, {
        phase: "gate",
        outcome: "error",
        status: 0,
        stableCode: "response_closed",
        errorClass: "ResponseClosed",
        commitState: "pre_commit",
      });
    }
  });
  next();
}

export function markForwardAdmissionStage(stage: ForwardAdmissionStage): RequestHandler {
  return (req, _res, next) => {
    if (req.forwardTraceState) req.forwardTraceState.admissionStage = stage;
    next();
  };
}
