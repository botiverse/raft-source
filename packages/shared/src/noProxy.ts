// NO_PROXY matching for outbound requests, one copy for the daemon, the agent
// CLI and Raft Computer (each keeps its own proxy-URL selection and dispatcher
// setup in its proxy.ts). Pure: no I/O, no imports, safe in every bundle.

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

/** True when `NO_PROXY` / `no_proxy` in `env` says `targetUrl` goes direct. */
export function shouldBypassProxy(
  targetUrl: string,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
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
