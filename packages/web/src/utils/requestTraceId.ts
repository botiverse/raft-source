/**
 * The trace id of a request, so an error the app shows can carry an id a user
 * can send us (#proj-o11y:#18). Every API request already sends a W3C
 * `traceparent` (webHttpClientTrace.ts); the server continues that trace for a
 * web session and returns the trace it recorded as `X-Trace-Id`
 * (requestObservability.ts). The response header wins: it is the id the
 * server's spans carry for every kind of credential. The request's own
 * traceparent is the fallback for a request that got no response.
 */

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const ALL_ZERO_RE = /^0+$/;

function validTraceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return TRACE_ID_RE.test(id) && !ALL_ZERO_RE.test(id) ? id : null;
}

function headerValue(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    try {
      const value = (getter as (key: string) => unknown).call(headers, name);
      if (value !== undefined && value !== null) return value;
    } catch {
      // Fall through to plain property access.
    }
  }
  const record = headers as Record<string, unknown>;
  return record[name] ?? record[name.toLowerCase()];
}

/** The trace id in a W3C `traceparent` (`00-<trace id>-<span id>-<flags>`), or null. */
export function traceIdFromTraceparent(traceparent: unknown): string | null {
  if (typeof traceparent !== "string") return null;
  return validTraceId(traceparent.split("-")[1]);
}

/** The trace id of a failed (or answered) axios request, or null when it carried none. */
export function traceIdFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { response, config } = error as { response?: { headers?: unknown }; config?: { headers?: unknown } };
  return validTraceId(headerValue(response?.headers, "x-trace-id"))
    ?? traceIdFromTraceparent(headerValue(config?.headers, "traceparent"));
}

/**
 * The most recent failed API request. Error toasts are raised by each feature
 * right after its request fails, from its own catch; rather than thread the id
 * through every one of them, an error toast shown within RECENT_FAILURE_MS of a
 * failure carries that failure's id (LocalizedToastProvider.tsx).
 */
export const RECENT_FAILURE_MS = 5_000;
let lastFailure: { traceId: string; atMs: number } | null = null;

export function recordFailedRequestTraceId(error: unknown, nowMs: number = Date.now()): void {
  const traceId = traceIdFromError(error);
  if (traceId) lastFailure = { traceId, atMs: nowMs };
}

export function recentFailedRequestTraceId(nowMs: number = Date.now()): string | null {
  if (!lastFailure || nowMs - lastFailure.atMs > RECENT_FAILURE_MS) return null;
  return lastFailure.traceId;
}

/**
 * The recent failure's id for an error toast, given out once: a later error
 * toast (one raised with no request of its own, say) does not show it again.
 */
export function takeRecentFailedRequestTraceId(nowMs: number = Date.now()): string | null {
  const traceId = recentFailedRequestTraceId(nowMs);
  if (traceId) lastFailure = null;
  return traceId;
}

/** Test seam. */
export function __resetFailedRequestTraceIdForTest(): void {
  lastFailure = null;
}
