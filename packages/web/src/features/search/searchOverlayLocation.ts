import type { Location } from "react-router-dom";

/** Desktop-width breakpoint shared with MainLayout's `isDesktop` (md). */
const OVERLAY_MIN_WIDTH_QUERY = "(min-width: 768px)";

/**
 * Where search is presented as the ⌘K overlay (floating over the current view)
 * instead of the full /search page. The overlay is for a quick lookup without
 * leaving where you are, so it needs room to float: desktop width (task #143,
 * WAWQAQ 2026-10-12: bring the desktop's Slack-style search back to the web).
 * The desktop app's window is never narrower than that (its minimum width,
 * 960px, is above this breakpoint), so it always gets the overlay through the
 * same test. Phones keep the full-screen page — a floating card there wastes the
 * width and the keyboard covers it. Re-read on every render, so crossing the
 * breakpoint with the overlay open falls back to the full page.
 */
export function isSearchOverlayEnabled(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(OVERLAY_MIN_WIDTH_QUERY).matches;
}

/**
 * The location the ⌘K search overlay floats over. The topbar / ⌘K navigate to
 * /search with `state.backgroundLocation = <current Location>`; this reads it back.
 *
 * Gated by isSearchOverlayEnabled: where the overlay is off (phone-width web),
 * every bg-aware branch in MainLayout (path checks, RightPanel, the content-URL
 * sync, the overlay render, Routes location) is dead, so the full-page behaviour
 * is unchanged even if a stray backgroundLocation appeared. Returns null there or
 * for malformed/absent state.
 *
 * Kept in its own tiny module (no app import graph) so it is cheaply unit-testable.
 */
export function getBackgroundLocation(location: Location): Location | null {
  if (!isSearchOverlayEnabled()) return null;
  const bg = (location.state as { backgroundLocation?: unknown } | null)?.backgroundLocation;
  if (bg && typeof bg === "object" && typeof (bg as Location).pathname === "string") {
    return bg as Location;
  }
  return null;
}

export type OverlayBackground = Pick<Location, "pathname" | "search">;

export function isSearchPath(pathname: string): boolean {
  return /^\/s\/[^/]+\/search(\/|$)/.test(pathname);
}

// Route-matching equivalence: React Router treats "/s/b/" as "/s/b". Compare and
// present normalized pathnames so a trailing slash cannot dodge the home check.
export function normalizeOverlayPathname(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

export function serverSlugFromSearchPath(pathname: string): string | null {
  const m = /^\/s\/([^/]+)\/search(\/|$)/.exec(pathname);
  return m ? m[1] : null;
}

// A background may only be presented under the /s/:slug/* branch of the SAME
// server as the /search route being overlaid (the nested Routes throw
// otherwise), and must never itself be a search path (that would float the
// overlay over a full-page search). Applies to the explicit backgroundLocation
// as well as to every synthesized candidate.
export function isValidOverlayBackground(candidate: OverlayBackground | null | undefined, slug: string): candidate is OverlayBackground {
  if (!candidate || typeof candidate.pathname !== "string") return false;
  const pathname = normalizeOverlayPathname(candidate.pathname);
  if (isSearchPath(pathname)) return false;
  return pathname === `/s/${slug}` || pathname.startsWith(`/s/${slug}/`);
}

// The last non-search location the desktop layout rendered. Remembered by
// MainLayout on every route change so a /search arrival that carries no
// explicit background (rail entry, "search this channel", deep link, history
// traversal) can still float over where the user was.
let lastNonSearchLocation: OverlayBackground | null = null;

export function rememberNonSearchLocation(location: OverlayBackground): void {
  if (isSearchPath(location.pathname)) return;
  lastNonSearchLocation = { pathname: location.pathname, search: location.search };
}

/** Test seam. */
export function resetRememberedNonSearchLocation(): void {
  lastNonSearchLocation = null;
}

function parseSearchFrom(state: unknown): OverlayBackground | null {
  const from = (state as { searchFrom?: unknown } | null)?.searchFrom;
  if (typeof from !== "string" || !from.startsWith("/")) return null;
  const q = from.indexOf("?");
  return { pathname: q === -1 ? from : from.slice(0, q), search: q === -1 ? "" : from.slice(q) };
}

/**
 * Explicit full-page presentation (task #102, Slack "Search for: … → results page").
 * The overlay's "view all results" row navigates to /search with
 * `?presentation=page` so the desktop renders the full three-column search (list +
 * context preview) instead of re-wrapping the route in the overlay. It is the ONLY
 * sanctioned exception to the task #96 overlay invariant.
 *
 * Why a URL param and not history state: the results page has several independent
 * URL writers that `navigate(..., { replace: true })` WITHOUT state — MainLayout's
 * searchContentStore → `?open=`/`?msg=` sync (i.e. clicking a hit to open the col-3
 * preview), the right-panel `?thread=` sync, the page's own param updates. State is
 * owned by whoever navigated last, so a state marker would be dropped by the very
 * first preview click and the overlay would re-wrap the page (review finding on
 * PR #8012). Every one of those writers rebuilds from the current URL
 * (`new URLSearchParams(window.location.search | prev)`), so a param survives all
 * of them by construction. Opt-in per hop: ⌘K / rail / deep links never add it, so
 * they are overlays again. Web ignores it (the resolver is already null there);
 * it is not a persisted search-state key and is never forwarded to the API.
 */
export const SEARCH_PRESENTATION_PARAM = "presentation";
export const SEARCH_PRESENTATION_PAGE = "page";

export function isFullPageSearchRequested(location: Pick<Location, "search">): boolean {
  return new URLSearchParams(location.search).get(SEARCH_PRESENTATION_PARAM) === SEARCH_PRESENTATION_PAGE;
}

/**
 * Navigation state for the overlay → full-page hop: a `searchFrom` (the overlay's
 * own searchFrom, else its background) so the page's Escape / back still return to
 * where the user was before opening search. The presentation itself rides in the
 * URL (see above), not here.
 */
export function fullPageSearchHopState(overlayState: unknown): Record<string, unknown> {
  const state = overlayState as { searchFrom?: unknown; backgroundLocation?: unknown } | null;
  const bg = state?.backgroundLocation as Partial<OverlayBackground> | undefined;
  const searchFrom = typeof state?.searchFrom === "string" && state.searchFrom.startsWith("/")
    ? state.searchFrom
    : bg && typeof bg.pathname === "string"
      ? `${bg.pathname}${typeof bg.search === "string" ? bg.search : ""}`
      : null;
  return searchFrom ? { searchFrom } : {};
}

/**
 * Where the overlay is on (desktop width, task #96), a /search location is
 * presented as the ⌘K overlay whenever there is something to float it over. The
 * server is taken from the /search path itself (the store's current slug can lag
 * during a switch). The explicit `backgroundLocation` wins when it belongs to that
 * server and is not a search path; otherwise one is synthesized: `state.searchFrom`
 * → the last remembered non-search location.
 * ANY final background that is the server home (from whichever source) carries
 * `suppressDefaultRouteRedirect` so DefaultRoute renders its empty state instead of
 * redirecting to the first channel (which would rewrite the /search URL and close the
 * overlay); `overlayCloseTarget` strips that state when the overlay closes so the
 * normal home behaviour resumes. Exception: a location whose URL carries the
 * explicit full-page marker (`isFullPageSearchRequested`) returns null so the full
 * results page renders (task #102). Where the overlay is off (phone width):
 * always null; with nothing to float over: null (the full page).
 */
export function resolveSearchOverlayBackground(location: Location): Location | null {
  if (!isSearchOverlayEnabled()) return null;
  const slug = serverSlugFromSearchPath(location.pathname);
  if (!slug) return null;
  // Task #102: an explicit full-page request (`?presentation=page`) renders the
  // real /search route.
  if (isFullPageSearchRequested(location)) return null;
  const explicit = getBackgroundLocation(location);
  const candidate =
    (isValidOverlayBackground(explicit, slug) ? explicit : null)
    ?? (() => { const f = parseSearchFrom(location.state); return isValidOverlayBackground(f, slug) ? f : null; })()
    ?? (isValidOverlayBackground(lastNonSearchLocation, slug) ? lastNonSearchLocation : null);
  // With nothing to float over (a shared /search link or a raft:// link opened
  // fresh, a reload with no history state) the overlay would hover over an
  // empty server home; the full results page is the better landing there.
  if (!candidate) return null;
  const target: OverlayBackground = { pathname: normalizeOverlayPathname(candidate.pathname), search: candidate.search };
  // Whatever the source, a server-home background must not run DefaultRoute's
  // redirect (it would rewrite the real /search URL and close the overlay):
  // a remembered "/s/<slug>" or an explicit/searchFrom home.
  const isServerHome = target.pathname === `/s/${slug}`;
  return {
    pathname: target.pathname,
    search: target.search,
    hash: "",
    state: isServerHome ? { suppressDefaultRouteRedirect: true } : null,
    key: isServerHome ? "desktop-search-bg-home" : "desktop-search-bg",
  } as Location;
}

/** Where closing the overlay navigates: the background without overlay-only state. */
export function overlayCloseTarget(background: Location): OverlayBackground {
  return { pathname: background.pathname, search: background.search };
}

/**
 * Navigation state for entering /search on the desktop: carries the current
 * location as the overlay background (and `searchFrom` for the rail/back
 * behaviour). Where the overlay is off it carries only `searchFrom`, preserving
 * full-page semantics.
 */
export function searchEntryState(current: OverlayBackground, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const searchFrom = `${current.pathname}${current.search}`;
  if (!isSearchOverlayEnabled() || isSearchPath(current.pathname)) return { ...extra, searchFrom };
  return { ...extra, searchFrom, backgroundLocation: { pathname: current.pathname, search: current.search } };
}
