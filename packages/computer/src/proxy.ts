// Proxy support for Raft Computer HTTP requests.
//
// This intentionally mirrors the daemon/agent CLI env contract for outbound
// server calls: HTTPS_PROXY / HTTP_PROXY / ALL_PROXY with NO_PROXY bypass.
// Node/undici fetch does not reliably behave like curl here unless we pass an
// explicit dispatcher, so Computer login/attach must do it at the request seam.
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { shouldBypassProxy } from "@botiverse/raft-shared/src/noProxy";

const fetchDispatcherCache = new Map<string, Dispatcher>();
type UndiciRequestInit = NonNullable<Parameters<typeof fetch>[1]>;
type ProxyAwareRequestInit = UndiciRequestInit & { dispatcher?: Dispatcher };

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

export function buildFetchDispatcher(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Dispatcher | undefined {
  const proxyUrl = getProxyUrlForTarget(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, env)) return undefined;

  const cached = fetchDispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const dispatcher = new ProxyAgent({
    uri: proxyUrl,
    // undici 8 forwards plain-http requests to the proxy without CONNECT
    // unless asked; keep 7.x's tunnel-everything behavior (as the daemon does).
    proxyTunnel: true,
  });
  fetchDispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export function computerFetch(input: string, init: UndiciRequestInit = {}): ReturnType<typeof fetch> {
  const dispatcher = buildFetchDispatcher(input);
  const proxyInit: ProxyAwareRequestInit = dispatcher ? { ...init, dispatcher } : init;
  return fetch(input, proxyInit);
}
