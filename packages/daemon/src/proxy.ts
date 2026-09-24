import { HttpsProxyAgent } from "https-proxy-agent";
import {
  Agent,
  ProxyAgent,
  type Dispatcher,
} from "undici";

type WebSocketOptions = import("ws").ClientOptions;

const fetchDispatcherCache = new Map<string, Dispatcher>();
const isolatedFetchDispatcherCache = new Map<string, Dispatcher>();

// Bounded PRE-RESPONSE timeout for the proxied fetch dispatcher.
//
// This intentionally bounds only the connection/tunnel-establishment and the
// wait for response headers — NOT the response body. A daemon fetch through a
// proxy can legitimately stream a long/slow response body; a whole-request
// deadline would abort that mid-stream and misclassify a healthy-but-slow
// response as a transport failure. The undici options used here all fire before
// any Response is produced and are body-agnostic, so a slow body can never trip
// them.
//
// undici 7.x ProxyAgent has TWO distinct pre-response failure legs, each with a
// different knob (verified against undici 7.24.7 source + probes):
//   - headers-hang leg: tunnel established, origin never sends response headers
//     → bounded by `headersTimeout`. undici's default here is 5min, so this is
//     the leg that turns a flaky proxy into a "send hangs ~forever" outage.
//   - connect-establish leg: the CONNECT tunnel to the origin never completes
//     → the tunnel connector is built from `requestTls`, so it is bounded by
//     `requestTls.timeout`. undici's default is 10s; `connect.timeout` alone
//     does NOT cover this leg (it bounds only the socket to the proxy itself).
// `connect.timeout` is kept as defensive coverage for the proxy socket.
//
// Timer granularity: undici's connect/headers timers are coarse, so the actual
// firing time is the configured value plus an additive granularity overhead
// (observed in the ~hundreds-of-ms range for sub-second configs), not a
// multiplier and not exact. At the 30s default this overhead is negligible. The
// contract is "bounded", not "precise to the millisecond" — do not read the 30s
// default as a 60-90s deadline.
//
// Why this matters: before commit 5802cf77 (2026-05-26) the daemon send-path
// (credential proxy / `/internal/agent-api/send`) ignored HTTPS_PROXY and went
// direct. That commit unified daemon server fetches through buildFetchDispatcher
// so they honor the proxy via a cached ProxyAgent — but, unlike the chat-bridge
// MCP path (which has its own 60s tool timeout), it carried no transport
// timeout, leaving the 5min headers-hang default in play. This restores a
// bounded pre-response deadline on the proxied path.
//
// Default 30s sits below the chat-bridge tool timeout (60s) so a dead proxy
// fails the connect/headers phase before the surrounding tool call times out.
function getFetchPreResponseTimeoutMs(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

function getProviderProxyOptions(env: NodeJS.ProcessEnv): {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
} {
  const allProxy = env.ALL_PROXY || env.all_proxy;
  return {
    httpProxy: env.HTTP_PROXY || env.http_proxy || allProxy,
    httpsProxy: env.HTTPS_PROXY || env.https_proxy || allProxy,
    noProxy: env.NO_PROXY || env.no_proxy || "",
  };
}

function assertSupportedProviderProxyUrl(proxyUrl: string | undefined): void {
  if (!proxyUrl) return;
  let protocol: string;
  try {
    protocol = new URL(proxyUrl).protocol;
  } catch {
    const error = new Error("Pi provider proxy URL is invalid");
    Object.assign(error, { code: "PI_PROVIDER_PROXY_INVALID" });
    throw error;
  }
  if (protocol === "http:" || protocol === "https:") return;
  const error = new Error("Pi provider proxy protocol is unsupported");
  Object.assign(error, { code: "PI_PROVIDER_PROXY_PROTOCOL_UNSUPPORTED" });
  throw error;
}

/** Validate the closed HTTP(S) proxy protocols supported by provider fetches. */
export function validateProviderProxyEnv(env: NodeJS.ProcessEnv): void {
  const proxy = getProviderProxyOptions(env);
  assertSupportedProviderProxyUrl(proxy.httpProxy);
  assertSupportedProviderProxyUrl(proxy.httpsProxy);
}

function getDefaultPort(protocol: string): string {
  switch (protocol) {
    case "https:":
    case "wss:":
      return "443";
    case "http:":
    case "ws:":
      return "80";
    default:
      return "";
  }
}

function hostMatchesNoProxyEntry(hostname: string, ruleHost: string): boolean {
  if (!ruleHost) return false;
  const normalizedRule = ruleHost.replace(/^\*\./, ".").replace(/^\./, "").toLowerCase();
  const normalizedHost = hostname.toLowerCase();
  return normalizedHost === normalizedRule || normalizedHost.endsWith(`.${normalizedRule}`);
}

function getProxyUrlForTarget(targetUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const protocol = new URL(targetUrl).protocol;

  switch (protocol) {
    case "wss:":
      return env.WSS_PROXY || env.wss_proxy || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
    case "ws:":
      return env.WS_PROXY || env.ws_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    case "https:":
      return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
    case "http:":
      return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    default:
      return env.ALL_PROXY || env.all_proxy;
  }
}

export function shouldBypassProxy(targetUrl: string, env: NodeJS.ProcessEnv): boolean {
  const rawNoProxy = env.NO_PROXY || env.no_proxy;
  if (!rawNoProxy) return false;

  const url = new URL(targetUrl);
  const hostname = url.hostname.toLowerCase();
  const port = url.port || getDefaultPort(url.protocol);

  return rawNoProxy
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const [ruleHost, rulePort] = entry.split(":", 2);
      if (rulePort && rulePort !== port) return false;
      return hostMatchesNoProxyEntry(hostname, ruleHost);
    });
}

export function buildWebSocketOptions(
  wsUrl: string,
  env: NodeJS.ProcessEnv,
): WebSocketOptions | undefined {
  const proxyUrl = getProxyUrlForTarget(wsUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(wsUrl, env)) return undefined;

  return {
    agent: new HttpsProxyAgent(proxyUrl),
  };
}

// Resolve the effective proxy URL for a target, honoring NO_PROXY bypass.
// Returns undefined when the request should go direct (no proxy / bypassed),
// in which case there is no cached dispatcher to build or evict.
function resolveProxyUrl(targetUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const proxyUrl = getProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, env)) return undefined;
  return proxyUrl;
}

function createProxyDispatcher(
  proxyUrl: string,
  connectTimeoutMs: number,
  headersTimeoutMs: number,
  bodyTimeoutMs?: number,
): Dispatcher {
  return new ProxyAgent({
    uri: proxyUrl,
    connect: { timeout: connectTimeoutMs },
    requestTls: { timeout: connectTimeoutMs },
    headersTimeout: headersTimeoutMs,
    ...(bodyTimeoutMs === undefined ? {} : { bodyTimeout: bodyTimeoutMs }),
  });
}

function closeDispatcherBestEffort(dispatcher: Dispatcher): void {
  void Promise.resolve()
    .then(() => dispatcher.close())
    .catch(() => dispatcher.destroy?.(new Error("evicted")))
    .catch(() => {});
}

export function buildFetchDispatcher(
  targetUrl: string,
  env: NodeJS.ProcessEnv,
): Dispatcher | undefined {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  if (!proxyUrl) return undefined;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const timeoutMs = getFetchPreResponseTimeoutMs(env);
  // All three are pre-response and body-agnostic (see getFetchPreResponseTimeoutMs):
  // headersTimeout = headers-hang leg; requestTls.timeout = CONNECT-tunnel
  // establish leg; connect.timeout = socket to the proxy itself (defensive).
  const dispatcher = createProxyDispatcher(proxyUrl, timeoutMs, timeoutMs);
  fetchDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

function getIsolatedDispatcherCacheKey(
  targetUrl: string,
  isolationKey: string,
  env: NodeJS.ProcessEnv,
  headersTimeoutMs?: number,
  bodyTimeoutMs?: number,
): { cacheKey: string; proxyUrl?: string; connectTimeoutMs: number; headersTimeoutMs: number; bodyTimeoutMs?: number } {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  const routeKey = proxyUrl ? `proxy:${proxyUrl}` : `direct:${new URL(targetUrl).origin}`;
  const connectTimeoutMs = getFetchPreResponseTimeoutMs(env);
  const effectiveHeadersTimeoutMs = headersTimeoutMs ?? connectTimeoutMs;
  return {
    cacheKey: `${isolationKey}\0${routeKey}\0connect:${connectTimeoutMs}\0headers:${effectiveHeadersTimeoutMs}\0body:${bodyTimeoutMs ?? "default"}`,
    proxyUrl,
    connectTimeoutMs,
    headersTimeoutMs: effectiveHeadersTimeoutMs,
    bodyTimeoutMs,
  };
}

/**
 * Build a connection pool owned by one daemon traffic lane. Unlike the default
 * direct-fetch path, this always returns an explicit dispatcher so unrelated
 * daemon traffic cannot consume the lane's sockets or evict its pool.
 */
export function buildIsolatedFetchDispatcher(
  targetUrl: string,
  isolationKey: string,
  env: NodeJS.ProcessEnv,
  headersTimeoutMs?: number,
  bodyTimeoutMs?: number,
): Dispatcher {
  const {
    cacheKey,
    proxyUrl,
    connectTimeoutMs,
    headersTimeoutMs: effectiveHeadersTimeoutMs,
    bodyTimeoutMs: effectiveBodyTimeoutMs,
  } = getIsolatedDispatcherCacheKey(targetUrl, isolationKey, env, headersTimeoutMs, bodyTimeoutMs);
  const cached = isolatedFetchDispatcherCache.get(cacheKey);
  if (cached) return cached;

  const dispatcher = proxyUrl
    ? createProxyDispatcher(proxyUrl, connectTimeoutMs, effectiveHeadersTimeoutMs, effectiveBodyTimeoutMs)
    : new Agent({
        connect: { timeout: connectTimeoutMs },
        headersTimeout: effectiveHeadersTimeoutMs,
        ...(effectiveBodyTimeoutMs === undefined ? {} : { bodyTimeout: effectiveBodyTimeoutMs }),
      });
  isolatedFetchDispatcherCache.set(cacheKey, dispatcher);
  return dispatcher;
}

export function evictIsolatedFetchDispatcher(
  targetUrl: string,
  isolationKey: string,
  env: NodeJS.ProcessEnv,
  headersTimeoutMs?: number,
  bodyTimeoutMs?: number,
): boolean {
  const { cacheKey } = getIsolatedDispatcherCacheKey(
    targetUrl,
    isolationKey,
    env,
    headersTimeoutMs,
    bodyTimeoutMs,
  );
  const cached = isolatedFetchDispatcherCache.get(cacheKey);
  if (!cached) return false;

  isolatedFetchDispatcherCache.delete(cacheKey);
  closeDispatcherBestEffort(cached);
  return true;
}

// Evict the cached ProxyAgent for a target's proxy URL so the NEXT request
// rebuilds a fresh dispatcher with a fresh connection pool.
//
// CALL THIS ONLY on a TRANSPORT / pre-response failure — i.e. the outbound
// `fetch` REJECTED before producing any Response (connect/tunnel/TLS reset,
// headers timeout, socket close). A bounded pre-response timeout (above) turns a
// single hang into a bounded reject, but the cache is process-lifetime, so
// without eviction a poisoned dispatcher (e.g. a connection pool left with a
// half-open/stale socket) could be reused on every subsequent request. Eviction
// drops the possibly-poisoned dispatcher; the next call rebuilds.
//
// MUST NOT be called when the dispatcher produced a Response. A server 4xx/5xx
// means the transport worked and the dispatcher is healthy — evicting it there
// would amplify ordinary business/server errors into needless dispatcher churn.
// That asymmetry (reject → evict; any Response → keep) is the safety invariant:
// it makes eviction correct-by-construction regardless of whether the failure
// was a transient proxy degrade (eviction is then a harmless rebuild) or a truly
// poisoned pool (eviction is the fix).
//
// Returns true if a cached dispatcher was evicted, false otherwise.
export function evictFetchDispatcher(targetUrl: string, env: NodeJS.ProcessEnv): boolean {
  const proxyUrl = resolveProxyUrl(targetUrl, env);
  if (!proxyUrl) return false;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (!cached) return false;

  fetchDispatcherCache.delete(proxyUrl);
  // Best-effort close so the poisoned pool's sockets are released; never let a
  // close error mask the original transport failure being propagated.
  closeDispatcherBestEffort(cached);
  return true;
}
