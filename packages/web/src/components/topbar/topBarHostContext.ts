// The entry point a host shell uses to take part in the web's top bar.
//
// The desktop app runs the web app in a window without a title bar of its
// own. It wraps the app in the web's `TitleBarHost` (TitleBarHost.tsx) and
// hands over the few things only it has: history controls, its update pill,
// and the fact that the row is the window's title bar. With a host present the
// web shows its top bar inside that shell too, at any width, because the row
// is also the window's drag region; off server pages the web draws its own
// stand-in strip (StandInTitleBar).
//
// Without a provider nothing changes: a browser tab keeps the plain web bar.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface TopBarHost {
  /**
   * The host has no browser Back / Forward: the bar shows its own ‹ › and
   * History menu next to the search field (where the Navigation API exists).
   */
  historyControls?: boolean;
  /** Rendered at the start of the right region, before the web's own actions (update pill). */
  trailingStart?: ReactNode;
  /** The row is the window's title bar: it carries `data-raft-titlebar` for the shell's drag region and insets. */
  titleBar?: boolean;
  /**
   * Show the bar at desktop width only, as the plain web does. For a shell
   * whose window can be narrower than the desktop layout (the installed web
   * app): there the phone layout takes over, and the stand-in strip is the
   * title bar while the bar is absent. Without it the bar shows at any width.
   */
  desktopWidthOnly?: boolean;
  /** The modifier of the shell's "switch to workspace N" shortcut, for the strip's tooltips. */
  workspaceShortcutModifier?: string | null;
}

export const TopBarHostContext = createContext<TopBarHost | null>(null);

/**
 * Web-internal: the top bar tells TitleBarHost it is mounted (true) and gone
 * (false). The bar only exists on server pages (MainLayout); while it is absent
 * (sign-in, onboarding, the server picker) a title-bar host draws the stand-in
 * strip so the window keeps a drag region.
 */
export const TopBarMountedContext = createContext<((mounted: boolean) => void) | null>(null);

export function useTopBarHost(): TopBarHost | null {
  return useContext(TopBarHostContext);
}

/**
 * Web-internal: the top bar's trailing region's room with the search field at
 * its base width (useElasticSearch), negative when its items run over the
 * field; undefined before the bar has measured (or without layout). An item
 * that can be shorter (the web's Update button) reads it to choose its form.
 */
export const TopBarTrailingRoomContext = createContext<number | undefined>(undefined);
