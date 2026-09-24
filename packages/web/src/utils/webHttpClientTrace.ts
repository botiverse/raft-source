import {
  BasicTracer,
  formatTraceparent,
} from "@botiverse/raft-shared";
import type {
  ActiveSpan,
  CompletedTraceSpan,
  TraceSink,
  TraceStatus,
} from "@botiverse/raft-shared";
import {
  buildWebTraceRecord,
  emitWebTraceRecord,
} from "./webAuthTrace";
import type {
  WebTraceEventName,
} from "./webAuthTrace";

export type WebHttpStatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "network_error" | "other";

export interface WebHttpClientSpan {
  readonly traceparent: string;
  end(input: WebHttpClientTerminalInput): void;
}

export interface WebHttpTraceRequestConfig {
  method?: string;
  url?: string;
  headers: Record<string, unknown>;
}

export interface WebHttpClientTerminalInput {
  statusCode?: number;
  cancelled?: boolean;
  requestUrl?: string;
  responseData?: unknown;
  responseHeaders?: unknown;
}

const FORWARD_STABLE_CODES = new Set([
  "authority_changed",
  "channel_archived",
  "cross_server_source",
  "cross_source_bundle",
  "destination_unavailable",
  "forwarded_source_not_supported",
  "idempotency_conflict",
  "request_conflict",
  "source_attachment_changed",
  "source_not_found",
  "unsupported_source",
  "unsupported_source_message",
]);

function responseCode(responseData: unknown): string | undefined {
  if (!responseData || typeof responseData !== "object") return undefined;
  const code = (responseData as { code?: unknown }).code;
  return typeof code === "string" && FORWARD_STABLE_CODES.has(code) ? code : undefined;
}

function forwardOutcomeHeader(responseHeaders: unknown): string | undefined {
  if (!responseHeaders || typeof responseHeaders !== "object") return undefined;
  const getter = (responseHeaders as { get?: unknown }).get;
  const value = typeof getter === "function"
    ? getter.call(responseHeaders, "x-raft-forward-outcome")
    : (responseHeaders as Record<string, unknown>)["x-raft-forward-outcome"];
  return typeof value === "string" && ["success", "idempotent_replay", "partial_failure", "all_failed"].includes(value)
    ? value
    : undefined;
}

/**
 * Add only closed, low-cardinality Forward diagnostics to the existing HTTP
 * client span. The exact URL, request body, request id, and product ids never
 * enter the trace payload.
 */
export function forwardHttpDiagnosticAttrs(input: WebHttpClientTerminalInput): Record<string, unknown> {
  if (input.requestUrl !== "/messages/forward") return {};
  const bucket = statusBucket(input.statusCode);
  const knownCode = responseCode(input.responseData);
  const outcomeHeader = forwardOutcomeHeader(input.responseHeaders);
  const stableCode = knownCode ?? outcomeHeader
    ?? (input.cancelled ? "request_cancelled"
      : input.statusCode === undefined ? "network_error"
        : input.statusCode === 401 ? "auth_required"
          : input.statusCode === 403 ? "permission_denied"
            : input.statusCode === 404 ? "not_found"
              : input.statusCode === 409 ? "conflict"
                : input.statusCode >= 500 ? "server_error"
                  : input.statusCode >= 400 ? "client_error"
                    : "ok");
  return {
    route_family: "message_forward",
    response_state: input.statusCode === undefined ? "not_received_unknown" : "received",
    stable_code: stableCode,
    forward_outcome: input.cancelled
      ? "cancelled"
      : input.statusCode === undefined
        ? "unknown"
        : input.statusCode >= 200 && input.statusCode < 300
          ? outcomeHeader ?? "success"
          : "error",
    forward_status_bucket: bucket,
  };
}

function statusBucket(statusCode: number | undefined): WebHttpStatusBucket {
  if (statusCode === undefined) return "network_error";
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

function recordCompletedHttpSpan(span: CompletedTraceSpan): void {
  emitWebTraceRecord(buildWebTraceRecord(span.name as WebTraceEventName, span.attrs, {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    parentSpanId: span.context.parentSpanId,
    kind: span.kind,
    status: span.status,
    startTime: new Date(span.startTimeMs).toISOString(),
    endTime: new Date(span.endTimeMs).toISOString(),
    surface: span.surface as "web",
  }));
}

const defaultTraceSink: TraceSink = { record: recordCompletedHttpSpan };
let tracer = new BasicTracer({ sink: defaultTraceSink });

/** Test-only sink seam for proving Web + Server trace correlation in one sink. */
export function __setWebHttpClientTraceSinkForTest(sink: TraceSink | null): void {
  tracer = new BasicTracer({ sink: sink ?? defaultTraceSink });
}

const httpClientSpans = new WeakMap<object, WebHttpClientSpan>();

/**
 * Start one real browser HTTP-client span. The span exists even without a
 * previously-active web span: the outgoing request itself is the operation,
 * so its context is safe to propagate and is never a detached/fabricated id.
 */
export function startWebHttpClientSpan(method: string | undefined): WebHttpClientSpan {
  const span: ActiveSpan = tracer.startSpan("web.http.client", {
    surface: "web",
    kind: "client",
    attrs: {
      method: (method || "GET").toUpperCase(),
    },
  });

  return {
    traceparent: formatTraceparent(span.context),
    end(input) {
      const bucket = statusBucket(input.statusCode);
      const traceStatus: TraceStatus = input.cancelled
        ? "cancelled"
        : Number(input.statusCode) < 400
          ? "ok"
          : "error";
      span.end(traceStatus, {
        attrs: {
          outcome: input.cancelled ? "cancelled" : traceStatus === "ok" ? "success" : "error",
          status_bucket: bucket,
          status_code: input.statusCode,
          ...forwardHttpDiagnosticAttrs(input),
        },
      });
    },
  };
}

/** Attach exactly one live span to one Axios request attempt. */
export function attachWebHttpClientTrace(config: WebHttpTraceRequestConfig): void {
  try {
    if (httpClientSpans.has(config)) return;
    const httpSpan = startWebHttpClientSpan(config.method);
    config.headers.traceparent = httpSpan.traceparent;
    httpClientSpans.set(config, httpSpan);
  } catch {
    // HTTP tracing is diagnostic-only and must never block the real request.
  }
}

/** Finish and detach the span for one attempt before Axios may retry it. */
export function finishWebHttpClientTrace(
  config: object,
  input: Omit<WebHttpClientTerminalInput, "requestUrl">,
): void {
  const httpSpan = httpClientSpans.get(config);
  httpClientSpans.delete(config);
  try {
    httpSpan!.end({
      ...input,
      requestUrl: (config as { url?: string }).url,
    });
  } catch {
    // Trace completion/upload is failure-isolated from the response path.
  }
}
