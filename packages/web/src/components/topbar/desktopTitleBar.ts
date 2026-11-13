// The desktop app's title bar, from the facts its bridge reports.
//
// Raft Desktop's window has no title bar of its own: on every platform the
// native window controls (macOS traffic lights, Windows / Linux caption
// buttons) are laid over the web's top row under the Window Controls Overlay
// (apps/desktop src/main/windowFrame.ts). That is the web standard the
// installed web app uses too, so the same title-bar rules (titleBar.css) keep
// the bar's content clear of the controls from their real geometry
// (env(titlebar-area-*)). This module only mirrors the bridge's facts onto
// <html> for those rules, and reports the bar's colours back: the caption
// buttons are painted outside the page, so only the web, which owns the
// theme, can tell the shell what to paint them in.

import type { DesktopTitleBarOverlay, RaftDesktopBridge } from "@botiverse/raft-shared";
import { hexFromRgb, onRootThemeChange } from "../../theme/systemBarColor";
import { overlayTitleBarSource } from "./layerGuard";
import { HOST_TITLE_BAR_COMPACT_QUERY, HOST_TITLE_BAR_HEIGHT_PX, HOST_TITLE_BAR_HEIGHT_TOUCH_PX } from "./overlayTitleBar";
import { installWindowControlsOverlayAttributes } from "./windowControlsOverlayGeometry";

type DesktopTitleBarBridge = Pick<RaftDesktopBridge, "titleBar" | "isFullScreen" | "onFullScreenChange" | "window">;

/**
 * Mirrors the window's chrome onto <html> for titleBar.css:
 * - under the overlay, `data-title-bar="overlay"` (+ `data-title-bar-start`
 *   while the controls take the bar's left end: the macOS traffic lights),
 *   exactly as the installed web app does;
 * - `data-title-bar="native"` when the window manager draws a frame instead
 *   (the Linux opt-out): nothing is laid over the bar;
 * - `data-fullscreen` while the window is full screen (macOS hides the traffic
 *   lights and Windows the caption buttons there, so no corner is reserved).
 * Returns a disposer.
 */
export function installDesktopWindowChrome(root: HTMLElement, bridge: DesktopTitleBarBridge, win: Window = window): () => void {
  const removeOverlay = bridge.titleBar === "overlay" ? installWindowControlsOverlayAttributes(root, win) : null;
  if (bridge.titleBar === "native") root.dataset.titleBar = "native";
  const apply = (fullScreen: boolean) => root.toggleAttribute("data-fullscreen", fullScreen);
  let disposed = false;
  // A live event is newer than the initial query's answer: once one arrives,
  // a late initial answer must not overwrite it.
  let sawEvent = false;
  const unsubscribe = bridge.onFullScreenChange?.((value) => { sawEvent = true; apply(value); });
  void bridge.isFullScreen?.().then((value) => { if (!disposed && !sawEvent) apply(value); }, () => {});
  return () => {
    disposed = true;
    unsubscribe?.();
    removeOverlay?.();
    if (root.dataset.titleBar === "native") delete root.dataset.titleBar;
    root.removeAttribute("data-fullscreen");
  };
}

type TitleBarColors = Pick<DesktopTitleBarOverlay, "color" | "symbolColor">;

/** Any CSS colour Chromium can paint (oklch, color(), rgb…) → "#rrggbb" via a 1×1 canvas; null if unavailable or transparent. */
function cssColorToHex(css: string, doc: Document): string | null {
  let context: CanvasRenderingContext2D | null = null;
  try {
    const canvas = doc.createElement("canvas");
    canvas.width = canvas.height = 1;
    context = canvas.getContext?.("2d", { willReadFrequently: true }) ?? null;
  } catch {
    return null;
  }
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = "#000000";
  context.fillStyle = css; // an unparsable value leaves the previous fill
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (alpha === 0) return null;
  return hexFromRgb(red, green, blue);
}

function colorsOf(el: HTMLElement): TitleBarColors | null {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return null;
  const color = cssColorToHex(style.backgroundColor, el.ownerDocument);
  const symbolColor = cssColorToHex(style.color, el.ownerDocument);
  return color && symbolColor ? { color, symbolColor } : null;
}

/**
 * The colours of the row that is the window's title bar right now: a
 * full-window overlay's header while one is open and nothing covers it
 * (overlayTitleBar.ts; the layer guard marks it covered), else the top bar,
 * which is the frame (--layer-frame under --foreground-on-frame, the same
 * tokens the bar and the stand-in strip paint).
 */
function readTitleBarColors(doc: Document): TitleBarColors | null {
  const header = overlayTitleBarSource(doc);
  if (header) return colorsOf(header);
  const probe = doc.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;width:0;height:0;visibility:hidden;pointer-events:none;background-color:var(--layer-frame);color:var(--foreground-on-frame)";
  doc.documentElement.appendChild(probe);
  try {
    return colorsOf(probe);
  } finally {
    probe.remove();
  }
}

type ColorReader = (doc: Document) => TitleBarColors | null;

let defaultReader: ColorReader = readTitleBarColors;

/** Test seam: jsdom has no canvas and no CSS custom properties to resolve colours with. */
export function __setTitleBarColorReaderForTests(reader: ColorReader | null): void {
  defaultReader = reader ?? readTitleBarColors;
}

interface TitleBarOverlayReporter {
  /** Re-read and report if the colours changed (the layer guard calls it when the title-bar row changes). */
  sync(): void;
  dispose(): void;
}

/**
 * Reports the title bar's colours and height to the shell (bridge
 * window.setTitleBarOverlay): now, whenever <html> takes a new mode or server
 * theme (onRootThemeChange: the appearance setting, the OS's
 * prefers-color-scheme under "system", a server theme), and on `sync()` (an
 * overlay title bar opened, closed or got covered). Nothing else re-reads the
 * colours: a busy channel's DOM churn costs nothing here. The height is the
 * web header's: 44px with a mouse, 48px with a coarse pointer (Windows tablet
 * mode), re-sent when the pointer changes. Repeats are dropped.
 */
export function installTitleBarOverlayReport(
  doc: Document,
  send: (overlay: DesktopTitleBarOverlay) => void,
  read: ColorReader = defaultReader,
): TitleBarOverlayReporter {
  let last = "";
  let disposed = false;
  const compact = doc.defaultView?.matchMedia?.(HOST_TITLE_BAR_COMPACT_QUERY) ?? null;
  const sync = () => {
    if (disposed) return;
    const colors = read(doc);
    if (!colors) return;
    const overlay = { color: colors.color, symbolColor: colors.symbolColor, height: compact && !compact.matches ? HOST_TITLE_BAR_HEIGHT_TOUCH_PX : HOST_TITLE_BAR_HEIGHT_PX };
    const key = `${overlay.color}/${overlay.symbolColor}/${overlay.height}`;
    if (key === last) return;
    last = key;
    send(overlay);
  };
  const unsubscribe = onRootThemeChange(sync);
  compact?.addEventListener?.("change", sync);
  sync();
  return {
    sync,
    dispose() {
      disposed = true;
      unsubscribe();
      compact?.removeEventListener?.("change", sync);
    },
  };
}
