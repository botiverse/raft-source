import { useEffect, useState } from "react";
import type { DesktopWebPreviewBridge, DesktopWebPreviewState, DesktopWebPreviewTabListBridge, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY, useServerFeatureFlag, WEB_PREVIEW_FLAG_KEY } from "../../store/serverFeatureFlags";
import { useAuthStore } from "../../store/authStore";
import { getDesktopBridge } from "../../utils/desktopBridge";
import { mirrorBrowserTabsList } from "./browserTabsStore";

/** Whether web preview is on for the current server (web_preview_v0). */
export function useWebPreviewEnabled(): boolean {
  return useServerFeatureFlag(WEB_PREVIEW_FLAG_KEY).enabled;
}

/** Whether the desktop web preview view is on for the current server (desktop_web_preview_view_v0). */
export function useDesktopWebPreviewViewEnabled(): boolean {
  return useServerFeatureFlag(DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY).enabled;
}

/**
 * The desktop shell's native browser view for the web preview, or null: only
 * in Raft Desktop with raftDesktop.webPreview (shells before it lack it) and
 * with desktop_web_preview_view_v0 on. Null: the panel keeps its sandboxed frame.
 */
export function useDesktopWebPreviewView(): DesktopWebPreviewBridge | null {
  const enabled = useDesktopWebPreviewViewEnabled();
  if (!enabled) return null;
  return getDesktopBridge()?.webPreview ?? null;
}

/**
 * The built-in browser's tabs, or null: the native view above on a shell that
 * has `webPreview.tabs`. Null on an older shell (the one page, through the
 * view's own methods), with the flag off and in a browser.
 */
export function useDesktopBrowserTabs(): DesktopWebPreviewTabsBridge | null {
  return useDesktopWebPreviewView()?.tabs ?? null;
}

let followedList: DesktopWebPreviewTabListBridge | null = null;
let unfollowAccount: (() => void) | null = null;

/**
 * The tab store mirrors the shell's list for whoever is signed in, from now
 * on and for the rest of the page's life: it follows the auth store itself,
 * not a component's effect. A sign-out that unmounts the panel in the same
 * commit runs no effect of that panel, and the shell drops the list on every
 * sign-out: the mirror must end then, so that the same account signing in
 * again asks for its list again (the shell hears a page only once it asks).
 */
export function followBrowserTabsAccount(list: DesktopWebPreviewTabListBridge | null): void {
  // An older shell: the store stays the list.
  if (!list) return;
  if (followedList !== list) {
    unfollowAccount?.();
    followedList = list;
    unfollowAccount = useAuthStore.subscribe((state) => mirrorBrowserTabsList(list, state.user?.id ?? null));
  }
  mirrorBrowserTabsList(list, useAuthStore.getState().user?.id ?? null);
}

/**
 * On a shell that keeps the tab list itself (`tabs.list`, #proj-workspace:#295)
 * the tab store mirrors it for the signed-in account, from the first channel
 * panel on (followBrowserTabsAccount). Nothing on an older shell: the store
 * stays the list.
 */
export function useBrowserTabsList(tabs: DesktopWebPreviewTabsBridge | null): void {
  const list = tabs?.list ?? null;
  useEffect(() => {
    followBrowserTabsAccount(list);
  }, [list]);
}

/** The view's page as the shell reports it; null until its first report. */
export function useDesktopWebPreviewState(bridge: DesktopWebPreviewBridge | null): DesktopWebPreviewState | null {
  const [state, setState] = useState<DesktopWebPreviewState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onState(setState);
  }, [bridge]);
  return state;
}
