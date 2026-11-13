// The installed web app's title bar (Window Controls Overlay).
//
// Installed from a desktop Chromium browser (Chrome, Edge), the web app opens
// in its own window, by default under a title bar the browser draws: one row
// with the app's name and the window controls, then the app's own top bar
// below it. The manifest asks for `window-controls-overlay` instead
// (display_override): the browser drops its title bar and lays the window
// controls (minimize/maximize/close, its own menu, and on macOS the traffic
// lights) over the top of the page, the same way the desktop app's Electron
// window does. The app's top bar is then the window's title bar, as in the
// desktop app: this shell hands it the same flag through TopBarHostContext, and
// the shared title-bar rules (titleBar.css) make it the drag region and keep
// its content clear of the controls.
//
// The overlay is the user's to turn off (the chevron next to the controls puts
// the browser's title bar back) and is gone in full screen; display-mode is
// then `standalone` or `fullscreen` and everything here reverts, with no
// remount: the host only switches between itself and null.
//
// Not in the desktop app (it mounts TitleBarHost itself, with the overlay
// facts from its bridge: desktopTitleBar.ts) or the host-shell embed (the host
// draws the chrome).

import { useLayoutEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { isHostShell } from "../../embed";
import { isElectronDesktopShell } from "../../utils/desktopShell";
import { pinSystemBarSurface } from "../../theme/systemBarColor";
import { TitleBarHost } from "./TitleBarHost";
import type { TopBarHost } from "./topBarHostContext";
import { installWindowControlsOverlayAttributes } from "./windowControlsOverlayGeometry";

export { installWindowControlsOverlayAttributes };

/** Matches only while the browser lays its window controls over the page. */
export const WINDOW_CONTROLS_OVERLAY_QUERY = "(display-mode: window-controls-overlay)";

/** Whether the browser currently lays its window controls over this page. */
export function isWindowControlsOverlayActive(win: Window = window): boolean {
  if (isElectronDesktopShell() || isHostShell()) return false;
  return typeof win.matchMedia === "function" && win.matchMedia(WINDOW_CONTROLS_OVERLAY_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(WINDOW_CONTROLS_OVERLAY_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

const serverSnapshot = () => false;

/** True while the window controls overlay the page (re-renders when the user toggles it). */
export function useWindowControlsOverlay(): boolean {
  return useSyncExternalStore(subscribe, () => isWindowControlsOverlayActive(), serverSnapshot);
}

// desktopWidthOnly: an installed window can be narrower than the desktop
// layout (the desktop app's can't, its minimum width keeps it there), and the
// phone layout has no top bar, so below it the stand-in strip is the title bar.
const HOST: TopBarHost = { titleBar: true, desktopWidthOnly: true };

/**
 * Wraps the app: while the overlay is on, the top bar is the window's title bar
 * (TitleBarHost with `titleBar`: the layer guard keeps it clickable under open
 * menus and dialogs, and pages without the top bar get the stand-in strip, so
 * the window always has a drag region and nothing sits under the controls).
 * Off, it renders its children as they are: a browser tab and a standalone
 * installed window are unchanged.
 */
export function WindowControlsOverlayShell({ children }: { children: ReactNode }) {
  const active = useWindowControlsOverlay();
  useLayoutEffect(() => {
    if (!active) return undefined;
    const removeAttributes = installWindowControlsOverlayAttributes(document.documentElement);
    // The controls' backdrop is theme-color; the row behind them is always the frame.
    const unpin = pinSystemBarSurface("frame");
    return () => {
      unpin();
      removeAttributes();
    };
  }, [active]);
  // The same element tree on and off: toggling the overlay must not remount the app.
  return <TitleBarHost host={active ? HOST : null}>{children}</TitleBarHost>;
}
