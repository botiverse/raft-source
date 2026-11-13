import assert from "node:assert/strict";
import type { Location } from "react-router-dom";
import {
  fullPageSearchHopState,
  getBackgroundLocation,
  isFullPageSearchRequested,
  rememberNonSearchLocation,
  resetRememberedNonSearchLocation,
  overlayCloseTarget,
  resolveSearchOverlayBackground,
  searchEntryState,
} from "../searchOverlayLocation";

function loc(state: unknown): Location {
  return { pathname: "/s/x/search", search: "", hash: "", state, key: "k" };
}

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  resetRememberedNonSearchLocation();
});
function atWidth(px: number) {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query) && px >= 768,
    media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
// Desktop width: the web at ≥768px and the desktop app, whose window is never narrower.
function desktop() { atWidth(1280); }
function phone() { atWidth(390); }

// The gate: the search overlay only activates at desktop width. Narrower (or
// with no matchMedia) getBackgroundLocation is always null and every bg-aware
// branch in MainLayout (path checks, RightPanel, content-URL sync, the overlay
// render, Routes location) is dead — the full-page search is unchanged.
test("getBackgroundLocation returns null at phone width even when a backgroundLocation is present in state", () => {
  assert.equal(getBackgroundLocation(loc({ backgroundLocation: { pathname: "/s/x/channel/c" } })), null);
  phone();
  assert.equal(getBackgroundLocation(loc({ backgroundLocation: { pathname: "/s/x/channel/c" } })), null);
});

test("getBackgroundLocation returns the background location at desktop width", () => {
  desktop();
  const bg = getBackgroundLocation(loc({ backgroundLocation: { pathname: "/s/x/channel/c", search: "?x=1" } }));
  assert.equal(bg?.pathname, "/s/x/channel/c");
  assert.equal(bg?.search, "?x=1");
});

test("getBackgroundLocation returns null for absent or malformed state (desktop width)", () => {
  desktop();
  assert.equal(getBackgroundLocation(loc(null)), null);
  assert.equal(getBackgroundLocation(loc({ searchFrom: "/x" })), null, "only searchFrom → no overlay");
  assert.equal(getBackgroundLocation(loc({ backgroundLocation: "not-an-object" })), null);
  assert.equal(getBackgroundLocation(loc({ backgroundLocation: { search: "?q=1" } })), null, "no pathname → invalid");
});

// Task #96: at desktop width, /search presents as the overlay whenever there is
// something to float it over. Entries that never set backgroundLocation (rail tab,
// nav.toSearch callers, history) get a synthesized background from searchFrom or
// the last remembered place; with nothing at all it is the full page.
// Every candidate must belong to the SAME server as the /search path (nested Routes
// throw otherwise) and must not be a search path itself.
function locB(state: unknown): Location {
  return { pathname: "/s/b/search", search: "", hash: "", state, key: "k" };
}

test("resolveSearchOverlayBackground: explicit same-server backgroundLocation wins (desktop width)", () => {
  desktop();
  rememberNonSearchLocation({ pathname: "/s/b/channel/other", search: "" });
  const bg = resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b/channel/c", search: "?a=1" }, searchFrom: "/s/b/dm/d" }));
  assert.equal(bg?.pathname, "/s/b/channel/c");
  assert.equal(bg?.search, "?a=1");
});

test("resolveSearchOverlayBackground: explicit backgroundLocation from another server or a search path is rejected, not presented", () => {
  desktop();
  // other server → would make /s/b's nested Routes throw
  assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/a/channel/old", search: "" } })), null);
  // a search path → would float the overlay over a full-page search
  assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b/search", search: "?q=1" } })), null);
  // a valid remembered place still takes over from a rejected explicit one
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/a/channel/old", search: "" } }))?.pathname, "/s/b/channel/c");
});

test("resolveSearchOverlayBackground: synthesis order — searchFrom, then last non-search location, else the full page; all server-scoped", () => {
  desktop();
  assert.deepEqual(
    (({ pathname, search }) => ({ pathname, search }))(resolveSearchOverlayBackground(locB({ searchFrom: "/s/b/channel/c?thread=t" }))!),
    { pathname: "/s/b/channel/c", search: "?thread=t" },
  );
  // searchFrom on another server or itself a search path is skipped
  rememberNonSearchLocation({ pathname: "/s/b/dm/d", search: "" });
  assert.equal(resolveSearchOverlayBackground(locB({ searchFrom: "/s/a/channel/c" }))?.pathname, "/s/b/dm/d");
  assert.equal(resolveSearchOverlayBackground(locB({ searchFrom: "/s/b/search?q=a" }))?.pathname, "/s/b/dm/d");
  // remembered location from another server (the reviewer's reproduction) must NOT leak under /s/b
  resetRememberedNonSearchLocation();
  rememberNonSearchLocation({ pathname: "/s/a/channel/old", search: "" });
  assert.equal(resolveSearchOverlayBackground(locB(null)), null, "nothing of this server to float over: the full page");
  // search paths are never remembered
  resetRememberedNonSearchLocation();
  rememberNonSearchLocation({ pathname: "/s/b/search", search: "?q=1" });
  assert.equal(resolveSearchOverlayBackground(locB(null)), null);
});

test("resolveSearchOverlayBackground: null off /search (any state) and always null at phone width", () => {
  desktop();
  const channel: Location = { pathname: "/s/b/channel/c", search: "", hash: "", state: null, key: "k" };
  assert.equal(resolveSearchOverlayBackground(channel), null);
  phone();
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  assert.equal(resolveSearchOverlayBackground(locB({ searchFrom: "/s/b/channel/c" })), null, "phones keep full-page search");
});

test("a server-home background carries the redirect-suppress marker from EVERY source; non-home backgrounds carry none", () => {
  desktop();
  const marker = { suppressDefaultRouteRedirect: true };
  // remembered home (the reviewer's reproduction)
  rememberNonSearchLocation({ pathname: "/s/b", search: "" });
  assert.deepEqual(resolveSearchOverlayBackground(locB(null))?.state, marker);
  resetRememberedNonSearchLocation();
  // explicit home
  assert.deepEqual(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b", search: "" } }))?.state, marker);
  // searchFrom home
  assert.deepEqual(resolveSearchOverlayBackground(locB({ searchFrom: "/s/b" }))?.state, marker);
  // trailing-slash home from any source is the same route → normalized AND marked
  for (const st of [{ backgroundLocation: { pathname: "/s/b/", search: "" } }, { searchFrom: "/s/b/" }]) {
    const bg = resolveSearchOverlayBackground(locB(st));
    assert.equal(bg?.pathname, "/s/b", `trailing slash normalized for ${JSON.stringify(st)}`);
    assert.deepEqual(bg?.state, marker, `marker kept for ${JSON.stringify(st)}`);
  }
  rememberNonSearchLocation({ pathname: "/s/b/", search: "" });
  assert.deepEqual(resolveSearchOverlayBackground(locB(null))?.state, marker);
  assert.equal(resolveSearchOverlayBackground(locB(null))?.pathname, "/s/b");
  resetRememberedNonSearchLocation();
  // trailing-slash channel is normalized too, and still unmarked
  assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b/channel/c/", search: "" } }))?.pathname, "/s/b/channel/c");
  // a channel background must not be marked
  assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b/channel/c", search: "" } }))?.state, null);
});

test("overlayCloseTarget strips overlay-only state so the normal home redirect resumes after closing", () => {
  desktop();
  const home = resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b", search: "" } }))!;
  assert.deepEqual(home.state, { suppressDefaultRouteRedirect: true });
  assert.deepEqual(overlayCloseTarget(home), { pathname: "/s/b", search: "" });
});

test("searchEntryState: desktop width carries backgroundLocation unless already on /search; phone width carries only searchFrom", () => {
  desktop();
  assert.deepEqual(searchEntryState({ pathname: "/s/x/channel/c", search: "?a=1" }, { searchEntry: "rail" }), {
    searchEntry: "rail", searchFrom: "/s/x/channel/c?a=1", backgroundLocation: { pathname: "/s/x/channel/c", search: "?a=1" },
  });
  assert.deepEqual(searchEntryState({ pathname: "/s/x/search", search: "?q=1" }), { searchFrom: "/s/x/search?q=1" });
  phone();
  assert.deepEqual(searchEntryState({ pathname: "/s/x/channel/c", search: "" }), { searchFrom: "/s/x/channel/c" });
});

// Task #102 (Slack "Search for: … → results page"): the overlay's "view all
// results" row navigates to /search with `?presentation=page`. That URL marker is
// the one sanctioned exception to the overlay. It rides in the URL
// (not history state) because the page's own URL writers — preview open
// (`?open=`), thread sync (`?thread=`) — replace WITHOUT state and would drop a
// state marker on the very first preview click.
function locPage(search: string, state: unknown = null): Location {
  return { pathname: "/s/b/search", search, hash: "", state, key: "k" };
}

test("resolveSearchOverlayBackground: ?presentation=page renders the page (null), even with a valid background in state (desktop width)", () => {
  desktop();
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  const bg = resolveSearchOverlayBackground(locPage("?q=x&presentation=page", {
    backgroundLocation: { pathname: "/s/b/channel/c", search: "" },
    searchFrom: "/s/b/channel/c",
  }));
  assert.equal(bg, null, "full page requested → no overlay background");
});

test("resolveSearchOverlayBackground: the marker survives the page's own stateless URL rewrites (preview open / msg / thread params appended, state gone)", () => {
  desktop();
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  assert.equal(resolveSearchOverlayBackground(locPage("?q=x&presentation=page&open=channel%3Ac&msg=m1", null)), null);
  assert.equal(resolveSearchOverlayBackground(locPage("?presentation=page&q=x&thread=c%3Am", null)), null);
});

test("resolveSearchOverlayBackground: only the exact marker value opts out — other values / a state-only marker still get the overlay (desktop width)", () => {
  desktop();
  rememberNonSearchLocation({ pathname: "/s/b/channel/c", search: "" });
  assert.ok(resolveSearchOverlayBackground(locPage("?presentation=overlay")), "unknown value → overlay");
  assert.ok(resolveSearchOverlayBackground(locPage("?presentation=")), "empty → overlay");
  assert.ok(resolveSearchOverlayBackground(locPage("?q=page")), "value elsewhere → overlay");
  assert.ok(resolveSearchOverlayBackground(locPage("", { searchPresentation: "page" })), "state is not the marker → overlay");
  assert.ok(resolveSearchOverlayBackground(locPage("")), "absent → overlay");
});

test("isFullPageSearchRequested / fullPageSearchHopState: the hop keeps a searchFrom for Escape/back", () => {
  assert.equal(isFullPageSearchRequested({ search: "?presentation=page" }), true);
  assert.equal(isFullPageSearchRequested({ search: "?a=1&presentation=page&b=2" }), true);
  assert.equal(isFullPageSearchRequested({ search: "?presentation=overlay" }), false);
  assert.equal(isFullPageSearchRequested({ search: "" }), false);

  // Overlay entered via ⌘K from a channel: searchFrom already present → preserved.
  assert.deepEqual(
    fullPageSearchHopState({ searchFrom: "/s/b/channel/c?x=1", backgroundLocation: { pathname: "/s/b/dm/d", search: "" } }),
    { searchFrom: "/s/b/channel/c?x=1" },
  );
  // Only a background: derive searchFrom from it (pathname + search).
  assert.deepEqual(
    fullPageSearchHopState({ backgroundLocation: { pathname: "/s/b/dm/d", search: "?a=1" } }),
    { searchFrom: "/s/b/dm/d?a=1" },
  );
  // Nothing usable (malformed searchFrom, no background): no state at all.
  assert.deepEqual(fullPageSearchHopState({ searchFrom: "javascript:alert(1)" }), {});
  assert.deepEqual(fullPageSearchHopState(null), {});
});

// Task #143: the web gets the same overlay at desktop width (md, ≥768px). Phones
// keep the full page, and a /search URL with nothing to float over (opened fresh
// from a link) lands on the full page instead of hovering over an empty home.
function webWidth(px: number) {
  const prev = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*768px/.test(query) && px >= 768,
    media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  return () => { window.matchMedia = prev; };
}

test("web at desktop width: search entry floats the overlay over the current view", () => {
  const restore = webWidth(1280);
  try {
    const state = searchEntryState({ pathname: "/s/b/channel/c", search: "" });
    assert.deepEqual(state.backgroundLocation, { pathname: "/s/b/channel/c", search: "" });
    const bg = resolveSearchOverlayBackground(locB(state));
    assert.equal(bg?.pathname, "/s/b/channel/c");
  } finally { restore(); }
});

test("web at desktop width: a /search with nothing behind it is the full page, not an overlay over an empty home", () => {
  const restore = webWidth(1280);
  try {
    assert.equal(resolveSearchOverlayBackground(locB(null)), null);
  } finally { restore(); }
});

test("web at phone width: search stays the full page", () => {
  const restore = webWidth(390);
  try {
    const state = searchEntryState({ pathname: "/s/b/channel/c", search: "" });
    assert.equal(state.backgroundLocation, undefined);
    assert.equal(resolveSearchOverlayBackground(locB({ backgroundLocation: { pathname: "/s/b/channel/c", search: "" } })), null);
  } finally { restore(); }
});
