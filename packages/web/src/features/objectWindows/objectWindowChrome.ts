// An object window's own frame on its <html>, for titleBar.css (#337 PR3,
// Kirby): the shell gives each object window the main window's frame (the
// hidden title bar with the macOS traffic lights, or the caption-button
// overlay on Windows / Linux: apps/desktop main/objectWindows.ts
// objectWindowOptions), and draws those controls on THAT window. Where they
// sit is that window's Window Controls Overlay geometry, read in its own
// document (env(titlebar-area-*) there, its own navigator.windowControlsOverlay),
// so the attributes titleBar.css keys the frame insets off are set here from
// the object window, never mirrored from the main window's <html>
// (syncStyles leaves data-title-bar*, data-fullscreen and the
// --raft-frame-inset-* properties alone). An object's head row that marks
// itself `data-raft-titlebar` (the Artifact window's) is then padded clear of
// the controls and is the window's drag region, as the main top bar is.
//
// `data-fullscreen` is that window's own full screen too (macOS hides its
// traffic lights there, Windows / Linux its caption buttons, so titleBar.css
// reserves no corner, as in the main window: desktopTitleBar.ts). Its document
// cannot tell (it has no bridge, and Electron gives a page no display-mode for
// a native full-screen window), so the shell sends each object window's enter
// and leave full screen to the main window's web app by frame name (bridge
// objectWindows.onFullScreenChange, installObjectWindowFullScreen).
//
// The window controls take that row's look (installObjectWindowTitleBarReport):
// its background and icon colour for the Windows / Linux caption buttons, its
// height for them and for the macOS traffic lights' row, reported from the
// object window's own document, never the main window's frame colours (the
// yellow frame is the main window's top bar only).

import type { DesktopTitleBarOverlay, RaftDesktopBridge } from "@botiverse/raft-shared";
import { titleBarRowColors } from "../../components/topbar/desktopTitleBar";
import { OVERLAY_TITLEBAR_ATTR, OVERLAY_TITLEBAR_COVERED_ATTR, overlayTitleBarSource } from "../../components/topbar/layerGuard";
import { installSteadyMacTitleBarArea, installWindowControlsOverlayAttributes } from "../../components/topbar/windowControlsOverlayGeometry";

export type ObjectWindowFrameFacts = Pick<RaftDesktopBridge, "titleBar" | "platform">;

/**
 * Mirror the object window `win`'s own frame onto `root` (its <html>):
 * `data-title-bar="overlay"` (+ `data-title-bar-start` while its controls
 * take the left end, and on macOS the steady traffic-light corner) under the
 * overlay, `data-title-bar="native"` when a window manager frames it. Nothing
 * without a shell. Returns the stop.
 */
export function installObjectWindowChrome(root: HTMLElement, win: Window, facts: ObjectWindowFrameFacts | null | undefined): () => void {
  if (!facts) return () => {};
  if (facts.titleBar === "native") {
    root.dataset.titleBar = "native";
    return () => {
      if (root.dataset.titleBar === "native") delete root.dataset.titleBar;
    };
  }
  if (facts.titleBar !== "overlay") return () => {};
  const removeOverlay = installWindowControlsOverlayAttributes(root, win);
  const removeSteady = facts.platform === "darwin" ? installSteadyMacTitleBarArea(root, win) : null;
  return () => {
    removeSteady?.();
    removeOverlay();
  };
}

export type ObjectWindowFullScreenFacts = Pick<RaftDesktopBridge, "objectWindows">;

/**
 * `data-fullscreen` on `root` (the object window `name`'s <html>) while THAT window is full screen, from the shell
 * (bridge objectWindows.onFullScreenChange; never the main window's state). Nothing without a shell or on one that
 * predates it (its object windows keep the corners reserved in full screen). Returns the stop.
 */
export function installObjectWindowFullScreen(root: HTMLElement, name: string, facts: ObjectWindowFullScreenFacts | null | undefined): () => void {
  const unsubscribe = facts?.objectWindows?.onFullScreenChange?.((frameName, fullScreen) => {
    if (frameName === name) root.toggleAttribute("data-fullscreen", fullScreen);
  });
  if (!unsubscribe) return () => {};
  return () => {
    unsubscribe();
    root.removeAttribute("data-fullscreen");
  };
}

/** The object's head row that marks itself the window's title bar (artifactWindowTitleBar.ts). */
const TITLE_BAR_ROW_ATTR = "data-raft-titlebar";
/** The shell takes a title bar 24 to 96 CSS px tall (apps/desktop main/windowFrame.ts parseTitleBarOverlay). */
const MIN_TITLE_BAR_HEIGHT = 24;
const MAX_TITLE_BAR_HEIGHT = 96;
/** As the layer guard: if no animation frame comes within this long (a hidden window), sync anyway. */
const SYNC_FALLBACK_MS = 100;

/**
 * The row that is the object window's title bar now: a full-window overlay's header open in it and not covered
 * (overlayTitleBar.ts), else the object's own head row; null before the object has drawn one.
 */
export function objectWindowTitleBarRow(doc: Document): HTMLElement | null {
  return overlayTitleBarSource(doc) ?? doc.querySelector<HTMLElement>(`[${TITLE_BAR_ROW_ATTR}]`);
}

/**
 * The window controls' height for `row`, in CSS px: down to the top of its bottom border (the head's seam), not
 * over it. The controls' area is painted in the row's colour, and covering the seam there cut the line short under
 * the buttons (Kirby, #proj-workspace:#337); this way the page's own seam runs across the whole width. On macOS the
 * traffic lights centre on it to the same place (centredTrafficLightY: 15 for a 44px head, 13 for 40px).
 */
export function titleBarOverlayHeight(row: HTMLElement): number {
  const seam = Number.parseFloat(row.ownerDocument.defaultView?.getComputedStyle(row).borderBottomWidth ?? "") || 0;
  return Math.round(row.getBoundingClientRect().height) - Math.ceil(seam);
}

/** The overlay `row` asks for: its background and text colour, and its height in CSS px; null when unreadable. */
function overlayOf(row: HTMLElement): DesktopTitleBarOverlay | null {
  const colors = titleBarRowColors(row);
  const height = titleBarOverlayHeight(row);
  if (!colors || height < MIN_TITLE_BAR_HEIGHT || height > MAX_TITLE_BAR_HEIGHT) return null;
  return { color: colors.color, symbolColor: colors.symbolColor, height };
}

/**
 * Report the object window's title-bar row (objectWindowTitleBarRow) to `send`: its colours and height, now and
 * whenever they may have changed:
 * - another row becomes the title bar (the placeholder's head replaced by the loaded viewer's, an overlay title bar
 *   opened, closed, covered);
 * - the theme changes in this document (syncStyles mirrors the main window's <html> attributes and stylesheets here,
 *   so the change is read after it reached this window, not on the main window's own change), or the window enters
 *   or leaves full screen (data-fullscreen on its <html>, installObjectWindowFullScreen);
 * - the row is resized (a pointer change or a short window changing its height; a narrow window, where the head
 *   takes the frame's colours, changing its width).
 * Body changes only look for another row (a busy viewer's DOM churn reads no colours). Coalesced to one sync per
 * animation frame, with a timer fallback; repeats are dropped. Returns the stop.
 */
export function installObjectWindowTitleBarReport(doc: Document, send: (overlay: DesktopTitleBarOverlay) => void): () => void {
  const win = doc.defaultView;
  if (!win || typeof win.MutationObserver === "undefined") return () => {};
  let row: HTMLElement | null = null;
  let last = "";
  let restyled = true;
  let frame = 0;
  let timer = 0;
  const report = () => {
    const overlay = row ? overlayOf(row) : null;
    if (!overlay) return;
    const key = `${overlay.color}/${overlay.symbolColor}/${overlay.height}`;
    if (key === last) return;
    last = key;
    send(overlay);
  };
  const resize = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => report()) : null;
  const cancel = () => {
    if (frame) win.cancelAnimationFrame(frame);
    if (timer) win.clearTimeout(timer);
    frame = 0;
    timer = 0;
  };
  const sync = () => {
    cancel();
    const next = objectWindowTitleBarRow(doc);
    const moved = next !== row;
    if (moved) {
      if (row) resize?.unobserve(row);
      row = next;
      if (row) resize?.observe(row);
    }
    if (!moved && !restyled) return;
    restyled = false;
    report();
  };
  const schedule = () => {
    if (frame || timer) return;
    frame = win.requestAnimationFrame(sync);
    timer = win.setTimeout(sync, SYNC_FALLBACK_MS);
  };
  const restyle = () => {
    restyled = true;
    schedule();
  };
  const themeObserver = new win.MutationObserver(restyle);
  themeObserver.observe(doc.documentElement, { attributes: true });
  themeObserver.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true });
  const rowObserver = new win.MutationObserver(schedule);
  rowObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: [TITLE_BAR_ROW_ATTR, OVERLAY_TITLEBAR_ATTR, OVERLAY_TITLEBAR_COVERED_ATTR] });
  sync();
  return () => {
    cancel();
    themeObserver.disconnect();
    rowObserver.disconnect();
    resize?.disconnect();
  };
}

export type ObjectWindowTitleBarFacts = Pick<RaftDesktopBridge, "titleBar" | "platform" | "objectWindows">;

/**
 * Report the object window `name`'s title-bar row to the shell (bridge objectWindows.setTitleBarOverlay), under the
 * Window Controls Overlay: the caption buttons' colours and height on Windows / Linux, the traffic lights' row on
 * macOS. Nothing without a shell, under a window manager's frame, or on a shell that predates the report (its object
 * windows keep the main window's colours). Returns the stop.
 */
export function installObjectWindowTitleBarReporting(doc: Document, name: string, facts: ObjectWindowTitleBarFacts | null | undefined): () => void {
  const objectWindows = facts?.objectWindows;
  if (facts?.titleBar !== "overlay" || !objectWindows?.setTitleBarOverlay) return () => {};
  return installObjectWindowTitleBarReport(doc, (overlay) => objectWindows.setTitleBarOverlay?.(name, overlay));
}
