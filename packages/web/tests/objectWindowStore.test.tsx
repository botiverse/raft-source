import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { vi } from "vitest";
import {
  MAX_OBJECT_WINDOWS,
  OBJECT_WINDOW_ROOT_ID,
  closeObjectWindow,
  openObjectWindow,
  resetObjectWindowsForTests,
  useObjectWindowStore,
} from "../src/features/objectWindows/objectWindowStore";
import { isPageHidden } from "../src/utils/visiblePoll";

// #337 object windows: openObjectWindow opens an about:blank child window
// named raft-object-window-<n> (Raft Desktop allows exactly that), prepares
// its document for a portal, and keeps one reusable window that a plain open
// replaces the object of. The shell side is apps/desktop main/objectWindows.ts.

type BridgeHost = { raftDesktop?: unknown };

function installBridge(facts: Record<string, unknown> = { canOpenNewWindow: false, objectWindows: true }) {
  const raise = vi.fn(async (_target: string) => true);
  const setReusable = vi.fn((_name: string | null) => undefined);
  (window as unknown as BridgeHost).raftDesktop = { facts, objectWindows: { raise, setReusable } };
  return { raise, setReusable };
}

/** A second jsdom window, as window.open returns the child (its initial about:blank). */
type ChildWindow = Window & typeof globalThis;

/** Every child window a test made, closed after it. */
const created: ChildWindow[] = [];

function childWindow(): ChildWindow {
  const child = new JSDOM("", { pretendToBeVisual: true }).window as unknown as ChildWindow;
  created.push(child);
  return child;
}

/** The shell destroyed the window (a refused adoption): closed, and no pagehide. */
function destroyedByShell(child: ChildWindow): void {
  Object.defineProperty(child, "closed", { configurable: true, value: true });
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** window.open stubbed: each call answers `next()` (a new child by default), and is recorded. */
function stubWindowOpen(next: () => ChildWindow | null = childWindow) {
  const calls: Array<{ url: string | URL | undefined; name: string | undefined; features: string | undefined }> = [];
  const children: ChildWindow[] = [];
  vi.spyOn(window, "open").mockImplementation((url?: string | URL, name?: string, features?: string) => {
    calls.push({ url, name, features });
    const child = next();
    if (child) children.push(child);
    return child;
  });
  return { calls, children };
}

function entry(name: string) {
  return useObjectWindowStore.getState().windows.get(name);
}

afterEach(() => {
  resetObjectWindowsForTests();
  delete (window as unknown as BridgeHost).raftDesktop;
  for (const child of created.splice(0)) child.close();
});

test("nothing opens without the shell's objectWindows fact: false, and no window.open", () => {
  const { calls } = stubWindowOpen();
  assert.equal(openObjectWindow("demo", { id: 1 }), false, "no bridge (a browser)");
  installBridge({ canOpenNewWindow: false });
  assert.equal(openObjectWindow("demo", { id: 1 }), false, "a shell that predates object windows");
  assert.equal(calls.length, 0);
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
});

test("a plain open opens raft-object-window-1 as an about:blank popup, prepares its document and makes it the reusable one", () => {
  const { setReusable } = installBridge();
  const { calls, children } = stubWindowOpen();

  assert.equal(openObjectWindow("demo", { id: 1 }, { title: "Demo" }), true);

  assert.deepEqual(calls, [{ url: "about:blank", name: "raft-object-window-1", features: "popup" }]);
  const opened = entry("raft-object-window-1");
  assert.ok(opened, "kept in the store");
  assert.equal(opened.kind, "demo");
  assert.deepEqual(opened.payload, { id: 1 });
  assert.equal(opened.revision, 0);
  assert.ok(opened.win === children[0], "the window window.open returned");
  const doc = opened.doc;
  assert.equal(doc.compatMode, "CSS1Compat", "a standards-mode document, not the initial about:blank's quirks mode");
  assert.equal(doc.querySelector("meta[charset]")?.getAttribute("charset"), "utf-8");
  assert.equal(doc.querySelector("base")?.getAttribute("href"), new URL("/", window.location.href).href, "this app's origin");
  assert.equal(doc.title, "Demo");
  assert.ok(opened.root === doc.getElementById(OBJECT_WINDOW_ROOT_ID), "the portal root in the body");
  assert.ok(opened.root.parentElement === doc.body);
  assert.equal(useObjectWindowStore.getState().reusable, "raft-object-window-1");
  assert.deepEqual(setReusable.mock.calls, [["raft-object-window-1"]]);
});

test("window.open answering null (the shell refused): false, and nothing is kept", () => {
  const { setReusable } = installBridge();
  const { calls } = stubWindowOpen(() => null);
  assert.equal(openObjectWindow("demo", { id: 1 }), false);
  assert.equal(calls.length, 1);
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
  assert.equal(useObjectWindowStore.getState().reusable, null);
  assert.equal(setReusable.mock.calls.length, 0);
});

test("a plain open with the reusable window open replaces its object and raises it, without a second window.open", () => {
  const { raise } = installBridge();
  const { calls } = stubWindowOpen();
  const row = document.createElement("button");
  document.body.append(row);
  try {
    openObjectWindow("demo", { id: 1 });
    assert.equal(openObjectWindow("demo", { id: 2 }, { from: row }), true);

    assert.equal(calls.length, 1, "never window.open on a name that is open");
    assert.equal(useObjectWindowStore.getState().windows.size, 1);
    const reused = entry("raft-object-window-1");
    assert.deepEqual(reused?.payload, { id: 2 });
    assert.equal(reused?.revision, 1, "the host remounts the object");
    assert.ok(reused?.openedFrom?.deref() === row, "focus goes back to the latest opener");
    assert.deepEqual(raise.mock.calls, [["raft-object-window-1"]]);
  } finally {
    row.remove();
  }
});

test("an additional open gets a window of its own with a new name; the reusable one stays", () => {
  const { setReusable } = installBridge();
  const { calls } = stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  assert.equal(openObjectWindow("demo", { id: 2 }, { additional: true }), true);

  assert.deepEqual(calls.map((call) => call.name), ["raft-object-window-1", "raft-object-window-2"]);
  assert.deepEqual(entry("raft-object-window-2")?.payload, { id: 2 });
  assert.equal(useObjectWindowStore.getState().reusable, "raft-object-window-1");
  assert.deepEqual(setReusable.mock.calls, [["raft-object-window-1"]], "an additional window is never the reusable one");

  // Another plain open still goes to the reusable window.
  openObjectWindow("demo", { id: 3 });
  assert.equal(calls.length, 2);
  assert.deepEqual(entry("raft-object-window-1")?.payload, { id: 3 });
  assert.deepEqual(entry("raft-object-window-2")?.payload, { id: 2 });
});

test("the window's pagehide (it closed) removes it; the next plain open opens a new window", () => {
  const { setReusable } = installBridge();
  const { calls, children } = stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  const child = children[0]!;

  child.dispatchEvent(new child.Event("pagehide"));

  assert.equal(useObjectWindowStore.getState().windows.size, 0);
  assert.equal(useObjectWindowStore.getState().reusable, null);
  assert.deepEqual(setReusable.mock.calls.at(-1), [null], "the shell forgets the reusable window");

  assert.equal(openObjectWindow("demo", { id: 2 }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.name, "raft-object-window-2", "a fresh name, never one the shell may still hold");
});

test("at most MAX_OBJECT_WINDOWS open: the next open is refused before window.open", () => {
  installBridge();
  const { calls } = stubWindowOpen();
  for (let index = 0; index < MAX_OBJECT_WINDOWS; index++) {
    assert.equal(openObjectWindow("demo", { index }, { additional: true }), true, `window ${index + 1}`);
  }
  assert.equal(openObjectWindow("demo", { index: MAX_OBJECT_WINDOWS }, { additional: true }), false);
  assert.equal(calls.length, MAX_OBJECT_WINDOWS);
  assert.equal(new Set(calls.map((call) => call.name)).size, MAX_OBJECT_WINDOWS, "every name different");
  // A plain open with no reusable window open is refused too.
  assert.equal(openObjectWindow("demo", { index: 99 }), false);
  assert.equal(calls.length, MAX_OBJECT_WINDOWS);
});

test("closeObjectWindow closes the window and forgets it; the main page's pagehide closes them all", () => {
  installBridge();
  const { children } = stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  openObjectWindow("demo", { id: 2 }, { additional: true });
  openObjectWindow("demo", { id: 3 }, { additional: true });
  const closes = children.map((child) => vi.spyOn(child, "close"));

  closeObjectWindow("raft-object-window-2");
  assert.equal(closes[1]?.mock.calls.length, 1);
  assert.deepEqual([...useObjectWindowStore.getState().windows.keys()], ["raft-object-window-1", "raft-object-window-3"]);

  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(useObjectWindowStore.getState().windows.size, 0);
  assert.equal(closes[0]?.mock.calls.length, 1);
  assert.equal(closes[2]?.mock.calls.length, 1);
});

test("the page is not hidden while an object window is visible, even with the main window hidden", () => {
  installBridge();
  stubWindowOpen();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  assert.equal(isPageHidden(), true, "the main window hidden, nothing else");

  openObjectWindow("demo", { id: 1 });
  assert.equal(isPageHidden(), false, "the object window shows this page's data");

  closeObjectWindow("raft-object-window-1");
  assert.equal(isPageHidden(), true);
});

test("a window the shell destroyed without a pagehide (a refused adoption) is forgotten on the next check", async () => {
  const { setReusable } = installBridge();
  const { children } = stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  destroyedByShell(children[0]!);

  await nextTick();

  assert.equal(useObjectWindowStore.getState().windows.size, 0, "it no longer counts toward the limit or renders");
  assert.equal(useObjectWindowStore.getState().reusable, null);
  assert.deepEqual(setReusable.mock.calls.at(-1), [null]);
});

test("the main window's focus forgets a window that closed without a pagehide", async () => {
  installBridge();
  const { children } = stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  openObjectWindow("demo", { id: 2 }, { additional: true });
  await nextTick();
  assert.equal(useObjectWindowStore.getState().windows.size, 2, "both adopted");

  destroyedByShell(children[1]!);
  window.dispatchEvent(new window.Event("focus"));

  assert.deepEqual([...useObjectWindowStore.getState().windows.keys()], ["raft-object-window-1"]);
  assert.equal(useObjectWindowStore.getState().reusable, "raft-object-window-1");
});

test("each object window guards its own layers: a menu open in it frees its title bar, one in the main window doesn't", async () => {
  installBridge();
  stubWindowOpen();
  openObjectWindow("demo", { id: 1 });
  const doc = entry("raft-object-window-1")!.doc;
  const menu = doc.createElement("div");
  menu.setAttribute("role", "dialog");
  doc.body.append(menu);
  // The guard syncs on the window's next frame or after LAYER_SYNC_FALLBACK_MS, whichever comes first.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(doc.documentElement.hasAttribute("data-raft-layer-open"), true, "its own layer");
  menu.remove();
  document.documentElement.setAttribute("data-raft-layer-open", "");
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(doc.documentElement.hasAttribute("data-raft-layer-open"), false, "the main window's is not this window's");
  } finally {
    document.documentElement.removeAttribute("data-raft-layer-open");
  }
  closeObjectWindow("raft-object-window-1");
  assert.equal(doc.documentElement.hasAttribute("data-raft-layer-open"), false, "the guard stops with the window");
});
