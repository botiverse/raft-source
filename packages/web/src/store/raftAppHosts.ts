import { useMemo, useSyncExternalStore } from "react";

/**
 * Raft's own app hosts as this deployment's server knows them: the server's
 * `appHosts()` (packages/server/src/platform/links.ts: the canonical host,
 * APP_URL's, Raft's earlier hosts and APP_PERMALINK_HOSTS), the hosts on
 * which a link names something of Raft's. Its link-card reads leave Raft's
 * own objects' links out on them (shared appLinkReadUrls); here they also
 * decide which links are Raft message permalinks (raftPermalinkHostnames)
 * and which hosts an attachment preview may not send someone to. They are
 * deploy config, so the page learns them from the server's per-deploy client
 * config (GET /api/public/client-config, read once per page load, signed in
 * or not: store/clientConfig.ts). Null until that answer arrives, or when it
 * fails or carries none: readers fall back to what they knew without it.
 *
 * Hostnames only (`URL.hostname`: lowercase, punycode, no port), deduped, in
 * the server's order. Kept for the page, not per server or person: every
 * server on a deployment has the same hosts.
 */
let hosts: readonly string[] | null = null;
const listeners = new Set<() => void>();

/** A hostname as `URL.hostname` spells it, else null (a port, a path, a scheme, upper case, an IDN not in punycode). */
function hostnameOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return new URL(`https://${value}/`).hostname === value ? value : null;
  } catch {
    return null;
  }
}

/** The hosts the server sent (null until then). */
export function readRaftAppHosts(): readonly string[] | null {
  return hosts;
}

/**
 * Takes the server's `appHosts` from the client config's answer. Anything
 * not a hostname is dropped; no list, or none left, keeps what the page
 * has. The same list again changes nothing, so the message rows reading it
 * don't render again on every re-read.
 */
export function setRaftAppHosts(value: unknown): void {
  if (!Array.isArray(value)) return;
  const next = [...new Set(value.map(hostnameOf).filter((host): host is string => host !== null))];
  if (next.length === 0) return;
  if (hosts && hosts.length === next.length && hosts.every((host, index) => host === next[index])) return;
  hosts = Object.freeze(next);
  for (const listener of listeners) listener();
}

export function subscribeRaftAppHosts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** readRaftAppHosts for a component: the same array until the list changes; it renders again when the list arrives. */
export function useRaftAppHosts(): readonly string[] | null {
  return useSyncExternalStore(subscribeRaftAppHosts, readRaftAppHosts, readRaftAppHosts);
}

export function resetRaftAppHostsForTests(): void {
  hosts = null;
  for (const listener of listeners) listener();
}

function pageHostname(): string | undefined {
  return typeof window !== "undefined" ? window.location.hostname : undefined;
}

/**
 * The hostnames a Raft message permalink is recognised on here, for the
 * shared parseRaftPermalink (which adds its fixed defaults and compares exact
 * hostnames): the page's own and the server's list (`configured`), deduped.
 * Until the list arrives: the page's own.
 */
export function raftPermalinkHostnames(configured: readonly string[] | null = readRaftAppHosts(), page: string | undefined = pageHostname()): string[] {
  const hostnames = page ? [page] : [];
  for (const host of configured ?? []) if (!hostnames.includes(host)) hostnames.push(host);
  return hostnames;
}

/** raftPermalinkHostnames for a component: the same array until the server's list arrives, then a new one, so links already on screen are read again. */
export function useRaftPermalinkHostnames(): readonly string[] {
  const configured = useRaftAppHosts();
  return useMemo(() => raftPermalinkHostnames(configured), [configured]);
}
