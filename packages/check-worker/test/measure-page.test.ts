import assert from "node:assert/strict";
import test from "node:test";

import { measurePage } from "../src/measurePage";
import { cantScrollOf, type PageMeasure } from "../src/pageChecks";

/**
 * The page's own measuring (src/measurePage.ts) over a fake DOM: what counts as content the reader
 * can't scroll to, and then the hint (src/pageChecks.ts cantScrollOf) at desktop. A real browser's
 * boxes are the e2e plan's (README). Run the way puppeteer runs it too: its text alone, in a scope
 * with no module (a bundle's `__name` helper is not there).
 */

interface Style {
  display?: string;
  opacity?: string;
  visibility?: string;
  position?: string;
  overflowY?: string;
  contentVisibility?: string;
}
interface Spec {
  tag?: string;
  id?: string;
  className?: string;
  style?: Style;
  /** Top and bottom in the window's px (the box spans the window's width unless `left`/`right`). */
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  scrollHeight?: number;
  clientHeight?: number;
  /** Its own text (a text node first among its children). */
  text?: string;
  children?: FakeElement[];
}

const WIDTH = 1280;
const HEIGHT = 800;

class FakeText {
  readonly nodeType = 3;
  nextSibling: FakeNode | null = null;
  constructor(readonly nodeValue: string) {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly id: string;
  readonly style: Required<Style>;
  parentElement: FakeElement | null = null;
  nextSibling: FakeNode | null = null;
  previousElementSibling: FakeElement | null = null;
  readonly firstChild: FakeNode | null;
  readonly lastElementChild: FakeElement | null;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth = WIDTH;
  readonly innerText: string;
  private readonly box: { top: number; bottom: number; left: number; right: number };
  private readonly className: string;

  constructor(spec: Spec) {
    this.tagName = (spec.tag ?? "div").toUpperCase();
    this.id = spec.id ?? "";
    this.className = spec.className ?? "";
    this.style = { display: "block", opacity: "1", visibility: "visible", position: "static", overflowY: "visible", contentVisibility: "visible", ...spec.style };
    this.box = { top: spec.top ?? 0, bottom: spec.bottom ?? 0, left: spec.left ?? 0, right: spec.right ?? WIDTH };
    this.clientHeight = spec.clientHeight ?? this.box.bottom - this.box.top;
    this.scrollHeight = spec.scrollHeight ?? this.clientHeight;
    const children = spec.children ?? [];
    const nodes: FakeNode[] = [...(spec.text === undefined ? [] : [new FakeText(spec.text)]), ...children];
    nodes.forEach((node, at) => (node.nextSibling = nodes[at + 1] ?? null));
    children.forEach((child, at) => {
      child.parentElement = this;
      child.previousElementSibling = children[at - 1] ?? null;
    });
    this.firstChild = nodes[0] ?? null;
    this.lastElementChild = children.at(-1) ?? null;
    this.innerText = [spec.text ?? "", ...children.map((child) => child.innerText)].join(" ");
  }

  getBoundingClientRect() {
    const { top, bottom, left, right } = this.box;
    return { top, bottom, left, right, width: right - left, height: bottom - top };
  }

  getAttribute(name: string) {
    return name === "class" && this.className !== "" ? this.className : null;
  }

  computed() {
    return { ...this.style, getPropertyValue: (name: string) => (name === "content-visibility" ? this.style.contentVisibility : "") };
  }
}
type FakeNode = FakeText | FakeElement;

const el = (spec: Spec, ...children: FakeElement[]) => new FakeElement({ ...spec, children });
/** A paragraph of text from `top` to `bottom`. */
const p = (top: number, bottom: number, extra: Spec = {}) => el({ tag: "p", text: "Words", top, bottom, ...extra });

/** A document: html (the scrolling element, `scrollHeight` as given) around `body`. */
function page(body: FakeElement, html: { overflowY?: string; scrollHeight?: number } = {}) {
  const root = new FakeElement({ tag: "html", style: { overflowY: html.overflowY ?? "visible" }, top: 0, bottom: HEIGHT, clientHeight: HEIGHT, scrollHeight: html.scrollHeight ?? HEIGHT, children: [body] });
  return { html: root, body };
}

/** `measure` with the page's globals faked, then taken away. */
function withPage<T>(doc: { html: FakeElement; body: FakeElement }, measure: () => T): T {
  const globals = globalThis as Record<string, unknown>;
  globals.document = { documentElement: doc.html, body: doc.body, scrollingElement: doc.html };
  globals.window = { innerWidth: WIDTH, innerHeight: HEIGHT, scrollY: 0 };
  globals.getComputedStyle = (element: FakeElement) => element.computed();
  try {
    return measure();
  } finally {
    delete globals.document;
    delete globals.window;
    delete globals.getComputedStyle;
  }
}

const measured = (doc: { html: FakeElement; body: FakeElement }) => withPage(doc, measurePage);
const hintOf = (doc: { html: FakeElement; body: FakeElement }) => cantScrollOf(measured(doc), { shot: "desktop", width: WIDTH, height: HEIGHT });

test("a Vite + raft-ui app shell: html and body hidden, the content goes on below; the hint names them", () => {
  const doc = page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT, scrollHeight: 2340 }, el({ id: "root", top: 0, bottom: HEIGHT }, p(0, 400), p(400, 2340))), { overflowY: "hidden" });
  const measure = measured(doc);
  assert.equal(measure.scroll?.contentBottom, 2340);
  assert.equal(measure.scroll?.innerScroller, false);
  assert.equal(measure.scroll?.holder, null, "#root clips nothing");
  assert.deepEqual([measure.scroll?.htmlOverflowY, measure.scroll?.bodyOverflowY, measure.scroll?.bodyBottom], ["hidden", "hidden", HEIGHT]);
  assert.equal(measure.textLength, "Words Words".length);
  assert.deepEqual(hintOf(doc), {
    shot: "desktop", viewportWidth: WIDTH, viewportHeight: HEIGHT, contentHeight: 2340, hiddenHeight: 1540,
    heldBy: [{ element: "html", style: "overflow: hidden" }, { element: "body", style: "overflow: hidden" }],
  });
});

test("body alone hidden (its overflow is the window's): reported with body", () => {
  const doc = page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: 2340 }, p(0, 2340)), { scrollHeight: 2340 });
  assert.deepEqual(hintOf(doc)?.heldBy, [{ element: "body", style: "overflow: hidden" }]);
});

test("a full-window app scrolling inside its own container: nothing reported, and what it scrolls isn't counted", () => {
  const main = el({ tag: "main", style: { overflowY: "auto" }, top: 0, bottom: HEIGHT, scrollHeight: 2400, clientHeight: HEIGHT }, p(0, 2400));
  const doc = page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT }, el({ tag: "nav", text: "Menu", top: 0, bottom: 60 }), main), { overflowY: "hidden" });
  const measure = measured(doc);
  assert.equal(measure.scroll?.innerScroller, true);
  assert.equal(measure.scroll?.contentBottom, 60, "the nav; main's paragraph is the reader's to scroll to");
  assert.equal(hintOf(doc), null);
  // A small scrolling box (a sidebar's list) is no full-window app: the cut-off content beside it is still reported.
  const list = el({ tag: "ul", style: { overflowY: "auto" }, top: 0, bottom: HEIGHT, right: 250, scrollHeight: 2000, clientHeight: HEIGHT }, p(0, 2000));
  const beside = page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT }, list, p(0, 1800, { left: 250 })), { overflowY: "hidden" });
  assert.equal(measured(beside).scroll?.innerScroller, false);
  assert.equal(hintOf(beside)?.contentHeight, 1800);
});

test("a page that fits, or a document that scrolls: nothing", () => {
  assert.equal(hintOf(page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT }, p(0, 790)), { overflowY: "hidden" })), null);
  assert.equal(hintOf(page(el({ tag: "body", top: 0, bottom: 2340 }, p(0, 2340)), { scrollHeight: 2340 })), null);
});

test("not content: hidden things, a sheet waiting below the window, an empty box; a collapsed panel counts to its own bottom", () => {
  const body = el(
    { tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT },
    p(0, 300),
    p(900, 1000, { style: { display: "none" } }),
    p(900, 1100, { style: { opacity: "0" } }),
    p(900, 1200, { style: { visibility: "hidden" } }),
    p(900, 1300, { style: { contentVisibility: "hidden" } }),
    el({ style: { position: "fixed" }, top: HEIGHT, bottom: 1400 }, p(HEIGHT, 1400)),
    el({ tag: "div", top: 0, bottom: 1500 }),
    el({ style: { overflowY: "hidden" }, top: 300, bottom: 340 }, p(340, 1600)),
  );
  const measure = measured(page(body, { overflowY: "hidden" }));
  assert.equal(measure.scroll?.contentBottom, 340, "the panel's text counts down to the panel's bottom");
  assert.equal(hintOf(page(body, { overflowY: "hidden" })), null);
});

test("a fixed root the size of the window: the document has nothing to scroll, the root named", () => {
  const root = el({ id: "root", className: "app", style: { position: "fixed" }, top: 0, bottom: HEIGHT }, el({ className: "content", top: 0, bottom: 2000 }, p(0, 2000)));
  const doc = page(el({ tag: "body", top: 0, bottom: 0 }, root));
  assert.deepEqual(measured(doc).scroll?.holder, { tag: "div", id: "root", className: "app", style: "position: fixed" });
  assert.deepEqual(hintOf(doc)?.heldBy, [{ element: "div#root", style: "position: fixed" }]);
  // An app shell clipping at the window's bottom: named with its overflow.
  const shell = el({ className: "shell wide", style: { overflowY: "clip" }, top: 0, bottom: HEIGHT }, p(0, 2000));
  assert.deepEqual(hintOf(page(el({ tag: "body", top: 0, bottom: HEIGHT }, shell)))?.heldBy, [{ element: "div.shell", style: "overflow: clip" }]);
});

test("its text runs alone, as puppeteer sends it: nothing from the module or a bundle's helpers", () => {
  const text = measurePage.toString();
  assert.ok(!text.includes("__name"), "no kept-name helper inside");
  const doc = page(el({ tag: "body", style: { overflowY: "hidden" }, top: 0, bottom: HEIGHT }, p(0, 2340)), { overflowY: "hidden" });
  const alone = withPage(doc, () => new Function(`return (${text})();`)() as PageMeasure);
  assert.deepEqual(alone, measured(doc));
});
