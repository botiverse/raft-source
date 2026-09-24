import type { NextFunction, Request, Response } from "express";
import {
  createTraceScopeTracer,
  parseTraceparent,
  projectTraceScopeAttrs,
  noopTracer,
  type TraceAttributes,
  type TraceScope,
  type TraceSpanAttrContracts,
  type Tracer,
  type TraceStatus,
} from "@botiverse/raft-shared";
import { httpRequestDuration, httpRequestsTotal } from "../metrics.js";
import { normalizeRequestRoutePattern } from "./requestRoutePattern.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";

export type HttpStatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "other";
export type HttpCallerKind = "human" | "agent" | "system";

const AGENT_ID_HEADER = "x-agent-id";
const HTTP_REQUEST_SCOPE_ATTR_KEYS = [
  "daemon_version",
  "daemon_version_present",
  "route_pattern",
  "method",
  "caller_kind",
  "user_id",
  "user_id_present",
  "server_id_present",
  "machine_id_present",
  "agent_id_present",
  "session_id",
  "session_id_present",
  "auth_trace_source",
  "auth_trace_reason",
] as const;

const HTTP_REQUEST_TRACE_ATTR_CONTRACTS = {
  "server.http.request": {
    spanAttrs: [],
    eventAttrs: {
      "http.response.finished": [
        "event_kind",
        "outcome",
        "reason",
        ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
        "http.route",
        "http.request.method",
        "status_bucket",
        "http.response.status_code",
      ],
      "http.response.closed": [
        "event_kind",
        "outcome",
        "reason",
        ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
        "http.route",
        "http.request.method",
        "status_bucket",
        "http.response.status_code",
      ],
    },
    endAttrs: [
      "event_kind",
      "outcome",
      "reason",
      ...HTTP_REQUEST_SCOPE_ATTR_KEYS,
      "http.route",
      "http.request.method",
      "status_bucket",
      "status_code",
      "http.response.status_code",
    ],
  },
} satisfies TraceSpanAttrContracts;

export function normalizeObservedRoutePattern(req: Request): string {
  return normalizeRequestRoutePattern(req, {
    includeQuery: false,
    unmatchedLabel: "unmatched",
  });
}

export function bucketHttpStatus(status: number): HttpStatusBucket {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

function httpOutcomeForStatus(statusCode: number): "success" | "error" {
  return statusCode >= 500 ? "error" : "success";
}

function httpReasonForStatusBucket(statusBucket: HttpStatusBucket): string {
  return `http_${statusBucket}`;
}

export function hasAgentIdHint(req: Request, routePattern: string): boolean {
  return Boolean(req.header?.(AGENT_ID_HEADER)?.trim()) || routePattern.startsWith("/internal/agent/");
}

export function inferHttpCallerKind(req: Request, routePattern: string): HttpCallerKind {
  if (hasAgentIdHint(req, routePattern)) return "agent";
  if (req.machineId || routePattern.startsWith("/internal/machine/") || routePattern === "/health") return "system";
  return "human";
}

export type AuthTraceIdentitySource =
  | "email_register"
  | "email_login"
  | "mobile_oauth"
  | "social_oauth"
  | "device_auth"
  | "require_auth"
  | "refresh"
  | "logout";

export type AuthTraceIdentityReason =
  | "invalid_or_expired_refresh"
  | "invalid_refresh_binding"
  | "missing_refresh_token"
  | "logout_session_not_found"
  | "user_missing"
  | "password_mismatch"
  | "user_retired";

export interface AuthTraceIdentity {
  userId?: string | null;
  sessionId?: string | null;
  source: AuthTraceIdentitySource;
  reason?: AuthTraceIdentityReason | null;
}

declare global {
  namespace Express {
    interface Request {
      authTraceIdentity?: AuthTraceIdentity;
    }
  }
}

export function attachAuthTraceIdentity(req: Request, identity: AuthTraceIdentity): void {
  req.authTraceIdentity = identity;
}

function buildRequestTraceScope(
  req: Request,
  routePattern: string | null,
  callerKind: HttpCallerKind | null,
  agentIdPresent: boolean | null,
): TraceScope {
  return {
    resource: {
      daemonVersion: req.daemonVersion,
    },
    request: {
      ...(routePattern ? { routePattern } : {}),
      method: req.method,
      ...(callerKind ? { callerKind } : {}),
      userId: req.authTraceIdentity?.userId,
      userIdPresent: Boolean(req.authTraceIdentity?.userId ?? req.userId),
    },
    actor: {
      serverId: req.serverId,
      machineId: req.machineId,
      ...(typeof agentIdPresent === "boolean" ? { agentIdPresent } : {}),
      sessionId: req.authTraceIdentity?.sessionId,
      sessionIdPresent: Boolean(req.authTraceIdentity?.sessionId),
    },
  };
}

function buildInitialRequestTraceScope(req: Request): TraceScope {
  return {
    resource: {
      daemonVersion: req.daemonVersion,
    },
    request: {
      method: req.method,
    },
  };
}

export function requestObservabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const endTimer = httpRequestDuration.startTimer();
  const baseTracer = (req.app?.get?.("serverTracer") as Tracer | undefined) ?? noopTracer;
  const tracer = createTraceScopeTracer(baseTracer, buildInitialRequestTraceScope(req), {
    spanAttrContracts: HTTP_REQUEST_TRACE_ATTR_CONTRACTS,
    scopeAttrPrecedence: "caller",
  });
  const parent = parseTraceparent(req.header?.("traceparent"));
  const span = tracer.startSpan("server.http.request", {
    parent,
    surface: "server",
    kind: "server",
  });
  let spanEnded = false;
  const endHttpSpan = (
    eventName: "http.response.finished" | "http.response.closed",
    status: TraceStatus,
    recordMetrics: boolean,
  ) => {
    if (spanEnded) return;
    spanEnded = true;
    const routePattern = normalizeObservedRoutePattern(req);
    const callerKind = inferHttpCallerKind(req, routePattern);
    const agentIdPresent = hasAgentIdHint(req, routePattern);
    const requestScopeAttrs = {
      ...projectTraceScopeAttrs(buildRequestTraceScope(req, routePattern, callerKind, agentIdPresent)),
      ...projectAuthTraceIdentityAttrs(req),
    };
    const labels = {
      route_pattern: routePattern,
      method: req.method,
      status_bucket: bucketHttpStatus(res.statusCode),
    };
    const outcome = eventName === "http.response.closed" ? "cancelled" : httpOutcomeForStatus(res.statusCode);
    const reason = eventName === "http.response.closed" ? "response_closed" : httpReasonForStatusBucket(labels.status_bucket);
    if (recordMetrics) {
      httpRequestsTotal.labels(labels.route_pattern, labels.method, labels.status_bucket).inc();
      endTimer(labels);
    }
    span.addEvent(eventName, {
      event_kind: "http_request",
      outcome,
      reason,
      "http.route": labels.route_pattern,
      "http.request.method": labels.method,
      status_bucket: labels.status_bucket,
      "http.response.status_code": res.statusCode,
      ...requestScopeAttrs,
    });
    span.end(status, {
      attrs: {
        event_kind: "http_request",
        outcome,
        reason,
        "http.route": labels.route_pattern,
        "http.request.method": labels.method,
        status_bucket: labels.status_bucket,
        status_code: res.statusCode,
        "http.response.status_code": res.statusCode,
        ...requestScopeAttrs,
      },
    });
  };

  res.on("finish", () => {
    endHttpSpan("http.response.finished", toTraceStatus(res.statusCode), true);
  });

  res.on("close", () => {
    if (res.writableEnded) return;
    endHttpSpan("http.response.closed", "cancelled", false);
  });

  runWithTraceSpan(span, next, tracer);
}

function projectAuthTraceIdentityAttrs(req: Request): TraceAttributes {
  const identity = req.authTraceIdentity;
  if (!identity) return {};
  return {
    auth_trace_source: identity.source,
    ...(identity.reason ? { auth_trace_reason: identity.reason } : {}),
  };
}

function toTraceStatus(statusCode: number): TraceStatus {
  return statusCode >= 500 ? "error" : "ok";
}
