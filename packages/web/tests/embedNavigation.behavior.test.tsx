import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";

// MobileTabBar's nav hooks read matchMedia; jsdom doesn't ship it.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as never;
}

// These gates exist because my first cut CLAIMED behavior the code did not have
// (@MingQi, @铁根): `embedSearchParams()` had zero callers, so the URL kept nothing.
//
// Three fidelity rules learned the hard way, and pinned here:
//  1. Import the PRODUCTION hook. A test that re-implements the keeper "verbatim in
//     shape" stays green when the real wiring is deleted — which is exactly how the
//     unwired first cut passed its own tests.
//  2. Re-enter from the URL the REAL Router actually produced, not one hand-built by
//     calling the helper. Otherwise the test proves the helper, not the app.
//  3. Every production owner gets its own counterfactual. Two chrome owners changed
//     (LeftRail, MobileTabBar); gating one and asserting the other is how you ship a
//     guard nothing can turn red.

async function loadEmbed(search: string) {
  const { __embedTestInternals, isHostShell } = await import("../src/embed");
  __embedTestInternals.reset();
  window.history.replaceState({}, "", `/${search}`);
  return { isHostShell };
}

/** Reports the Router's ACTUAL current query — the thing a reload would restore from. */
function LocationProbe({ onLocation }: { onLocation?: (search: string) => void }) {
  const location = useLocation();
  onLocation?.(location.search);
  return <div data-testid="query">{location.search}</div>;
}

function Nav() {
  const navigate = useNavigate();
  return (
    <>
      {/* The default form: a bare path. This is what drops the query string — and what
          silently un-embedded the app before the keeper existed. */}
      <button data-testid="go" onClick={() => navigate("/computers/abc")}>go</button>
      {/* A navigation that carries ITS OWN params (a detail view opening a thread).
          The keeper must add embed WITHOUT wiping these. */}
      <button
        data-testid="go-with-params"
        onClick={() => navigate("/computers/abc?thread=c1%3Am1&profile=agent%3Aa1")}
      >
        go+params
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

/** Mounts the app's REAL keeper (not a copy) over a real Router. */
async function renderWithKeeper(entry: string, onLocation?: (search: string) => void) {
  const { useEmbedParamsKeeper } = await import("../src/hooks/useEmbedParamsKeeper");
  function Keeper() {
    useEmbedParamsKeeper();
    return null;
  }
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Keeper />
      <Nav />
      <Routes>
        <Route path="/computers" element={<LocationProbe onLocation={onLocation} />} />
        <Route path="/computers/:id" element={<LocationProbe onLocation={onLocation} />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Click AND let the navigation actually land.
 *
 * A bare `.click()` + `setTimeout(0)` is not enough: React had not yet committed the
 * post-navigation renders when the assertion ran, so the test was reading the URL from
 * BEFORE the navigation — and passing for entirely the wrong reason. A green test that
 * never navigated is worse than no test. `act()` flushes the click, the navigation, and
 * the keeper's effect before we look.
 */
async function clickAndSettle(testId: string) {
  await act(async () => {
    screen.getByTestId(testId).click();
    await Promise.resolve();
  });
}

test("a bare navigate() drops the query — the PRODUCTION keeper puts the embed params back", async () => {
  await loadEmbed("?embed=raft-settings-v1&shell=host&thread=c1%3Am1");
  await renderWithKeeper("/computers?embed=raft-settings-v1&shell=host&thread=c1:m1");

  await clickAndSettle("go");

  const query = screen.getByTestId("query").textContent ?? "";
  assert.match(query, /embed=raft-settings-v1/, "embed must survive the navigation");
  assert.match(query, /shell=host/, "shell must survive the navigation");
});

test("the keeper MERGES into a navigation that brought its own params — it must not wipe them", async () => {
  // @铁根: overwriting is the bug this repo fixed three times (#760/#780/#795, rooted
  // out in #797). The bare-object `setSearchParams` replaces the WHOLE query.
  //
  // Note what this does NOT claim: a bare `navigate("/x")` drops `thread`/`profile` and
  // the keeper does not resurrect them — that is the caller's business, not ours. The
  // contract is narrower and it is the one that bites: when the keeper writes, params
  // already in the URL survive the write.
  await loadEmbed("?embed=raft-settings-v1&shell=host");
  await renderWithKeeper("/computers?embed=raft-settings-v1&shell=host");
  await clickAndSettle("go-with-params");

  const query = screen.getByTestId("query").textContent ?? "";
  assert.match(query, /thread=c1%3Am1/, "another surface's param must survive the keeper's write");
  assert.match(query, /profile=agent%3Aa1/, "another surface's param must survive the keeper's write");
  assert.match(query, /embed=raft-settings-v1/, "and the embed params must be merged in");
  assert.match(query, /shell=host/);
});

test("RELOAD: cold-starting the URL the REAL navigation produced is still host-shell", async () => {
  // The latch cannot survive a WebView kill — only the URL can. So this re-enters from
  // the query the Router ACTUALLY ended up with, captured after a real click. Building
  // that URL by hand would only prove the helper, never the wiring (@MingQi).
  await loadEmbed("?embed=raft-settings-v1&shell=host&thread=c1%3Am1");
  let seen = "";
  await renderWithKeeper("/computers?embed=raft-settings-v1&shell=host&thread=c1:m1", (s) => { seen = s; });

  await clickAndSettle("go");
  assert.ok(seen.length > 0, "the real Router must have produced a query to re-enter from");

  // Now simulate the WebView being killed and relaunched at exactly that URL.
  const { isHostShell } = await loadEmbed(seen);
  assert.equal(isHostShell(), true, "a cold start at the REAL post-navigation URL is still host-shell");
});

test("without the keeper, that same navigation leaves a URL that cold-starts UNEMBEDDED", async () => {
  // The counterfactual, stated as a test: this is what the app did before the keeper.
  const { isHostShell } = await loadEmbed("?thread=c1"); // what a bare navigate() leaves behind
  assert.equal(isHostShell(), false, "this is the bug: cold start on the stripped URL is NOT embedded");
});

// ── Both global-chrome owners get their own counterfactual (@MingQi) ────────────
// Deleting EITHER guard must turn a test red. Gating one and merely asserting the
// other is how you ship a guard nothing can turn red.

async function seedServer() {
  const { useServerStore } = await import("../src/store/serverStore");
  useServerStore.setState({ current: { id: "s1", name: "Dev", slug: "dev" } as never });
}

test("host-shell: the LeftRail does not render on the first frame", async () => {
  await loadEmbed("?embed=raft-settings-v1&shell=host");
  const { LeftRail } = await import("../src/components/layout/LeftRail");
  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev/settings?embed=raft-settings-v1&shell=host"]}>
      <TestIntlProvider><LeftRail /></TestIntlProvider>
    </MemoryRouter>,
  );
  assert.equal(container.innerHTML, "", "the rail must render nothing under host-shell");
});

test("not embedded: the LeftRail renders — so the guard above is a gate, not a tautology", async () => {
  await loadEmbed("");
  const { LeftRail } = await import("../src/components/layout/LeftRail");
  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev/settings"]}>
      <TestIntlProvider><LeftRail /></TestIntlProvider>
    </MemoryRouter>,
  );
  assert.notEqual(container.innerHTML, "", "the rail must still render when not embedded");
});

test("host-shell: the MobileTabBar does not render on the first frame", async () => {
  await loadEmbed("?embed=raft-settings-v1&shell=host");
  await seedServer();
  const { MobileTabBar } = await import("../src/components/layout/MainLayout");
  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev/settings?embed=raft-settings-v1&shell=host"]}>
      <TestIntlProvider><MobileTabBar /></TestIntlProvider>
    </MemoryRouter>,
  );
  assert.equal(container.innerHTML, "", "the mobile tab bar must render nothing under host-shell");
});

test("not embedded: the MobileTabBar renders on a tab-home route — the gate can go red", async () => {
  // The positive control that makes the test above meaningful. MobileTabBar also
  // returns null with no serverSlug and on detail routes, so without this the
  // host-shell assertion would pass even with the guard deleted.
  await loadEmbed("");
  await seedServer();
  const { MobileTabBar } = await import("../src/components/layout/MainLayout");
  const { container } = render(
    <MemoryRouter initialEntries={["/s/dev/settings"]}>
      <TestIntlProvider><MobileTabBar /></TestIntlProvider>
    </MemoryRouter>,
  );
  assert.notEqual(container.innerHTML, "", "the tab bar must still render when not embedded");
});
