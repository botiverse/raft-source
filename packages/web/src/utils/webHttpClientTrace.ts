import {
  BasicTracer,
  formatTraceparent,
  parseTraceparent,
} from "@botiverse/raft-shared";
import type {
  ActiveSpan,
  TraceContext,
  TraceSink,
  TraceStatus,
} from "@botiverse/raft-shared";
import { webTraceSink } from "../observability/webSpanSink";
import { apiRouteTemplate } from "../observability/apiRouteTemplate";
import { absoluteRequestUrl, contentLengthOf, performanceNow, requestTiming, watchResourceTiming } from "../observability/resourceTiming";
import { finishViewSwitchRequest, noteViewSwitchRequest } from "../observability/viewSwitchSpan";
import type { ViewSwitchRequest } from "../observability/viewSwitchSpan";

export type WebHttpStatusBucket = "2xx" | "3xx" | "4xx" | "5xx" | "network_error" | "other";

export interface WebHttpClientSpan {
  readonly traceparent: string;
  /** The request as counted by the view switch in flight (observability/viewSwitchSpan.ts), if it is one of its requests. */
  viewSwitch?: ViewSwitchRequest | null;
  end(input: WebHttpClientTerminalInput): void;
}

export interface WebHttpTraceRequestConfig {
  method?: string;
  url?: string;
  baseURL?: string;
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

const defaultTraceSink: TraceSink = webTraceSink;
let tracer = new BasicTracer({ sink: defaultTraceSink });

/** Test-only sink seam for proving Web + Server trace correlation in one sink. */
export function __setWebHttpClientTraceSinkForTest(sink: TraceSink | null): void {
  tracer = new BasicTracer({ sink: sink ?? defaultTraceSink });
}

const httpClientSpans = new WeakMap<object, WebHttpClientSpan>();

// The polled reads whose background-tab share is measured (#12928): their
// span says whether the tab was visible when the request was sent. Joined to
// the server span by trace id, and to the tab by the default tabId attr.
const TAB_VISIBILITY_ROUTES = [
  /^\/integrations\/permission-updates$/,
  /^\/messages\/sync(?:\?|$)/,
  /^\/channels\/joint-invites$/,
  /^\/servers\/[^/?]+\/seat-join-blocks$/,
];

/** `tab.visibility` (document.visibilityState now) for those routes; nothing for any other. */
export function tabVisibilityAttrs(url: string | undefined): Record<string, string> {
  if (!url || !TAB_VISIBILITY_ROUTES.some((route) => route.test(url))) return {};
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  return { "tab.visibility": hidden ? "hidden" : "visible" };
}

/**
 * Start one real browser HTTP-client span. The span exists even without a
 * previously-active web span: the outgoing request itself is the operation,
 * so its context is safe to propagate and is never a detached/fabricated id.
 * It carries the route template (`http.route`, never the URL's ids or query),
 * and at its end the response size and the Resource Timing segments.
 */
export function startWebHttpClientSpan(
  method: string | undefined,
  url?: string,
  continued?: { parent: TraceContext; startTimeMs: number },
  baseURL?: string,
): WebHttpClientSpan {
  const span: ActiveSpan = tracer.startSpan("web.http.client", {
    surface: "web",
    kind: "client",
    ...(continued ? { parent: continued.parent, startTimeMs: continued.startTimeMs } : {}),
    attrs: {
      method: (method || "GET").toUpperCase(),
      "http.route": apiRouteTemplate(url),
      ...tabVisibilityAttrs(url),
    },
  });
  watchResourceTiming();
  const absoluteUrl = absoluteRequestUrl(baseURL, url);
  const sentAt = performanceNow();

  const handle: WebHttpClientSpan = {
    traceparent: formatTraceparent(span.context),
    end(input) {
      const bucket = statusBucket(input.statusCode);
      const traceStatus: TraceStatus = input.cancelled
        ? "cancelled"
        : Number(input.statusCode) < 400
          ? "ok"
          : "error";
      const timing = input.statusCode === undefined ? null : requestTiming(absoluteUrl, sentAt);
      const bytes = timing?.bytes ?? contentLengthOf(input.responseHeaders);
      finishViewSwitchRequest(handle.viewSwitch, { bytes, timing });
      span.end(traceStatus, {
        attrs: {
          outcome: input.cancelled ? "cancelled" : traceStatus === "ok" ? "success" : "error",
          status_bucket: bucket,
          status_code: input.statusCode,
          ...(bytes !== undefined ? { response_bytes: bytes } : {}),
          ...timing?.segments,
          ...forwardHttpDiagnosticAttrs(input),
        },
      });
    },
  };
  return handle;
}

/** Attach exactly one live span to one Axios request attempt. */
export function attachWebHttpClientTrace(config: WebHttpTraceRequestConfig): void {
  try {
    if (httpClientSpans.has(config)) return;
    const httpSpan = startWebHttpClientSpan(config.method, config.url, undefined, config.baseURL);
    httpSpan.viewSwitch = noteViewSwitchRequest(config.url);
    config.headers.traceparent = httpSpan.traceparent;
    httpClientSpans.set(config, httpSpan);
  } catch {
    // HTTP tracing is diagnostic-only and must never block the real request.
  }
}

/**
 * The attempt is answered by a request the boot script sent earlier
 * (boot/bootPrefetch.ts): its span is replaced by one in that request's trace
 * (the server's span of it is in the same trace), started when it went out.
 * The span replaced was never ended, so it is never recorded.
 */
export function continueWebHttpClientTrace(config: WebHttpTraceRequestConfig, traceparent: string | undefined, sentAtMs: number): void {
  try {
    const parent = parseTraceparent(traceparent);
    if (!parent) return;
    const httpSpan = startWebHttpClientSpan(config.method, config.url, { parent, startTimeMs: sentAtMs }, config.baseURL);
    httpSpan.viewSwitch = httpClientSpans.get(config)?.viewSwitch;
    config.headers.traceparent = traceparent;
    httpClientSpans.set(config, httpSpan);
  } catch {
    // Diagnostic only, as above.
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
