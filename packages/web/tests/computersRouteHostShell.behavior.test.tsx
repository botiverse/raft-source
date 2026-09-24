import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import type { ComponentType } from "react";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * @MingQi: a native WebView on a tablet or in landscape can exceed the md breakpoint.
 * Before this gate, `ComputersRoute` branched purely on viewport width, so a wide
 * WebView would render `<ChatPanel>` — the wrong page. Mobile can't fake a narrow
 * viewport from its side, so host-shell must be authoritative in web.
 *
 * The gate: under `?embed=raft-settings-v1&shell=host`, `ComputersRoute` renders
 * `MobileComputersPanel` regardless of viewport width. Counterfactual: reverting
 * `isHostShell()` from the branch turns the wide-embed case red.
 */

// jsdom doesn't ship matchMedia; ComputersRoute reads it eagerly.
function shimMatchMedia(matches: boolean) {
  window.matchMedia = ((q: string) => ({
    matches,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
}

async function seedServer() {
  const { useServerStore } = await import("../src/store/serverStore");
  useServerStore.setState({ current: { id: "s1", name: "Dev", slug: "dev" } as never });
}

async function mount(entry: string) {
  const { __embedTestInternals } = await import("../src/embed");
  __embedTestInternals.reset();
  window.history.replaceState({}, "", `/${entry.split("?").slice(1).join("?") ? "?" + entry.split("?").slice(1).join("?") : ""}`);
  // Import MainLayout module to pull ComputersRoute into scope. It isn't exported, so we
  // reach the route via the actual Routes wiring in <MainLayout />. Because MainLayout
  // pulls the whole app chunk, we take a shortcut: import the route body indirectly via
  // MobileComputersPanel + ChatPanel and let a tiny stand-in Route replay the same
  // branching logic — but that would REPLICATE the code we're gating. Instead we import
  // the actual ComputersRoute by exposing it as a named export from MainLayout.
  const mod = await import("../src/components/layout/MainLayout");
  const ComputersRoute = (mod as unknown as { __testInternals: { ComputersRoute: ComponentType } }).__testInternals.ComputersRoute;
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/s/:slug/computers" element={<ComputersRoute />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

test("host-shell + WIDE viewport: MobileComputersPanel renders — the whole point of the gate", async () => {
  // The scenario that would have shipped a broken WebView: tablet/landscape WebView is
  // measured wide, but is embedded and must show the mobile panel.
  shimMatchMedia(true); // isDesktop = true
  await seedServer();
  await mount("/s/dev/computers?embed=raft-settings-v1&shell=host");
  assert.ok(await waitFor(() => screen.queryByTestId("mobile-computers-panel")), "host-shell must force MobileComputersPanel even at wide viewport");
});

test("NOT embedded + wide viewport: ChatPanel branch preserved — no regression to desktop", async () => {
  shimMatchMedia(true);
  await seedServer();
  const { container } = await mount("/s/dev/computers");
  // ChatPanel does NOT render the mobile computers add-button. If MobileComputersPanel
  // renders here, we broke the desktop rail flow.
  assert.equal(screen.queryByTestId("mobile-computers-panel"), null, "wide + no embed → MobileComputersPanel must NOT render (ChatPanel is desktop-only)");
  assert.notEqual(container.innerHTML, "");
});

test("NOT embedded + narrow viewport: MobileComputersPanel — the pre-existing mobile branch still works", async () => {
  shimMatchMedia(false);
  await seedServer();
  await mount("/s/dev/computers");
  assert.ok(await waitFor(() => screen.queryByTestId("mobile-computers-panel")), "narrow viewport still renders MobileComputersPanel (pre-existing branch)");
});

// tiny helper: 5 microtask flushes worth of retry, so the store update + lazy loads land
async function waitFor<T>(predicate: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 10; i++) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 0));
  }
  const v = predicate();
  if (!v) throw new Error("predicate never satisfied");
  return v;
}
