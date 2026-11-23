/**
 * The Resource Timing of one API request, for `web.http.client` and
 * `web.view.switch`. Best effort: a page without the performance APIs (SSR,
 * jsdom, an old WebView) or a cross-origin answer without Timing-Allow-Origin
 * (its phase times are 0, e.g. the desktop app's API base) gives nothing.
 * Never throws.
 */

export interface RequestTimingSegments {
  /** Waiting before DNS: the browser's queue, a stalled socket. */
  queue_ms?: number;
  /** DNS, TCP and TLS (0 on a reused connection). */
  connect_ms?: number;
  /** The parts of connect_ms, only when this request opened a connection: the DNS lookup, */
  dns_ms?: number;
  /** the TCP handshake (for HTTP/3 the whole QUIC handshake, with tls_ms 0 or inside it), */
  tcp_ms?: number;
  /** and the TLS handshake. */
  tls_ms?: number;
  /** Request sent to the first response byte. */
  ttfb_ms?: number;
  /** First to last response byte. */
  download_ms?: number;
}

export interface RequestTiming {
  segments: RequestTimingSegments;
  /** The response body as it came over the wire, when the entry says. */
  bytes?: number;
  /** The entry's whole duration, to pick the slowest of several requests. */
  durationMs: number;
}

interface PerformanceLike {
  now?: () => number;
  getEntriesByName?: (name: string, type?: string) => PerformanceEntryList;
}

function performanceApi(): PerformanceLike | null {
  const perf = (globalThis as { performance?: PerformanceLike }).performance;
  return perf && typeof perf === "object" ? perf : null;
}

/** performance.now(), or null where there is none. */
export function performanceNow(): number | null {
  try {
    const perf = performanceApi();
    return typeof perf?.now === "function" ? perf.now() : null;
  } catch {
    return null;
  }
}

/** The absolute URL Axios sends (its baseURL joined to the url), for Resource Timing lookups. */
export function absoluteRequestUrl(baseURL: string | undefined, url: string | undefined): string | null {
  try {
    if (!url) return null;
    const joined = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || !baseURL
      ? url
      : `${baseURL.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
    const origin = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(joined, origin).href;
  } catch {
    return null;
  }
}

function round(value: number): number {
  return Math.max(0, Math.round(value));
}

function isResourceEntry(entry: PerformanceEntry): entry is PerformanceResourceTiming {
  return typeof (entry as PerformanceResourceTiming).responseEnd === "number";
}

/**
 * The browser's resource timing buffer holds 250 entries and then drops new
 * ones, which a long session reaches. An observer keeps the latest entry per
 * URL (and per URL without its query, for a query Axios serialized from
 * `params`) in a small LRU map instead.
 */
const RECENT_ENTRIES_MAX = 200;
let recentEntries = new Map<string, PerformanceResourceTiming>();
let observer: { takeRecords?: () => PerformanceEntryList; disconnect?: () => void } | null = null;
let observerTried = false;

function remember(entry: PerformanceEntry): void {
  if (!isResourceEntry(entry)) return;
  for (const key of new Set([entry.name, entry.name.split("?", 1)[0]!])) {
    recentEntries.delete(key);
    recentEntries.set(key, entry);
  }
  while (recentEntries.size > RECENT_ENTRIES_MAX) {
    const oldest = recentEntries.keys().next().value;
    if (oldest === undefined) break;
    recentEntries.delete(oldest);
  }
}

/** Start the resource observer once; nothing where there is no PerformanceObserver. */
export function watchResourceTiming(): void {
  if (observerTried) return;
  observerTried = true;
  try {
    const Observer = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (typeof Observer !== "function") return;
    const created = new Observer((list) => {
      for (const entry of list.getEntries()) remember(entry);
    });
    created.observe({ type: "resource", buffered: true });
    observer = created;
  } catch {
    observer = null;
  }
}

/**
 * The latest resource entry for this URL that started at or after `sentAt`
 * (performance.now() when the request was sent): from the observer's map
 * (its undelivered records taken first), else getEntriesByName. No scan of
 * the whole buffer.
 */
function findEntry(perf: PerformanceLike, url: string, sentAt: number | null): PerformanceResourceTiming | null {
  const fresh = (entry: PerformanceEntry | undefined): entry is PerformanceResourceTiming =>
    !!entry && isResourceEntry(entry) && (sentAt === null || entry.startTime >= sentAt - 1);
  if (observer) {
    for (const entry of observer.takeRecords?.() ?? []) remember(entry);
    const observed = recentEntries.get(url) ?? recentEntries.get(url.split("?", 1)[0]!);
    if (fresh(observed)) return observed;
  }
  const exact = typeof perf.getEntriesByName === "function" ? perf.getEntriesByName(url, "resource") : [];
  return [...exact].reverse().find(fresh) ?? null;
}

/** Test seam: forget the observer and its entries. */
export function __resetResourceTimingForTest(): void {
  observer?.disconnect?.();
  observer = null;
  observerTried = false;
  recentEntries = new Map();
}

/** The request's timing and size from its Resource Timing entry, or null. */
export function requestTiming(url: string | null, sentAt: number | null): RequestTiming | null {
  try {
    if (!url) return null;
    const perf = performanceApi();
    if (!perf) return null;
    const entry = findEntry(perf, url, sentAt);
    if (!entry) return null;
    const segments: RequestTimingSegments = {};
    // 0 phase times: a cross-origin answer without Timing-Allow-Origin.
    if (entry.requestStart > 0 && entry.responseStart > 0) {
      const dnsStart = entry.domainLookupStart > 0 ? entry.domainLookupStart : entry.fetchStart;
      segments.queue_ms = round(dnsStart - entry.startTime);
      segments.connect_ms = round(entry.requestStart - dnsStart);
      // A reused connection has connectStart == connectEnd: no parts to report.
      if (entry.connectEnd > entry.connectStart && entry.connectStart > 0) {
        const tlsStart = entry.secureConnectionStart > 0 ? entry.secureConnectionStart : entry.connectEnd;
        segments.dns_ms = round(entry.domainLookupEnd - entry.domainLookupStart);
        segments.tcp_ms = round(tlsStart - entry.connectStart);
        segments.tls_ms = round(entry.connectEnd - tlsStart);
      }
      segments.ttfb_ms = round(entry.responseStart - entry.requestStart);
      segments.download_ms = round(entry.responseEnd - entry.responseStart);
    }
    const bytes = entry.encodedBodySize > 0 ? entry.encodedBodySize : undefined;
    return { segments, bytes, durationMs: Math.max(0, entry.responseEnd - entry.startTime) };
  } catch {
    return null;
  }
}

/** A Content-Length response header as a number, from Axios headers or a plain object. */
export function contentLengthOf(headers: unknown): number | undefined {
  try {
    if (!headers || typeof headers !== "object") return undefined;
    const getter = (headers as { get?: unknown }).get;
    const raw = typeof getter === "function"
      ? getter.call(headers, "content-length")
      : (headers as Record<string, unknown>)["content-length"];
    const value = Number(raw);
    return raw !== undefined && raw !== null && raw !== "" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The CloudFront edge location that answered (`X-Amz-Cf-Pop`, e.g. `NRT57-P2`),
 * from Axios headers or a plain object. Only a value of that shape is kept.
 */
export function edgePopOf(headers: unknown): string | undefined {
  try {
    if (!headers || typeof headers !== "object") return undefined;
    const getter = (headers as { get?: unknown }).get;
    const raw = typeof getter === "function"
      ? getter.call(headers, "x-amz-cf-pop")
      : (headers as Record<string, unknown>)["x-amz-cf-pop"];
    return typeof raw === "string" && /^[A-Z]{3}\d{1,3}(?:-[A-Z]\d{1,2})?$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}
