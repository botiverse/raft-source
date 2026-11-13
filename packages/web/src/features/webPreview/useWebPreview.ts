import { useEffect, useState } from "react";
import type { DesktopWebPreviewBridge, DesktopWebPreviewState, DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";
import { DESKTOP_WEB_PREVIEW_VIEW_FLAG_KEY, useServerFeatureFlag, WEB_PREVIEW_FLAG_KEY } from "../../store/serverFeatureFlags";
import { getDesktopBridge } from "../../utils/desktopBridge";

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

/** The view's page as the shell reports it; null until its first report. */
export function useDesktopWebPreviewState(bridge: DesktopWebPreviewBridge | null): DesktopWebPreviewState | null {
  const [state, setState] = useState<DesktopWebPreviewState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    return bridge.onState(setState);
  }, [bridge]);
  return state;
}
