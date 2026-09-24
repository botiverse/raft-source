import { fetch as undiciFetch, type Dispatcher } from "undici";
import {
  buildFetchDispatcher,
  buildIsolatedFetchDispatcher,
  evictFetchDispatcher,
  evictIsolatedFetchDispatcher,
  validateProviderProxyEnv,
} from "./proxy.js";

export type DaemonFetchInput = RequestInfo | URL;
export type DaemonRequestInit = RequestInit & { duplex?: "half" };
export type ProxyAwareRequestInit = DaemonRequestInit & { dispatcher?: Dispatcher };
export type DaemonFetchOptions = {
  isolationKey?: string;
  /**
   * Optional wait-for-headers override for an isolated lane. Connection and
   * tunnel establishment retain the daemon's ordinary short timeout.
   */
  headersTimeoutMs?: number;
  /** Optional body-idle timeout override for an isolated lane. */
  bodyTimeoutMs?: number;
};

type DaemonFetchFn = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) => ReturnType<typeof undiciFetch>;

let daemonFetchImpl: DaemonFetchFn = undiciFetch;

/** Test-only: intercept daemon outbound fetch without using globalThis.fetch. */
export function setDaemonFetchImplForTests(fn: DaemonFetchFn | undefined): void {
  daemonFetchImpl = fn ?? undiciFetch;
}

/** Test-only: mock both globalThis.fetch and daemonFetch's injectable impl. */
export function installDaemonFetchMockForTests(fn: typeof fetch): () => void {
  const previousGlobal = globalThis.fetch;
  const previousImpl = daemonFetchImpl;
  globalThis.fetch = fn;
  daemonFetchImpl = fn as never;
  return () => {
    globalThis.fetch = previousGlobal;
    daemonFetchImpl = previousImpl;
  };
}

const PROVIDER_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SLOCK_DAEMON_FETCH_PRE_RESPONSE_TIMEOUT_MS",
] as const;

export type ProviderHttpClient = {
  fetch: typeof globalThis.fetch;
  dispose(): void;
};

function daemonFetchTargetUrl(input: DaemonFetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isRequest(input: DaemonFetchInput): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
}

/** undici 7 cannot parse a Node 26 native Request ("Failed to parse URL from [object Request]"). */
function undiciFetchArgs(
  input: DaemonFetchInput,
  init: ProxyAwareRequestInit,
): [string, ProxyAwareRequestInit] {
  if (!isRequest(input)) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : String(input);
    return [url, init];
  }
  const { dispatcher, ...requestInit } = init;
  const spec = new Request(input, requestInit as RequestInit);
  const body = spec.body;
  const merged: ProxyAwareRequestInit = {
    method: spec.method,
    headers: spec.headers,
    body: body ?? undefined,
    signal: spec.signal,
    redirect: spec.redirect,
    integrity: spec.integrity,
    keepalive: spec.keepalive,
    referrer: spec.referrer,
    dispatcher,
    duplex: requestInit.duplex,
  };
  if (body && typeof ReadableStream !== "undefined" && body instanceof ReadableStream && !merged.duplex) {
    merged.duplex = "half";
  }
  return [spec.url, merged];
}

function snapshotProviderProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const snapshot: NodeJS.ProcessEnv = {};
  for (const key of PROVIDER_PROXY_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

// Centralize daemon outbound HTTP so every server/worker path honors the same
// HTTPS_PROXY / HTTP_PROXY / NO_PROXY rules as the WebSocket connection.
export function withDaemonFetchProxy(
  input: DaemonFetchInput,
  init: DaemonRequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): ProxyAwareRequestInit {
  const dispatcher = buildFetchDispatcher(daemonFetchTargetUrl(input), env);
  return dispatcher ? { ...init, dispatcher } : init;
}

export async function daemonFetch(
  input: DaemonFetchInput,
  init?: DaemonRequestInit,
  env: NodeJS.ProcessEnv = process.env,
  options: DaemonFetchOptions = {},
): Promise<Response> {
  const targetUrl = daemonFetchTargetUrl(input);
  const fetchInit = options.isolationKey
    ? {
        ...init,
        dispatcher: buildIsolatedFetchDispatcher(
          targetUrl,
          options.isolationKey,
          env,
          options.headersTimeoutMs,
          options.bodyTimeoutMs,
        ),
      }
    : withDaemonFetchProxy(input, init, env);
  try {
    // A resolved Response (ANY status, including 4xx/5xx) means the dispatcher
    // worked at the transport layer — keep it cached.
    // Node 26 ships undici 8 on globalThis.fetch. Mixing that fetch with this
    // package's undici 7 dispatcher drops Content-Encoding and leaves gzip
    // bytes (Maria empty/INVALID_JSON). Always call the same undici as the
    // dispatcher.
    const [url, undiciInit] = undiciFetchArgs(input, fetchInit);
    return await daemonFetchImpl(
      url,
      undiciInit as Parameters<typeof undiciFetch>[1],
    ) as unknown as Response;
  } catch (err) {
    // `fetch` rejected → transport / pre-response failure (no Response produced):
    // connect/tunnel/TLS reset, headers timeout, socket close. Evict the cached
    // dispatcher so the next request rebuilds a fresh pool instead of reusing
    // a possibly-poisoned one. This branch is ONLY reachable when no Response
    // was obtained; isolated lanes evict only their own pool.
    if (options.isolationKey) {
      evictIsolatedFetchDispatcher(
        targetUrl,
        options.isolationKey,
        env,
        options.headersTimeoutMs,
        options.bodyTimeoutMs,
      );
    } else {
      evictFetchDispatcher(targetUrl, env);
    }
    throw err;
  }
}

/**
 * Build a fetch implementation owned by one provider session. Its proxy route
 * is snapshotted at session creation, it never mutates undici's process-global
 * dispatcher, and dispose releases every target pool opened by this session.
 */
export function createProviderHttpClient(
  env: NodeJS.ProcessEnv,
  isolationKey: string,
): ProviderHttpClient {
  const proxyEnv = snapshotProviderProxyEnv(env);
  validateProviderProxyEnv(proxyEnv);
  const targetUrls = new Set<string>();
  let disposed = false;

  const providerFetch = (async (input: DaemonFetchInput, init?: RequestInit) => {
    if (disposed) throw new Error("Pi provider HTTP client is disposed");
    const targetUrl = daemonFetchTargetUrl(input);
    targetUrls.add(targetUrl);
    return daemonFetch(input, init as DaemonRequestInit | undefined, proxyEnv, {
      isolationKey,
      // Provider responses can be long-lived streams. Pi owns request and idle
      // cancellation; undici must not impose its default body-idle deadline.
      bodyTimeoutMs: 0,
    });
  }) as typeof globalThis.fetch;

  return {
    fetch: providerFetch,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const targetUrl of targetUrls) {
        evictIsolatedFetchDispatcher(targetUrl, isolationKey, proxyEnv, undefined, 0);
      }
      targetUrls.clear();
    },
  };
}
