import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installObjectWindowChrome, installObjectWindowFullScreen, titleBarOverlayHeight } from "../src/features/objectWindows/objectWindowChrome";
import { STEADY_TITLE_BAR_START_VAR } from "../src/components/topbar/windowControlsOverlayGeometry";

// #337 PR3 (Kirby): an object window's frame is its own. The shell draws its
// traffic lights or caption buttons on that window, so titleBar.css's
// attributes come from the object window's own Window Controls Overlay
// (installObjectWindowChrome), never mirrored from the main window
// (syncStyles leaves them alone: objectWindowStyles.test.tsx).

/** The jsdom windows a test made, closed after it. */
const windows: Array<{ close(): void }> = [];

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
});

/** A child window whose navigator has a Window Controls Overlay with `rect` (the area clear of its controls). */
function childWithOverlay(rect: { x: number; width: number }, innerWidth = 1000) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://app.raft.test/" });
  windows.push(dom.window);
  const listeners = new Set<() => void>();
  const overlay = {
    visible: true,
    getTitlebarAreaRect: () => ({ x: rect.x, y: 0, width: rect.width, height: 44 }),
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(dom.window.navigator, "windowControlsOverlay", { configurable: true, value: overlay });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: innerWidth });
  return { win: dom.window as unknown as Window, root: dom.window.document.documentElement as HTMLElement, listeners, rect };
}

test("macOS overlay: the traffic lights' corner from the object window's own overlay, undone by the stop", () => {
  const { win, root } = childWithOverlay({ x: 78, width: 922 });
  const stop = installObjectWindowChrome(root, win, { titleBar: "overlay", platform: "darwin" });
  assert.equal(root.dataset.titleBar, "overlay");
  assert.equal(root.dataset.titleBarStart, "overlay", "the controls take the left end");
  assert.equal(root.style.getPropertyValue(STEADY_TITLE_BAR_START_VAR), "78px");
  assert.equal(root.hasAttribute("data-title-bar-steady"), true);
  stop();
  assert.equal(root.hasAttribute("data-title-bar"), false);
  assert.equal(root.hasAttribute("data-title-bar-start"), false);
  assert.equal(root.style.getPropertyValue(STEADY_TITLE_BAR_START_VAR), "");
});

test("Windows overlay: the caption buttons' end only, no steady macOS corner, and it follows the geometry", () => {
  const { win, root, listeners, rect } = childWithOverlay({ x: 0, width: 862 });
  const stop = installObjectWindowChrome(root, win, { titleBar: "overlay", platform: "win32" });
  try {
    assert.equal(root.dataset.titleBar, "overlay");
    assert.equal(root.hasAttribute("data-title-bar-start"), false);
    assert.equal(root.hasAttribute("data-title-bar-steady"), false);
    rect.x = 12;
    for (const listener of listeners) listener();
    assert.equal(root.dataset.titleBarStart, "overlay", "geometrychange on the object window's own overlay");
  } finally {
    stop();
  }
});

test("a window manager's frame is `native`; no shell or no title bar fact sets nothing", () => {
  const { win, root } = childWithOverlay({ x: 0, width: 1000 });
  const stopNative = installObjectWindowChrome(root, win, { titleBar: "native", platform: "linux" });
  assert.equal(root.dataset.titleBar, "native");
  stopNative();
  assert.equal(root.hasAttribute("data-title-bar"), false);

  installObjectWindowChrome(root, win, null)();
  installObjectWindowChrome(root, win, { titleBar: undefined, platform: "darwin" })();
  assert.equal(root.hasAttribute("data-title-bar"), false);
});

test("data-fullscreen follows THAT object window's full screen from the shell, and the stop unsubscribes", () => {
  const { root } = childWithOverlay({ x: 78, width: 922 });
  let listener: ((frameName: string, fullScreen: boolean) => void) | null = null;
  const objectWindows = {
    raise: async () => false,
    setReusable: () => {},
    onFullScreenChange: (next: (frameName: string, fullScreen: boolean) => void) => {
      listener = next;
      return () => { listener = null; };
    },
  };
  const stop = installObjectWindowFullScreen(root, "raft-object-window-2", { objectWindows });
  const send = (frameName: string, fullScreen: boolean) => listener?.(frameName, fullScreen);
  send("raft-object-window-1", true);
  assert.equal(root.hasAttribute("data-fullscreen"), false, "another object window's full screen");
  send("raft-object-window-2", true);
  assert.equal(root.hasAttribute("data-fullscreen"), true);
  send("raft-object-window-2", false);
  assert.equal(root.hasAttribute("data-fullscreen"), false);
  send("raft-object-window-2", true);
  stop();
  assert.equal(root.hasAttribute("data-fullscreen"), false, "removed by the stop");
  assert.equal(listener, null, "unsubscribed");
});

test("no shell, or a shell that predates the full-screen report, sets nothing", () => {
  const { root } = childWithOverlay({ x: 78, width: 922 });
  installObjectWindowFullScreen(root, "raft-object-window-1", null)();
  installObjectWindowFullScreen(root, "raft-object-window-1", { objectWindows: { raise: async () => false, setReusable: () => {} } })();
  assert.equal(root.hasAttribute("data-fullscreen"), false);
});

/** A head row `height` px tall (its border included, as getBoundingClientRect) with a bottom border of `seam`. */
function headRow(height: number, seam: string) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://app.raft.test/" });
  windows.push(dom.window);
  const row = dom.window.document.createElement("div");
  row.style.borderBottom = `${seam} solid`;
  row.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1000, height, top: 0, left: 0, right: 1000, bottom: height, toJSON: () => ({}) });
  dom.window.document.body.append(row);
  return row as unknown as HTMLElement;
}

test("the window controls stop above the head's seam, so the line runs under them too (Kirby, #337)", () => {
  assert.equal(titleBarOverlayHeight(headRow(44, "1px")), 43);
  assert.equal(titleBarOverlayHeight(headRow(40, "1px")), 39, "a window under 600px tall: every head is 40px");
  assert.equal(titleBarOverlayHeight(headRow(44, "0.5px")), 43, "a hairline is never covered either");
  assert.equal(titleBarOverlayHeight(headRow(44, "0px")), 44, "a head with no seam keeps its full height");
});
