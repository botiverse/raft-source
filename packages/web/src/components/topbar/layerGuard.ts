// Title-bar layer guard (task #121, WAWQAQ 2026-09-24): a frameless window's top
// bar is a native drag region, in the desktop app and in the installed web app
// under the Window Controls Overlay (windowControlsOverlay.tsx). Chromium hands mouse-downs on a drag region to
// the window manager BEFORE the page sees them, so every "click outside to
// dismiss" surface — the ⌘K overlay, dialogs and their backdrops, dropdown /
// context menus, popovers, selects, comboboxes — cannot be dismissed by clicking
// the top bar: the click never reaches the DOM.
//
// Systemic fix rather than per-surface patches: while ANY such layer is open,
// mark <html data-raft-layer-open>; the title-bar stylesheet (titleBar.css) turns the title bar
// into a no-drag region for that time, so the click reaches the backdrop /
// outside-press listener and the layer closes (Slack behaves the same: clicking
// the title bar with the search panel open closes the panel). Dragging comes
// back the moment the layer closes.
//
// "Open layer" = anything that dismisses on an outside press. Three sources,
// because three kinds of code open layers:
//   1. Web-owned surfaces declare themselves: `data-dismiss-layer`
//      (components/ui/dismissLayer.ts — DismissBackdrop /
//      Lightbox roots, ServerSwitcherMenu, SelectionPopover pickers, hand-rolled
//      menus with their own document mousedown listener). The guard cannot
//      infer "a click outside closes this" from the DOM, so the web states it,
//      and a web contract test keeps every outside-press listener marked.
//   2. Anything with role=dialog / alertdialog (dialog cards, Base UI dialogs).
//   3. raft-ui / Base UI controlled popups in their OPEN state: *-content /
//      *-popup / *-overlay / *-backdrop slots carrying data-open. Base UI flips
//      keepMounted popups to data-closed (+ hidden) when closed, so presence
//      alone never counts.
// A candidate under a closed / hidden ancestor (data-closed, hidden,
// aria-hidden="true") is not open, whatever its own attributes say. And an
// explicit opt-out — `data-dismiss-layer="false"` on the element or an
// ancestor — beats every generic fallback: a hover / focus-opened card keeps
// role="dialog" for accessibility but is not an outside-press layer until it
// is pinned (reviewer finding, RuntimeAccountUsageChip).
// Excluded on purpose: tooltips and preview cards (hover-driven — disabling
// drag while hovering a top-bar control would be a regression), toasts (not
// dismissed by outside clicks), and plain disclosure state (sidebar sections,
// accordions, tabs also use data-open but are not layers).

export const LAYER_OPEN_ATTR = "data-raft-layer-open";

/** The surfaces' own declaration (components/ui/dismissLayer.ts). */
export const DISMISS_LAYER_ATTR = "data-dismiss-layer";

/** Explicit "not a dismiss layer" (web `notDismissLayerProps`); wins over roles. */
const EXEMPT_SELECTOR = `[${DISMISS_LAYER_ATTR}="false"]`;

const OPEN_LAYER_SELECTOR = [
  `[${DISMISS_LAYER_ATTR}]:not(${EXEMPT_SELECTOR})`,
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-slot$="-content"][data-open]',
  '[data-slot$="-popup"][data-open]',
  '[data-slot$="-overlay"][data-open]',
  '[data-slot$="-backdrop"][data-open]',
].join(", ");

const IGNORED_ANCESTORS = '[data-slot^="tooltip"], [data-slot^="preview-card"], [data-slot^="toast"]';
const CLOSED_ANCESTORS = '[data-closed], [hidden], [aria-hidden="true"]';

function openLayers(doc: Document): Element[] {
  const open: Element[] = [];
  for (const el of doc.querySelectorAll(OPEN_LAYER_SELECTOR)) {
    if (el.closest(EXEMPT_SELECTOR)) continue;
    if (el.closest(IGNORED_ANCESTORS)) continue;
    if (el.closest(CLOSED_ANCESTORS)) continue;
    open.push(el);
  }
  return open;
}

export function hasOpenLayer(doc: Document = document): boolean {
  return openLayers(doc).length > 0;
}

/**
 * Whether a layer is open over `element`, so a gesture on it waits (the
 * message list's time reveal). A layer it sits in is not over it (a thread in
 * a sheet is not covered by its own sheet), and nor is a part of that layer
 * drawn before it, beside it in the page: its own scrim or backdrop (a
 * raft-ui dialog portals the scrim and then the popup). A layer that comes
 * after it, or inside it, is over it: a menu or a dialog opened on top.
 */
export function hasOpenLayerOver(element: Element): boolean {
  return isUnderLayer(openLayers(element.ownerDocument), element);
}

function isUnderLayer(layers: readonly Element[], element: Element): boolean {
  let own: Element | null = null;
  for (const layer of layers) {
    if (layer.contains(element) && (!own || own.contains(layer))) own = layer;
  }
  return layers.some((layer) => {
    if (layer.contains(element)) return false;
    if (!own || own.contains(layer)) return true;
    return (own.compareDocumentPosition(layer) & own.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
}

/** An overlay header that is the window's title bar (overlayTitleBar.ts). */
export const OVERLAY_TITLEBAR_ATTR = "data-raft-overlay-titlebar";
/** Set on an overlay title bar while a layer outside its own overlay is open. */
export const OVERLAY_TITLEBAR_COVERED_ATTR = "data-raft-overlay-titlebar-covered";

/**
 * Reflect the current layer state on <html>; returns whether a layer is open.
 *
 * A full-window overlay (file preview) is itself an open layer, so the main
 * title bar goes no-drag under it, but its own header row is the window's
 * title bar meanwhile and stays draggable. A layer over it — a menu opened
 * from that header, a second overlay stacked above (hasOpenLayerOver's rule:
 * inside its own layer, or drawn after it) — makes the row "covered": no drag,
 * so a click on it reaches that layer's outside-press listener (the same rule
 * as the main bar, one level down). A layer UNDER the overlay does not: the
 * dialog, sheet or panel a preview was opened from stays open beneath it, and
 * the preview's header must still drag the window (#305: any open layer used
 * to count, so a preview opened from a dialog could not be dragged).
 */
export function syncLayerAttribute(doc: Document = document): boolean {
  const open = openLayers(doc);
  doc.documentElement.toggleAttribute(LAYER_OPEN_ATTR, open.length > 0);
  for (const bar of doc.querySelectorAll(`[${OVERLAY_TITLEBAR_ATTR}]`)) {
    bar.toggleAttribute(OVERLAY_TITLEBAR_COVERED_ATTR, isUnderLayer(open, bar));
  }
  return open.length > 0;
}

/**
 * The overlay header that is the window's title bar right now: the topmost one
 * no other layer covers, or null when the top bar is the title bar.
 */
export function overlayTitleBarSource(doc: Document = document): HTMLElement | null {
  const headers = doc.querySelectorAll<HTMLElement>(`[${OVERLAY_TITLEBAR_ATTR}]:not([${OVERLAY_TITLEBAR_COVERED_ATTR}])`);
  return headers.length ? headers[headers.length - 1] : null;
}

/**
 * Fallback for the coalescing frame: if no animation frame arrives within this
 * long (a hidden, occluded or compositor-starved window), sync anyway.
 */
export const LAYER_SYNC_FALLBACK_MS = 100;

/**
 * Keep <html data-raft-layer-open> in step with the DOM. Coalesces to one sync
 * per animation frame so a burst of DOM changes cannot become a query storm,
 * with a timer fallback: frames are not guaranteed (CI saw rAF starve for >1s
 * in a visible window under load, 2026-10-09), and the title bar's drag region
 * must be right even then. Whichever fires first syncs and cancels the other.
 * `onTitleBarSourceChange` runs only when the row that is the window's title
 * bar changes (an overlay title bar opened, closed, or got covered or
 * uncovered: overlayTitleBarSource), not on every DOM change: the desktop's
 * caption-button colours follow that row, and re-reading them is not free.
 * Returns a disposer.
 */
export function installLayerGuard(doc: Document = document, onTitleBarSourceChange?: () => void): () => void {
  syncLayerAttribute(doc);
  let source = overlayTitleBarSource(doc);
  const win = doc.defaultView;
  if (!win || typeof win.MutationObserver === "undefined") return () => {};
  let frame = 0;
  let timer = 0; // win.setTimeout: a DOM timer id (number), not a Node Timeout
  const cancel = () => {
    if (frame) win.cancelAnimationFrame(frame);
    if (timer) win.clearTimeout(timer);
    frame = 0;
    timer = 0;
  };
  const sync = () => {
    cancel();
    syncLayerAttribute(doc);
    const next = overlayTitleBarSource(doc);
    if (next === source) return;
    source = next;
    onTitleBarSourceChange?.();
  };
  const schedule = () => {
    if (frame || timer) return;
    frame = win.requestAnimationFrame(sync);
    timer = win.setTimeout(sync, LAYER_SYNC_FALLBACK_MS);
  };
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-open", "data-closed", "hidden", "aria-hidden", "role", "data-slot", DISMISS_LAYER_ATTR, OVERLAY_TITLEBAR_ATTR] });
  return () => {
    observer.disconnect();
    cancel();
    doc.documentElement.removeAttribute(LAYER_OPEN_ATTR);
    for (const bar of doc.querySelectorAll(`[${OVERLAY_TITLEBAR_COVERED_ATTR}]`)) bar.removeAttribute(OVERLAY_TITLEBAR_COVERED_ATTR);
  };
}
