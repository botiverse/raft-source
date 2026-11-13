import { API_ROUTE_WORDS } from "./apiRouteWords";

/**
 * An API request URL as its route template, e.g. `/messages/channel/c1?limit=50`
 * -> `/api/messages/channel/:id`: the query, the fragment and every path
 * segment that is not a known route word (apiRouteWords.ts) are dropped or
 * replaced, so ids, slugs and names never reach a trace attribute. An absolute
 * URL keeps its path after `/api` only; a URL that is not an API path gives
 * `:other`. Never throws.
 */
export function apiRouteTemplate(url: string | undefined): string {
  try {
    if (!url) return ":other";
    let path = url.split(/[?#]/, 1)[0] ?? "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
      const at = path.indexOf("/api/");
      if (at < 0) return ":other";
      path = path.slice(at + "/api".length);
    } else if (path.startsWith("/api/")) {
      path = path.slice("/api".length);
    }
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return ":other";
    const template = segments.map((segment) => (API_ROUTE_WORDS.has(segment) ? segment : ":id"));
    return `/api/${template.join("/")}`;
  } catch {
    return ":other";
  }
}
