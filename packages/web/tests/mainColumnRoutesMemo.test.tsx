import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { __testInternals } from "../src/components/layout/MainLayout";

// Task #441: `<Routes location>` hands everything under it a new route context
// and a new location context on each of its renders. MainLayout renders on
// every store update it reads, and every mounted message row reads the router
// (useAppNavigate), so each of those updates rendered every row.

const probe = vi.hoisted(() => ({ renders: 0 }));

// One real route of the main column, replaced by a component that reads the
// router the way a message row does.
vi.mock("../src/features/keyboard-shortcuts/ShortcutHelpPage", async () => {
  const router = await import("react-router-dom");
  return {
    ShortcutHelpPage: function RouterReader() {
      router.useNavigate();
      probe.renders += 1;
      return <div data-testid="router-reader">{router.useLocation().pathname}</div>;
    },
  };
});

const MainColumnRoutes = __testInternals.MainColumnRoutes;

let rerenderLayout: () => void = () => undefined;
let navigateTo: (path: string) => void = () => undefined;

/** MainLayout's part in it: it reads the location, renders on its own state, and passes the location down. */
function Layout() {
  const [, setTick] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  rerenderLayout = () => setTick((tick) => tick + 1);
  navigateTo = (path) => { void navigate(path); };
  return <MainColumnRoutes location={location} />;
}

afterEach(() => {
  cleanup();
  probe.renders = 0;
});

test("the main column's routes do not render again when the layout does, only for another location", () => {
  render(<MemoryRouter initialEntries={["/keyboard-shortcuts?a=1"]}><Layout /></MemoryRouter>);
  assert.equal(screen.getByTestId("router-reader").textContent, "/keyboard-shortcuts");
  const mounted = probe.renders;
  assert.ok(mounted >= 1);

  act(() => rerenderLayout());
  act(() => rerenderLayout());
  assert.equal(probe.renders, mounted, "a layout render with the same location renders nothing under the routes");

  // Another location still reaches the route.
  act(() => navigateTo("/keyboard-shortcuts?a=2"));
  assert.ok(probe.renders > mounted);
  assert.equal(screen.getByTestId("router-reader").textContent, "/keyboard-shortcuts");
});

// The test above holds for MainColumnRoutes; this one holds MainLayout to using it. Rendering the whole layout
// to observe the same thing needs every store and panel it mounts, so the source is read instead.
test("MainLayout renders its main column through MainColumnRoutes, and has no <Routes> of its own", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../src/components/layout/MainLayout.tsx"), "utf8");
  const routesAt = [...source.matchAll(/<Routes\b/g)].map((match) => match.index);
  const memoAt = source.indexOf("const MainColumnRoutes = memo(function MainColumnRoutes(");
  const layoutAt = source.indexOf("export default function MainLayout()");
  assert.ok(memoAt > 0 && layoutAt > memoAt, "MainColumnRoutes is a memo component defined before MainLayout");
  assert.equal(routesAt.length, 1, "one <Routes> in the file");
  assert.ok(routesAt[0]! > memoAt && routesAt[0]! < layoutAt, "and it is inside MainColumnRoutes");
  assert.equal([...source.slice(layoutAt).matchAll(/<MainColumnRoutes location=\{/g)].length, 1);
});
