import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import { setBrowserShowing } from "./browserViews";
import { useNativeViewPlaceholder } from "./useNativeViewPlaceholder";

/**
 * Where the built-in browser's pages show (desktop_web_preview_view_v0, a
 * shell with tabs): one placeholder for every tab, over which the shell lays
 * the native view of the tab in front (browserViews.ts decides which exist
 * and which shows; this only says the browser's panel is on screen, where,
 * and whether an overlay covers it). `children`: what an empty tab shows in
 * the page's place (it has no view).
 */
export function DesktopBrowserView({ bridge, conversationId, tabId, title, children }: {
  bridge: DesktopWebPreviewTabsBridge;
  conversationId: string;
  /** The tab in front: a still taken of another tab is never shown for it. */
  tabId: string;
  title: string;
  children?: ReactNode;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const { covered, snapshot } = useNativeViewPlaceholder(placeholderRef, bridge, tabId);
  // After the box and the visibility above: the view shows where the placeholder is.
  useEffect(() => {
    setBrowserShowing(conversationId, true);
    return () => setBrowserShowing(conversationId, false);
  }, [conversationId]);
  return (
    <div
      ref={placeholderRef}
      className="relative size-full overflow-hidden bg-layer-card"
      aria-label={title}
      role="region"
      data-testid="web-preview-native"
      data-tab={tabId}
      data-covered={covered ? "" : undefined}
    >
      {children ?? (snapshot ? (
        // The still of the page, at the placeholder's size (the shell captured the view at it).
        <img src={snapshot} alt="" className="block size-full object-cover object-left-top" draggable={false} data-testid="web-preview-snapshot" />
      ) : null)}
    </div>
  );
}
