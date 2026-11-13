// Proxy support for CLI HTTP client.
// Ported from packages/daemon/src/proxy.ts — only the fetch dispatcher
// parts; WebSocket proxy is not needed in the CLI.

import type { Dispatcher } from "undici";
import { shouldBypassProxy } from "@botiverse/raft-shared/src/noProxy";

// undici is loaded on first use, not at startup: a managed agent's `raft` call
// talks to the loopback agent proxy through Node's built-in fetch and never
// needs it, and loading it costs every call ~11 MiB and ~0.15 s of CPU.
let undiciModule: Promise<typeof import("undici")> | undefined;
function loadUndici(): Promise<typeof import("undici")> {
  return (undiciModule ??= import("undici"));
}

/** undici's `fetch`, loading undici on the first call. */
export const undiciFetch: typeof import("undici").fetch = async (...args) => (await loadUndici()).fetch(...args);

const fetchDispatcherCache = new Map<string, Dispatcher>();

export type FetchTransportCauseClass = "dns" | "connect" | "tls" | "timeout" | "proxy" | "unknown";

export interface FetchTransportDiagnostics {
  url: string;
  causeClass: FetchTransportCauseClass;
  causeCode?: string;
  proxyUsed: boolean;
}

type ProxyAwareRequestInit = RequestInit & { dispatcher?: Dispatcher; duplex?: "half" };

// Keep fetch and its dispatcher on the same undici version. Node 26's built-in
// fetch (undici 8) drops response headers when paired with an undici 7 ProxyAgent,
// leaving gzip compressed and hiding the service callback's Set-Cookie headers.
const packageFetch: typeof fetch = (input, init) => undiciFetch(
  input as Parameters<typeof undiciFetch>[0],
  init as Parameters<typeof undiciFetch>[1],
) as unknown as Promise<Response>;
let canonicalFetchImpl = packageFetch;

/** Test-only transport seam; does not replace the process-global fetch. */
export function setCanonicalFetchImplForTests(impl: typeof fetch): typeof fetch {
  const previous = canonicalFetchImpl;
  canonicalFetchImpl = impl;
  return previous;
}

// A native Request belongs to Node's fetch implementation, so undici cannot
// consume it directly. Apply overrides with the native constructor, then pass
// the URL and standard request fields across the implementation boundary.
function packageFetchArgs(input: string | URL | Request, init: ProxyAwareRequestInit): [string | URL, ProxyAwareRequestInit] {
  if (typeof input === "string" || input instanceof URL) return [input, init];
  const { dispatcher, ...requestInit } = init;
  const request = new Request(input, requestInit);
  return [request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: request.redirect,
    credentials: request.credentials,
    cache: request.cache,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    ...(request.body ? { duplex: "half" as const } : {}),
    dispatcher,
  }];
}

export class CanonicalFetchTransportError extends Error {
  readonly diagnostics: FetchTransportDiagnostics;

  constructor(input: {
    url: string;
    cause: unknown;
    proxyUsed: boolean;
  }) {
    const diagnostics = classifyFetchTransportFailure(input);
    const causeSuffix = diagnostics.causeCode ? `/${diagnostics.causeCode}` : "";
    super(`fetch failed for ${diagnostics.url}: ${diagnostics.causeClass}${causeSuffix}`);
    this.name = "CanonicalFetchTransportError";
    this.cause = input.cause;
    this.diagnostics = diagnostics;
  }
}

function getProxyUrlForTarget(targetUrl: string, env: NodeJS.ProcessEnv): string | undefined {
  const protocol = new URL(targetUrl).protocol;

  switch (protocol) {
    case "https:":
      return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy;
    case "http:":
      return env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    default:
      return env.ALL_PROXY || env.all_proxy;
  }
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string" || input instanceof URL) return input.toString();
  return input.url;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<object>();
  let current = error;
  while (chain.length < 8) {
    chain.push(current);
    if (typeof current !== "object" || !current || seen.has(current) || !("cause" in current)) break;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function nestedErrorCode(error: unknown): string {
  for (const item of errorChain(error)) {
    if (typeof item !== "object" || !item || !("code" in item)) continue;
    const code = (item as { code?: unknown }).code;
    if (typeof code === "string") return code.toUpperCase().slice(0, 80);
  }
  return "";
}

function nestedErrorMessage(error: unknown): string {
  return errorChain(error)
    .map((item) => item instanceof Error ? `${item.name} ${item.message}` : String(item ?? ""))
    .join(" ")
    .slice(0, 2_048)
    .toLowerCase();
}

/** Any failed name lookup is DNS, whatever code the resolver chose (some return EBUSY or EAI_FAIL, not ENOTFOUND). */
function isNameLookupFailure(error: unknown): boolean {
  return errorChain(error).some((item) =>
    typeof item === "object" && item !== null && (item as { syscall?: unknown }).syscall === "getaddrinfo");
}

function classifyFetchTransportFailure(input: {
  url: string;
  cause: unknown;
  proxyUsed: boolean;
}): FetchTransportDiagnostics {
  const code = nestedErrorCode(input.cause);
  const message = nestedErrorMessage(input.cause);
  let causeClass: FetchTransportCauseClass = "unknown";

  if (
    code === "ETIMEDOUT"
    || code.includes("TIMEOUT")
    || /\b(?:abort|timed? out|timeout)\b/.test(message)
  ) {
    causeClass = "timeout";
  } else if (
    code.includes("TLS")
    || code.includes("CERT")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || /\b(?:tls|certificate|ssl)\b/.test(message)
  ) {
    causeClass = "tls";
  } else if (
    code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || isNameLookupFailure(input.cause)
    || /\bdns\b/.test(message)
  ) {
    // Before the proxy check: a lookup message names the host, and a host such
    // as `proxy-only.invalid` must not read as a proxy failure.
    causeClass = "dns";
  } else if (code.includes("PROXY") || /\bproxy\b/.test(message)) {
    causeClass = "proxy";
  } else if (
    code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EHOSTUNREACH"
    || code === "ENETUNREACH"
    || code === "EPIPE"
    || code.startsWith("UND_ERR_CONNECT")
    || /\b(?:connect|connection|socket)\b/.test(message)
  ) {
    causeClass = input.proxyUsed ? "proxy" : "connect";
  }

  return {
    url: credentialFreeDiagnosticUrl(input.url),
    causeClass,
    causeCode: code || undefined,
    proxyUsed: input.proxyUsed,
  };
}

export function credentialFreeDiagnosticUrl(value: string | URL): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  // Query values can carry one-time handoff codes. Keep the actual endpoint
  // and query keys while withholding values from agent-visible diagnostics.
  for (const key of Array.from(url.searchParams.keys())) {
    url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}

export async function buildFetchDispatcher(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Dispatcher | undefined> {
  const proxyUrl = getProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, env)) return undefined;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const { ProxyAgent } = await loadUndici();
  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    // undici 8 forwards plain-http requests to the proxy without CONNECT
    // unless asked; keep 7.x's tunnel-everything behavior (as the daemon does).
    proxyTunnel: true,
  });
  fetchDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

/**
 * Send a request through a package-undici `dispatcher` on the package undici's
 * fetch. That dispatcher must not ride Node's built-in fetch (another undici
 * major): the pair fails before connecting (UND_ERR_INVALID_ARG "invalid
 * onRequestStart method") or drops response headers. The request is built as a
 * native Request first, so FormData and stream bodies cross the implementation
 * boundary as a byte stream with their content type.
 */
export function fetchWithDispatcher(
  url: string | URL,
  init: ProxyAwareRequestInit & { dispatcher: Dispatcher },
): Promise<Response> {
  const { dispatcher, ...requestInit } = init;
  const [packageUrl, packageInit] = packageFetchArgs(new Request(url, requestInit as RequestInit), { dispatcher });
  return canonicalFetchImpl(packageUrl, packageInit);
}

/**
 * Node's built-in fetch, except that a target the proxy environment routes
 * through a proxy goes there via fetchWithDispatcher. For requests that must
 * honor HTTPS_PROXY but otherwise keep the built-in fetch.
 */
export async function proxyAwareFetch(
  url: string | URL,
  init: ProxyAwareRequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const dispatcher = await buildFetchDispatcher(url.toString(), env);
  return dispatcher ? fetchWithDispatcher(url, { ...init, dispatcher }) : fetch(url, init);
}

/** Host and nested error code of a failed fetch, without the URL's path or query. */
export function describeFetchFailure(url: string | URL, cause: unknown, proxyUsed: boolean): string {
  const diagnostics = classifyFetchTransportFailure({ url: url.toString(), cause, proxyUsed });
  const code = diagnostics.causeCode ? `/${diagnostics.causeCode}` : "";
  return `${new URL(url).hostname} ${proxyUsed ? "via proxy" : "direct"}: ${diagnostics.causeClass}${code}`;
}

export async function fetchWithCanonicalProxy(
  input: string | URL | Request,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const targetUrl = requestUrl(input);
  const proxyConfigured = Boolean(getProxyUrlForTarget(targetUrl, env)) && !shouldBypassProxy(targetUrl, env);
  let dispatcher: Dispatcher | undefined;
  try {
    dispatcher = await buildFetchDispatcher(targetUrl, env);
  } catch (cause) {
    throw new CanonicalFetchTransportError({ url: targetUrl, cause, proxyUsed: proxyConfigured });
  }

  const proxyAwareInit: ProxyAwareRequestInit = { ...init };
  if (dispatcher) proxyAwareInit.dispatcher = dispatcher;
  try {
    const [url, packageInit] = packageFetchArgs(input, proxyAwareInit);
    return await canonicalFetchImpl(url, packageInit);
  } catch (cause) {
    throw new CanonicalFetchTransportError({ url: targetUrl, cause, proxyUsed: Boolean(dispatcher) });
  }
}
