import { getCurrentTraceContext } from "../tracing/semanticTrace";

/**
 * The current trace id as `X-Trace-Id` for a call to Hands, which records it
 * (as `trace_id`, next to its own `cf-ray` `request_id`) only when it is a W3C
 * trace id: exactly 32 lowercase hex (hands#855). A timed-out call gets no
 * response headers, so this is how a Hands log line and our span are matched.
 * Empty outside a trace or for any other shape.
 */
export function handsTraceHeaders(): Record<string, string> {
  const traceId = getCurrentTraceContext()?.traceId;
  return traceId && /^[0-9a-f]{32}$/.test(traceId) ? { "X-Trace-Id": traceId } : {};
}

/**
 * The Hands route a reporter path calls, with ids replaced, for span attrs
 * (`hands_route`): never the ids or the query string.
 */
export function handsReporterRouteTemplate(path: string): string {
  return path.split("?")[0]!
    .replace(/^\/api\/apps\/[^/]+/, "/api/apps/:appId")
    .replace(/\/reporter-feedback\/(?!route-subject(?:\/|$))[^/]+/, "/reporter-feedback/:ticketId")
    .replace(/\/attachments\/[^/]+/, "/attachments/:attachmentId");
}
