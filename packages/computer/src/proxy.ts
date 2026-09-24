// Proxy support for Raft Computer HTTP requests.
//
// This intentionally mirrors the daemon/agent CLI env contract for outbound
// server calls: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY with NO_PROXY bypass.
// Node/undici fetch does not reliably behave like curl here unless we pass an
// explicit dispatcher, so Computer login/attach must do it at the request seam.
import { fetch, ProxyAgent, type Dispatcher } from "undici";

const fetchDispatcherCache = new Map<string, Dispatcher>();
type UndiciRequestInit = NonNullable<Parameters<typeof fetch>[1]>;
type ProxyAwareRequestInit = UndiciRequestInit & { dispatcher?: Dispatcher };

function getDefaultPort(protocol: string): string {
  switch (protocol) {
    case "https:":
      return "443";
    case "http:":
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

export function buildFetchDispatcher(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const proxyUrl = getProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, env)) return undefined;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const dispatcher = new ProxyAgent(proxyUrl);
  fetchDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export function computerFetch(input: string, init: UndiciRequestInit = {}): ReturnType<typeof fetch> {
  const dispatcher = buildFetchDispatcher(input);
  const proxyInit: ProxyAwareRequestInit = dispatcher ? { ...init, dispatcher } : init;
  return fetch(input, proxyInit);
}
