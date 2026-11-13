// The in-app routes Raft Desktop may be sent to from outside: a raft:// deep
// link, a notification click, the page reopened after an update restart. One
// list for the web ("Open in Raft Desktop" builds links for these) and the
// desktop main process (it validates every outside route against it before
// the renderer sees it), so the two can no longer drift.

/**
 * Route prefixes Raft Desktop accepts from outside. A prefix ending in "/"
 * matches any path under it; one without matches itself and its sub-paths
 * ("/servers", "/servers/…"), never a longer name ("/serversX").
 *
 * "/artifacts/" is the canonical Artifact link (`/artifacts/<id>`, `/v/<n>`),
 * the one address of an Artifact that is not under a server. A Raft Desktop
 * from before it was listed refuses the route and only comes to the front.
 */
export const DESKTOP_DEEP_LINK_ROUTE_PREFIXES: readonly string[] = ["/s/", "/servers", "/artifacts/"];

/** A pathname (no query or hash) under one of DESKTOP_DEEP_LINK_ROUTE_PREFIXES. */
export function isDesktopDeepLinkPathname(pathname: string): boolean {
  return DESKTOP_DEEP_LINK_ROUTE_PREFIXES.some((prefix) => (prefix.endsWith("/")
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`)));
}

const MAX_ROUTE_LENGTH = 2048;
const PARSE_BASE = "https://raft.invalid";

/**
 * The in-app route (pathname + search + hash, dot segments resolved) of `path`
 * when it is "/" or under an accepted prefix, else null. Anything that is not
 * a plain absolute path ("//host", a scheme, a backslash) is rejected.
 */
export function desktopRouteFromPath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  if (path.length > MAX_ROUTE_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(path, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  const { pathname, search, hash } = url;
  if (pathname !== "/" && !isDesktopDeepLinkPathname(pathname)) return null;
  return `${pathname}${search}${hash}`;
}

/** The in-app route a `raft://<path>` link opens (`raft:///s/x` and `raft://s/x` alike), or null. */
export function desktopRouteFromDeepLink(uri: string): string | null {
  if (typeof uri !== "string" || !uri.startsWith("raft://")) return null;
  const rest = uri.slice("raft://".length);
  return desktopRouteFromPath(rest.startsWith("/") ? rest : `/${rest}`);
}
