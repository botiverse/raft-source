import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { cleanup, render } from "@testing-library/react";
import {
  OwnerDocumentContext,
  animationFramesOf,
  docOf,
  isElementNode,
  isHTMLElementNode,
  useOwnerDocument,
  useOwnerWindow,
  viewOf,
} from "../src/utils/ownerDocument";
import type { OwnerWindow } from "../src/utils/ownerDocument";

// #337 object windows: a node of an object window is made by that window's
// constructors, so `instanceof Element` / `instanceof HTMLElement` in the
// main window's code is false for it. The ownerDocument helpers answer the
// same questions for a node of any window.

/** The jsdom windows a test made, closed after it. */
const windows: OwnerWindow[] = [];

function child(): OwnerWindow {
  const win = new JSDOM("<!doctype html><html><body><p id='p'>text</p></body></html>", { pretendToBeVisual: true }).window as unknown as OwnerWindow;
  windows.push(win);
  return win;
}

afterEach(() => {
  cleanup();
  for (const win of windows.splice(0)) win.close();
});

test("isElementNode and isHTMLElementNode hold for an element of another window, where instanceof does not", () => {
  const win = child();
  const paragraph = win.document.getElementById("p");
  assert.equal(paragraph instanceof Element, false, "the main window's Element is another realm's");
  assert.equal(isElementNode(paragraph), true);
  assert.equal(isHTMLElementNode(paragraph), true);
  assert.equal(isElementNode(paragraph?.firstChild), false, "a text node");
  assert.equal(isElementNode(win.document), false);
  assert.equal(isElementNode(win), false);
  assert.equal(isElementNode(null), false);
  assert.equal(isElementNode({ nodeType: 3 }), false);
  const svg = win.document.createElementNS("http://www.w3.org/2000/svg", "svg");
  assert.equal(isElementNode(svg), true);
  assert.equal(isHTMLElementNode(svg), false, "an SVG element is no HTMLElement");
  assert.equal(isHTMLElementNode(document.createElement("div")), true, "the main window's own");
});

test("docOf and viewOf: a node's own document and window; the globals for nothing", () => {
  const win = child();
  const paragraph = win.document.getElementById("p");
  assert.ok(docOf(paragraph) === win.document);
  assert.ok(docOf(win.document) === win.document);
  assert.ok(docOf(win) === win.document, "a window's document");
  assert.ok(viewOf(paragraph) === win);
  assert.ok(docOf(document.body) === document);
  assert.ok(docOf(null) === document);
  assert.ok(viewOf(undefined) === window);
});

test("animationFramesOf: the globals for the main document, the object window's own for its document", () => {
  const win = child();
  assert.ok(animationFramesOf(document) === globalThis);
  assert.ok(animationFramesOf(null) === globalThis);
  assert.ok(animationFramesOf(win.document) === win);
});

test("useOwnerDocument and useOwnerWindow: the globals, or the window the subtree is drawn in", () => {
  const win = child();
  const seen: Array<{ doc: Document; view: Window }> = [];
  function Probe() {
    seen.push({ doc: useOwnerDocument(), view: useOwnerWindow() });
    return null;
  }
  render(<Probe />);
  render(<OwnerDocumentContext value={{ doc: win.document, win }}><Probe /></OwnerDocumentContext>);
  assert.equal(seen.length, 2);
  assert.ok(seen[0]?.doc === document && seen[0]?.view === window, "the main window by default");
  assert.ok(seen[1]?.doc === win.document && seen[1]?.view === win, "the object window's");
});
