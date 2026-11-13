// Which of the check tab's requests go (isolation condition 2, #proj-workspace:#130): the tab
// opens the lease's ticket URL, once, and is shot there. Every request is intercepted
// (browser.ts) and asked here:
//
// - a subresource, or a subframe's navigation: goes (the content origin's CSP decides what
//   the page may load; the tab never leaves the entry page for it);
// - a top-level navigation off the ticket URL's origin: refused, and reported as blocked;
// - the entry: the first top-level navigation, to the ticket URL itself, and the redirects
//   that follow it on the same origin: go;
// - any other top-level navigation, on the same origin too (a script's `location = …`, a
//   reload, another page of the set): refused and reported. Only the entry page is shot.

/** What the guard is asked about a request. */
export interface GuardedRequest {
  url: string;
  /** A navigation request (a document), not a subresource. */
  isNavigation: boolean;
  /** The tab's own (top-level) frame. */
  isMainFrame: boolean;
  /** For a redirect hop, the URL the chain started from; else null. */
  redirectedFrom: string | null;
}

export type NavigationDecision = { allow: true } | { allow: false; reason: "off_origin" | "after_entry" };

const originOf = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null);

/** A guard for one check's tab, opening `ticketUrl`; it remembers whether the entry was asked for. */
export function createNavigationGuard(ticketUrl: string): (request: GuardedRequest) => NavigationDecision {
  const entryOrigin = originOf(ticketUrl);
  let entryAsked = false;
  return (request) => {
    if (!request.isNavigation || !request.isMainFrame) return { allow: true };
    const origin = originOf(request.url);
    if (entryOrigin === null || entryOrigin === "null" || origin !== entryOrigin) return { allow: false, reason: "off_origin" };
    if (request.redirectedFrom !== null) return request.redirectedFrom === ticketUrl ? { allow: true } : { allow: false, reason: "after_entry" };
    if (!entryAsked && request.url === ticketUrl) {
      entryAsked = true;
      return { allow: true };
    }
    return { allow: false, reason: "after_entry" };
  };
}
