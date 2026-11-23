import "./helpers/domSetup";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { syncStyles } from "../src/features/objectWindows/syncStyles";

// #337 object windows: the main window's code draws an object into another
// window's document, with the main window's CSS. syncStyles copies the main
// document's stylesheets and the <html> / <body> attributes the CSS keys off
// (theme class and data-*, lang, dir, the custom properties in style) into the
// object window's document and keeps them in step; never the window's own
// frame (its title bar attributes and --raft-frame-inset-*: PR3, Kirby).

/** The jsdom windows a test made, closed after it. */
const windows: Array<{ close(): void }> = [];

function documentPair(mainHead = "") {
  const main = new JSDOM(`<!doctype html><html lang="en" class="light" data-theme="raft"><head>${mainHead}</head><body class="app"></body></html>`, { url: "https://app.raft.test/" });
  const child = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "https://app.raft.test/" });
  windows.push(main.window, child.window);
  return { from: main.window.document, to: child.window.document };
}

afterEach(() => {
  for (const win of windows.splice(0)) win.close();
});

/** MutationObserver records are delivered after the current task's microtasks. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The copied stylesheets in the object window's head, in order, as text. */
function copiedSheets(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll('link[rel~="stylesheet"], style'), (node) =>
    node.localName === "style" ? `style:${node.textContent}` : `link:${node.getAttribute("href")}`);
}

test("copies the head's stylesheets and links, in order, and the html and body attributes", () => {
  const { from, to } = documentPair('<link rel="stylesheet" href="/assets/index.css"><style>.a{color:red}</style><meta name="x" content="y">');
  const stop = syncStyles(from, to);
  try {
    assert.deepEqual(copiedSheets(to), ["link:/assets/index.css", "style:.a{color:red}"]);
    assert.ok(!to.head.querySelector('meta[name="x"]'), "only stylesheets are copied");
    assert.equal(to.documentElement.getAttribute("class"), "light");
    assert.equal(to.documentElement.getAttribute("lang"), "en");
    assert.equal(to.documentElement.getAttribute("data-theme"), "raft");
    assert.equal(to.body.getAttribute("class"), "app");
  } finally {
    stop();
  }
});

test("keeps the stylesheets in step: added, changed and removed in the main head", async () => {
  const { from, to } = documentPair("<style>.a{color:red}</style>");
  const stop = syncStyles(from, to);
  try {
    const added = from.createElement("style");
    added.textContent = ".b{color:blue}";
    from.head.append(added);
    await settle();
    assert.deepEqual(copiedSheets(to), ["style:.a{color:red}", "style:.b{color:blue}"]);

    added.textContent = ".b{color:green}";
    await settle();
    assert.deepEqual(copiedSheets(to), ["style:.a{color:red}", "style:.b{color:green}"], "a style's text change follows");

    const first = from.head.querySelector("style");
    first?.remove();
    await settle();
    assert.deepEqual(copiedSheets(to), ["style:.b{color:green}"], "a removed sheet goes");

    const link = from.createElement("link");
    link.rel = "stylesheet";
    link.href = "/assets/late.css";
    from.head.prepend(link);
    await settle();
    assert.deepEqual(copiedSheets(to), ["link:/assets/late.css", "style:.b{color:green}"], "in the main head's order");

    link.setAttribute("media", "print");
    await settle();
    assert.equal(to.head.querySelector('link[href="/assets/late.css"]')?.getAttribute("media"), "print", "a link's attributes follow");
  } finally {
    stop();
  }
});

test("mirrors the theme, language and direction on <html> and the body classes; leaves other attributes", async () => {
  const { from, to } = documentPair();
  to.documentElement.setAttribute("id", "own");
  const stop = syncStyles(from, to);
  try {
    from.documentElement.classList.replace("light", "dark");
    from.documentElement.setAttribute("data-density", "compact");
    from.documentElement.setAttribute("dir", "rtl");
    from.documentElement.setAttribute("lang", "ar");
    from.documentElement.style.setProperty("--toast-viewport-bottom", "28px");
    from.documentElement.removeAttribute("data-theme");
    from.body.className = "app phone";
    await settle();
    assert.equal(to.documentElement.getAttribute("class"), "dark");
    assert.equal(to.documentElement.getAttribute("data-density"), "compact");
    assert.equal(to.documentElement.getAttribute("dir"), "rtl");
    assert.equal(to.documentElement.getAttribute("lang"), "ar");
    assert.equal(to.documentElement.style.getPropertyValue("--toast-viewport-bottom"), "28px");
    assert.equal(to.documentElement.hasAttribute("data-theme"), false, "a data-* the main window dropped goes");
    assert.equal(to.documentElement.getAttribute("id"), "own", "not a mirrored attribute");
    assert.equal(to.body.getAttribute("class"), "app phone");
  } finally {
    stop();
  }
});

test("stops following once stopped", async () => {
  const { from, to } = documentPair("<style>.a{}</style>");
  const stop = syncStyles(from, to);
  stop();
  const late = from.createElement("style");
  late.textContent = ".late{}";
  from.head.append(late);
  from.documentElement.className = "dark";
  await settle();
  assert.deepEqual(copiedSheets(to), ["style:.a{}"]);
  assert.equal(to.documentElement.getAttribute("class"), "light");
});

test("the input modality stays each window's own, and attributes the object window sets on its <html> stay", async () => {
  const { from, to } = documentPair();
  to.documentElement.setAttribute("data-object-kind", "artifact");
  to.documentElement.setAttribute("data-input-modality", "keyboard");
  from.documentElement.setAttribute("data-input-modality", "pointer");
  const stop = syncStyles(from, to);
  try {
    assert.equal(to.documentElement.getAttribute("data-input-modality"), "keyboard", "not the main window's pointer");
    from.documentElement.setAttribute("data-input-modality", "keyboard");
    from.documentElement.removeAttribute("data-input-modality");
    from.documentElement.setAttribute("data-density", "compact");
    await settle();
    assert.equal(to.documentElement.getAttribute("data-input-modality"), "keyboard", "the main window dropping it removes nothing here");
    assert.equal(to.documentElement.getAttribute("data-object-kind"), "artifact", "never mirrored, never removed");
    assert.equal(to.documentElement.getAttribute("data-density"), "compact");

    from.documentElement.removeAttribute("data-density");
    await settle();
    assert.equal(to.documentElement.hasAttribute("data-density"), false, "what was mirrored goes when the main window drops it");
    assert.equal(to.documentElement.getAttribute("data-object-kind"), "artifact");
  } finally {
    stop();
  }
});

test("the window's own frame is never mirrored: its title bar attributes and frame insets stay the object window's", async () => {
  const { from, to } = documentPair();
  // The object window's own frame (objectWindowChrome.ts sets these from its own overlay).
  to.documentElement.setAttribute("data-title-bar", "overlay");
  to.documentElement.style.setProperty("--raft-desktop-titlebar-start", "78px");
  from.documentElement.setAttribute("data-title-bar", "native");
  from.documentElement.setAttribute("data-title-bar-start", "overlay");
  from.documentElement.setAttribute("data-title-bar-steady", "");
  from.documentElement.setAttribute("data-fullscreen", "");
  from.documentElement.setAttribute("data-raft-layer-open", "");
  from.documentElement.style.setProperty("--raft-frame-inset-start", "80px");
  from.documentElement.style.setProperty("--raft-frame-inset-end", "138px");
  from.documentElement.style.setProperty("--raft-frame-inset-top", "44px");
  from.documentElement.style.setProperty("--raft-desktop-titlebar-start", "70px");
  from.documentElement.style.setProperty("--search-anchor-top", "6px");
  const stop = syncStyles(from, to);
  try {
    await settle();
    const html = to.documentElement;
    assert.equal(html.getAttribute("data-title-bar"), "overlay", "its own, not the main window's native");
    assert.equal(html.hasAttribute("data-title-bar-start"), false);
    assert.equal(html.hasAttribute("data-title-bar-steady"), false);
    assert.equal(html.hasAttribute("data-fullscreen"), false);
    assert.equal(html.hasAttribute("data-raft-layer-open"), false, "a layer open in the main window keeps this one's title bar a drag region");
    assert.equal(html.style.getPropertyValue("--raft-frame-inset-start"), "");
    assert.equal(html.style.getPropertyValue("--raft-frame-inset-end"), "");
    assert.equal(html.style.getPropertyValue("--raft-frame-inset-top"), "");
    assert.equal(html.style.getPropertyValue("--raft-desktop-titlebar-start"), "78px", "its own corner stays");
    assert.equal(html.style.getPropertyValue("--search-anchor-top"), "6px", "any other property is mirrored");

    from.documentElement.style.removeProperty("--search-anchor-top");
    from.documentElement.style.setProperty("--raft-frame-inset-start", "0px");
    from.documentElement.removeAttribute("data-title-bar");
    await settle();
    assert.equal(html.style.getPropertyValue("--search-anchor-top"), "", "a mirrored property the main window dropped goes");
    assert.equal(html.style.getPropertyValue("--raft-desktop-titlebar-start"), "78px");
    assert.equal(html.getAttribute("data-title-bar"), "overlay", "the main window dropping its own removes nothing here");
  } finally {
    stop();
  }
});
