// The title-bar treatment for full-window overlays (file previews, lightboxes,
// full-screen viewers).
//
// In the desktop app the window is frameless: the macOS traffic lights sit in
// its top-left corner and the Windows caption buttons are drawn over its
// top-right corner. The app's own top bar reserves those corners
// (`data-raft-titlebar`), but an overlay that covers the whole window draws its
// own header at the window's top edge, over that bar, so its file name and
// buttons landed under the lights / caption buttons and the window could not
// be dragged by it.
//
// Same recipe as Slack's file preview: the overlay's header row becomes the
// window's title bar while it is open. Spread these props onto that row:
//   - `data-raft-overlay-titlebar` — the title-bar stylesheet publishes the
//     reserved corners on it (--raft-titlebar-inset-start / -end, only where
//     the platform draws window controls, windowed only) and makes the row a
//     native drag region with its interactive controls opted out;
//   - padding that keeps the row's own side padding but never less than the
//     reserved corner, so content starts after the traffic lights and ends
//     before the caption buttons.
// On the web (no title-bar host) the props are empty: nothing changes.
//
// Surfaces that do not span the window's width (a side sheet) should not
// become the title bar; they start below it instead (`useHostTitleBar`),
// so neither their header nor any page they navigate to can reach the window
// controls.

import { useMemo } from "react";
import type { CSSProperties } from "react";
import { useTopBarHost } from "./topBarHostContext";

/** Marker the title-bar stylesheet (titleBar.css) keys the overlay title bar's insets and drag region off. */
export const OVERLAY_TITLEBAR_ATTR = "data-raft-overlay-titlebar";
/** Marks non-button content of the header that must still get the pointer (a
 * hover tooltip on a truncated file name): the desktop drag region swallows
 * mouse events, so such content opts out of it like the buttons do. */
export const OVERLAY_TITLEBAR_NO_DRAG_ATTR = "data-raft-overlay-titlebar-no-drag";

export interface OverlayTitleBarOptions {
  /** The row's own start padding (px) without window chrome. Default 16. */
  start?: number;
  /** The row's own end padding (px) without window chrome. Default 16. */
  end?: number;
}

export type OverlayTitleBarProps = { [OVERLAY_TITLEBAR_ATTR]?: ""; style?: CSSProperties };

/**
 * Padding for an overlay header that is the window's title bar. Start: the
 * traffic lights carry their own margin (their corner, titlebar-area-x, ends
 * a margin after them), so the row's padding is the larger of the two. End: the caption
 * buttons are flush with the window edge, so the row keeps its own padding
 * after the reserved corner. Both keep the iOS safe-area insets the raft-ui
 * toolbar uses.
 */
export function overlayTitleBarStyle({ start = 16, end = 16 }: OverlayTitleBarOptions = {}): CSSProperties {
  return {
    paddingLeft: `max(calc(${start}px + env(safe-area-inset-left, 0px)), var(--raft-titlebar-inset-start, 0px))`,
    paddingRight: `calc(${end}px + env(safe-area-inset-right, 0px) + var(--raft-titlebar-inset-end, 0px))`,
  };
}

/** The host shell's title bar height: the desktop header (AppTopBar and the desktop's signed-out strip, 32px frame items with 6px above and below). */
export const HOST_TITLE_BAR_HEIGHT_PX = 44;
/** The same header with a coarse pointer (Windows tablet mode) or below 768px: raft-ui's 44px controls with 2px above and below. */
export const HOST_TITLE_BAR_HEIGHT_TOUCH_PX = 48;
/** When the header is the compact desktop one (raft-ui's desktop density). */
export const HOST_TITLE_BAR_COMPACT_QUERY = "(width >= 48rem) and (pointer: fine)";

/** True inside a host shell whose top row is the window's title bar (the desktop app, the installed web app under the Window Controls Overlay). */
export function useHostTitleBar(): boolean {
  return useTopBarHost()?.titleBar === true;
}

/** Props for an overlay's header row; empty outside a title-bar host shell. */
export function useOverlayTitleBar(options: OverlayTitleBarOptions = {}): OverlayTitleBarProps {
  const titleBar = useHostTitleBar();
  const { start, end } = options;
  return useMemo(
    () => (titleBar ? { [OVERLAY_TITLEBAR_ATTR]: "", style: overlayTitleBarStyle({ start, end }) } : {}),
    [titleBar, start, end],
  );
}
