import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";
import { vi } from "vitest";
import { ObjectWindowLocationRaise } from "../src/features/objectWindows/ObjectWindowLocationRaise";
import {
  OBJECT_WINDOW_NAVIGATION_INTENT_MS,
  installObjectWindowLinkRouting,
  noteObjectWindowNavigationIntent,
  ownAppPathOf,
  takeObjectWindowNavigationIntent,
} from "../src/features/objectWindows/objectWindowLinkRouting";

// #337 object windows: a link in an object window acts on the main window (it
// navigates there and raises it), a link within the window's own page stays
// the page's, and only a navigation started in an object window raises the
// main window; the main page's own redirects and replaces never do.

type ChildWindow = Window & typeof globalThis;
type BridgeHost = { raftDesktop?: unknown };

const APP_HREF = "https://app.raft.test/s/acme/c/general";
const windows: ChildWindow[] = [];

/** An object window's document as the store prepares it: a <base href> of the app's origin. */
function child(body: string): { win: ChildWindow; doc: Document } {
  const win = new JSDOM(`<!doctype html><html><head><base href="https://app.raft.test/"></head><body>${body}</body></html>`).window as unknown as ChildWindow;
  windows.push(win);
  return { win, doc: win.document };
}

/** Click `target`; whether the routing took it (jsdom's own navigation is kept out by a last listener). */
function click(win: ChildWindow, target: Element, init: MouseEventInit = {}): boolean {
  let taken = false;
  const last = (event: Event) => {
    taken = event.defaultPrevented;
    event.preventDefault();
  };
  win.addEventListener("click", last);
  win.addEventListener("auxclick", last);
  target.dispatchEvent(new win.MouseEvent(init.button === 1 ? "auxclick" : "click", { bubbles: true, cancelable: true, button: 0, ...init }));
  win.removeEventListener("click", last);
  win.removeEventListener("auxclick", last);
  return taken;
}

function routing() {
  const navigated: string[] = [];
  const raiseMain = vi.fn();
  return { navigated, raiseMain, routing: { navigate: (path: string) => navigated.push(path), raiseMain, appHref: () => APP_HREF } };
}

afterEach(() => {
  cleanup();
  takeObjectWindowNavigationIntent();
  delete (window as unknown as BridgeHost).raftDesktop;
  for (const win of windows.splice(0)) win.close();
});

test("ownAppPathOf: this app's own pages by scheme and host (app://raft's origin is 'null'), else null", () => {
  assert.equal(ownAppPathOf("https://app.raft.test/s/acme/c/random?x=1#m", APP_HREF), "/s/acme/c/random?x=1#m");
  assert.equal(ownAppPathOf("app://raft/s/acme/people/ann", "app://raft/s/acme"), "/s/acme/people/ann");
  assert.equal(ownAppPathOf("https://example.com/", APP_HREF), null);
  assert.equal(ownAppPathOf("http://app.raft.test/s/acme", APP_HREF), null, "another scheme");
});

test("an unhandled click or middle click on an own-app link navigates the main window and raises it", () => {
  const { win, doc } = child("<a id='own' href='/s/acme/c/random'>random</a>");
  const { navigated, raiseMain, routing: deps } = routing();
  const stop = installObjectWindowLinkRouting(doc, deps);
  try {
    const own = doc.getElementById("own")!;
    assert.equal(click(win, own), true);
    assert.deepEqual(navigated, ["/s/acme/c/random"]);
    assert.equal(raiseMain.mock.calls.length, 1);
    assert.equal(click(win, own, { button: 1 }), true, "a middle click too: the desktop app has no tabs");
    assert.deepEqual(navigated, ["/s/acme/c/random", "/s/acme/c/random"]);
  } finally {
    stop();
  }
});

test("links within the page, outside links, downloads and handled clicks keep their default", () => {
  const { win, doc } = child([
    "<a id='hash' href='#section'>section</a>",
    "<a id='empty' href=''>here</a>",
    "<a id='outside' href='https://example.com/'>outside</a>",
    "<a id='download' href='/files/a.txt' download>download</a>",
    "<a id='handled' href='/s/acme/c/random'>handled</a>",
  ].join(""));
  const { navigated, raiseMain, routing: deps } = routing();
  const handled = doc.getElementById("handled")!;
  // A component's own handler (React's, on the portal root) took this one.
  handled.addEventListener("click", (event) => event.preventDefault());
  const stop = installObjectWindowLinkRouting(doc, deps);
  try {
    assert.equal(click(win, doc.getElementById("hash")!), false, "#section is the page's, not the app's home");
    assert.equal(click(win, doc.getElementById("empty")!), false, "an empty href is this page");
    assert.equal(click(win, doc.getElementById("outside")!), false, "the shell sends it to the system browser");
    assert.equal(click(win, doc.getElementById("download")!), false);
    click(win, handled);
    assert.deepEqual(navigated, []);
    assert.equal(raiseMain.mock.calls.length, 0);
  } finally {
    stop();
  }
});

test("a press in the object window notes a navigation intent, used up once and only for a short while", () => {
  const { win, doc } = child("<button id='open'>Open</button><input id='field'>");
  const { routing: deps } = routing();
  const stop = installObjectWindowLinkRouting(doc, deps);
  try {
    assert.equal(takeObjectWindowNavigationIntent(), false, "nothing pressed");
    click(win, doc.getElementById("open")!);
    assert.equal(takeObjectWindowNavigationIntent(), true);
    assert.equal(takeObjectWindowNavigationIntent(), false, "used up");

    doc.getElementById("field")!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(takeObjectWindowNavigationIntent(), false, "Enter in a text field is typing");
    doc.getElementById("open")!.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(takeObjectWindowNavigationIntent(), true, "Enter on a control activates it");

    noteObjectWindowNavigationIntent(1_000);
    assert.equal(takeObjectWindowNavigationIntent(1_000 + OBJECT_WINDOW_NAVIGATION_INTENT_MS + 1), false, "too late");
  } finally {
    stop();
  }
});

test("ObjectWindowLocationRaise raises the main window only for a navigation started in an object window", () => {
  const raise = vi.fn(async (_target: string) => true);
  (window as unknown as BridgeHost).raftDesktop = { facts: { canOpenNewWindow: false, objectWindows: true }, objectWindows: { raise, setReusable: vi.fn() } };
  let navigate: NavigateFunction | null = null;
  function Navigator() {
    navigate = useNavigate();
    return null;
  }
  render(
    <MemoryRouter initialEntries={["/s/acme/c/general"]}>
      <Navigator />
      <ObjectWindowLocationRaise />
    </MemoryRouter>,
  );
  assert.equal(raise.mock.calls.length, 0, "mounting is no navigation");

  act(() => { void navigate?.("/s/acme/c/general?thread=1", { replace: true }); });
  assert.equal(raise.mock.calls.length, 0, "the main page's own replace (a redirect, a socket move) raises nothing");

  noteObjectWindowNavigationIntent();
  act(() => { void navigate?.("/s/acme/c/random"); });
  assert.deepEqual(raise.mock.calls, [["main"]], "a Link or a button in the object window");

  act(() => { void navigate?.("/s/acme/c/random?again=1"); });
  assert.equal(raise.mock.calls.length, 1, "the press was used up");
});
