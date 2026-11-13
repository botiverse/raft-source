import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { LAYER_OPEN_ATTR, LAYER_SYNC_FALLBACK_MS, OVERLAY_TITLEBAR_COVERED_ATTR, hasOpenLayer, installLayerGuard, syncLayerAttribute } from "../src/components/topbar/layerGuard";

// Task #121: while a dismiss-on-outside layer is open the title bar must stop
// being a native drag region (titleBar.css keys off this attribute, in the
// desktop app and the installed web app alike),
// otherwise clicks on the bar are swallowed by the window manager and the
// layer cannot be dismissed there.

function dom(body: string) {
  return new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url: "https://localhost/", pretendToBeVisual: true });
}

test("recognises every dismiss-on-outside layer and ignores non-layers", () => {
  const cases: Array<[string, boolean, string]> = [
    // 1. web-declared layers (data-dismiss-layer): DismissBackdrop / Lightbox
    //    roots, ServerSwitcherMenu, SelectionPopover, hand-rolled menus
    ['<div data-slot="dismiss-backdrop" data-dismiss-layer=""></div>', true, "web DismissBackdrop"],
    ['<div data-slot="popover-content" data-dismiss-layer="" data-testid="server-switcher-menu"></div>', true, "workspace menu = static PopoverPopup + own mousedown listener, declared"],
    ['<div data-slot="popover-content" data-testid="server-switcher-menu"></div>', false, "an UNdeclared static PopoverPopup is not assumed open (no controlled state to read)"],
    ['<div class="fixed inset-0 bg-black/75" data-dismiss-layer=""></div>', true, "web Lightbox backdrop (no role, declared)"],
    ['<div role="dialog" data-dismiss-layer=""></div>', true, "pinned runtime-usage card (dialog + declared)"],
    ['<div role="dialog" data-dismiss-layer="false"></div>', false, "hover/focus-opened runtime-usage card: role=dialog but explicitly NOT a dismiss layer"],
    ['<div data-dismiss-layer="false"><div role="dialog"></div><div data-slot="popover-content" data-open></div></div>', false, "opt-out on an ancestor covers dialogs and open popups inside it"],
    ['<div role="dialog" data-dismiss-layer="" data-testid="desktop-search-overlay"></div>', true, "⌘K overlay card"],
    // 2. dialogs by role
    ['<div role="dialog"></div>', true, "dialog card"],
    ['<div data-slot="dialog-portal"><div role="dialog" data-closed="" hidden></div></div>', false, "keepMounted dialog in its CLOSED state (data-closed + hidden) is not open"],
    ['<div aria-hidden="true"><div role="dialog"></div></div>', false, "dialog under an aria-hidden ancestor is not open"],
    ['<div role="alertdialog"></div>', true, "alert dialog"],
    ['<div data-slot="dropdown-menu-portal"><div data-slot="dropdown-menu-content" data-open></div></div>', true, "open dropdown menu"],
    ['<div data-slot="popover-content" data-open></div>', true, "open popover"],
    ['<div data-slot="select-content" data-open></div>', true, "open select"],
    ['<div data-slot="dialog-overlay" data-open></div>', true, "Base UI dialog overlay"],
    ['<div data-slot="drawer-popup" data-open></div>', true, "open drawer"],
    ['<div data-slot="dropdown-menu-content" data-closed></div>', false, "closed (keepMounted) menu"],
    ['<div data-slot="tooltip-portal"><div data-slot="tooltip-content" data-open></div></div>', false, "tooltip (hover) must not count"],
    ['<div data-slot="preview-card-content" data-open></div>', false, "preview card (hover) must not count"],
    ['<div data-slot="toast-content" data-open></div>', false, "toast is not outside-dismissed"],
    ['<div data-slot="sidebar-section" data-open><button>Channels</button></div>', false, "disclosure state is not a layer"],
    ['<div data-open>…</div>', false, "bare data-open (tabs/accordion) is not a layer"],
    ['<div></div>', false, "nothing open"],
  ];
  for (const [html, expected, label] of cases) {
    const d = dom(html);
    assert.equal(hasOpenLayer(d.window.document), expected, label);
    d.window.close();
  }
});

test("syncLayerAttribute reflects the state on <html>", () => {
  const d = dom('<div id="host"></div>');
  const doc = d.window.document;
  assert.equal(syncLayerAttribute(doc), false);
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), false);
  doc.getElementById("host")!.innerHTML = '<div role="dialog"></div>';
  assert.equal(syncLayerAttribute(doc), true);
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), true);
  d.window.close();
});

test("installLayerGuard follows DOM changes (open → attribute, close → cleared) and disposes cleanly", async () => {
  const d = dom('<div id="host"></div>');
  const doc = d.window.document;
  const dispose = installLayerGuard(doc);
  const tick = () => new Promise<void>((r) => d.window.requestAnimationFrame(() => r()));
  doc.getElementById("host")!.innerHTML = '<div data-slot="popover-content" data-open></div>';
  await tick(); await tick();
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), true, "opened popover flags the layer");
  doc.querySelector('[data-slot="popover-content"]')!.removeAttribute("data-open");
  doc.querySelector('[data-slot="popover-content"]')!.setAttribute("data-closed", "");
  await tick(); await tick();
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), false, "closing clears it");
  doc.getElementById("host")!.innerHTML = '<div role="dialog"></div>';
  await tick(); await tick();
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), true);
  dispose();
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), false, "dispose removes the attribute");
  d.window.close();
});

test("without animation frames (hidden / starved window) the guard still syncs via its timer fallback", async () => {
  const d = dom('<div id="host"></div>');
  const doc = d.window.document;
  // Frames never arrive — the CI 2026-10-09 state (rAF starved, window visible).
  d.window.requestAnimationFrame = (() => 1) as typeof d.window.requestAnimationFrame;
  d.window.cancelAnimationFrame = () => {};
  const dispose = installLayerGuard(doc);
  doc.getElementById("host")!.innerHTML = '<div data-slot="dropdown-menu-content" data-open></div>';
  await new Promise((r) => setTimeout(r, LAYER_SYNC_FALLBACK_MS + 50));
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), true, "the timer fallback flagged the open menu");
  doc.getElementById("host")!.innerHTML = "";
  await new Promise((r) => setTimeout(r, LAYER_SYNC_FALLBACK_MS + 50));
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), false, "and cleared it after close");
  dispose();
  d.window.close();
});

// File previews (2026-10-20): the preview's header is the window's title bar
// while it is open, so it stays a drag region although the preview itself is
// an open layer — unless another layer is open above it (a menu from the
// header, a second overlay), when a click on the row must reach that layer.
test("an overlay title bar is covered only by a layer outside its own overlay", () => {
  const d = dom(`<div id="preview" data-dismiss-layer=""><div id="bar" data-raft-overlay-titlebar=""><button>Close</button></div><div id="slot"></div></div><div id="outside"></div>`);
  const doc = d.window.document;
  const bar = doc.getElementById("bar")!;
  assert.equal(syncLayerAttribute(doc), true, "the preview is an open layer");
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), false, "its own overlay does not cover it");
  doc.getElementById("slot")!.innerHTML = '<div data-slot="dropdown-menu-content" data-open></div>';
  syncLayerAttribute(doc);
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), true, "a menu portaled into the preview covers it");
  doc.getElementById("slot")!.innerHTML = '<div data-slot="tooltip-portal"><div data-slot="tooltip-content" data-open></div></div>';
  syncLayerAttribute(doc);
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), false, "a hover tooltip does not");
  doc.getElementById("outside")!.innerHTML = '<div data-dismiss-layer=""></div>';
  syncLayerAttribute(doc);
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), true, "a second overlay above covers it");
  doc.getElementById("outside")!.innerHTML = "";
  syncLayerAttribute(doc);
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), false);
  d.window.close();
});

// #305: a preview opened from a dialog, sheet or panel leaves that layer open
// beneath it (drawn before it). That layer is under the preview, not over it,
// so the preview's header stays the window's drag region.
test("a layer under the overlay (drawn before it) does not cover its title bar", () => {
  const d = dom(`<div data-slot="dialog-popup" role="dialog" data-open=""></div><div data-slot="lightbox-backdrop" data-open=""></div><div id="preview" data-dismiss-layer=""><div id="bar" data-raft-overlay-titlebar=""></div></div>`);
  const doc = d.window.document;
  const bar = doc.getElementById("bar")!;
  syncLayerAttribute(doc);
  assert.equal(doc.documentElement.hasAttribute(LAYER_OPEN_ATTR), true, "the main title bar still stops dragging");
  assert.equal(bar.hasAttribute(OVERLAY_TITLEBAR_COVERED_ATTR), false, "the dialog under the preview and the preview's own scrim do not cover its header");
  d.window.close();
});

test("the title-bar change hook fires only when the row that is the title bar changes, not on every DOM change", async () => {
  const d = dom('<div id="feed"></div><div id="overlays"></div>');
  const doc = d.window.document;
  let changes = 0;
  const dispose = installLayerGuard(doc, () => { changes += 1; });
  const tick = () => new Promise<void>((r) => d.window.requestAnimationFrame(() => r()));
  const settle = async () => { await tick(); await tick(); };
  for (let i = 0; i < 5; i++) {
    doc.getElementById("feed")!.insertAdjacentHTML("beforeend", `<p data-open>message ${i}</p>`);
    await settle();
  }
  doc.getElementById("feed")!.insertAdjacentHTML("beforeend", '<div role="dialog"></div>');
  await settle();
  doc.querySelector('#feed [role="dialog"]')!.remove();
  await settle();
  assert.equal(changes, 0, "messages and a layer over the top bar leave the top bar the title bar");
  doc.getElementById("overlays")!.innerHTML = '<div data-dismiss-layer=""><div id="bar" data-raft-overlay-titlebar=""></div></div>';
  await settle();
  assert.equal(changes, 1, "a preview's header became the title bar");
  doc.getElementById("feed")!.insertAdjacentHTML("beforeend", "<p>another message</p>");
  await settle();
  assert.equal(changes, 1);
  // A layer opened above the preview (after it), not one under it (#305).
  doc.getElementById("overlays")!.insertAdjacentHTML("beforeend", '<div id="menu" role="dialog"></div>');
  await settle();
  assert.equal(changes, 2, "covered: the top bar is the title bar again");
  doc.getElementById("menu")!.remove();
  await settle();
  assert.equal(changes, 3, "uncovered");
  doc.getElementById("overlays")!.innerHTML = "";
  await settle();
  assert.equal(changes, 4, "closed");
  dispose();
  d.window.close();
});
