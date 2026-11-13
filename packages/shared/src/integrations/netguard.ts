// Is an app URL somewhere a hosted runtime may call? Apps are registered on
// Raft by third parties, and the SDK runs on the hosted runtime's machines, so
// a registered app must not be able to point the runtime at its own network.
// Hostname rules only (a runtime-neutral SDK cannot resolve DNS): https, no
// credentials in the URL, no IP literal, no single-label or private-suffix
// host, no cloud metadata host. The WHATWG URL parser already rewrites
// numeric hosts (`2130706433`, `0x7f.1`) to dotted IPv4, which is refused.

export type AppUrlRefusal =
  | "invalid_url"
  | "not_https"
  | "credentials_in_url"
  | "ip_literal"
  | "private_host"
  | "metadata_host";

const PRIVATE_HOST_SUFFIXES = [
  ".home",
  ".home.arpa",
  ".internal",
  ".intranet",
  ".invalid",
  ".lan",
  ".local",
  ".localdomain",
  ".localhost",
  ".corp",
  ".svc", // Kubernetes in-cluster services (`kubernetes.default.svc`)
  ".test",
];

/** Cloud instance-metadata hosts that are not already caught by a private suffix. */
const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.goog",
  "metadata.azure.com",
  "instance-data",
  "metadata.tencentyun.com",
  "metadata.platformequinix.com",
  "metadata.packet.net",
]);

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Why `value` may not be called from a hosted runtime, or null when it may. */
export function appUrlRefusal(value: string | URL): AppUrlRefusal | null {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password) return "credentials_in_url";
  const host = normalizedHostname(url.hostname);
  if (!host) return "invalid_url";
  if (isIpLiteral(host)) return "ip_literal";
  if (METADATA_HOSTS.has(host)) return "metadata_host";
  if (host === "localhost" || !host.includes(".")) return "private_host";
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "private_host";
  return null;
}
