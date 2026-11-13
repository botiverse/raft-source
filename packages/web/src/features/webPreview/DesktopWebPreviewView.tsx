import { useEffect, useRef } from "react";
import type { DesktopWebPreviewBridge } from "@botiverse/raft-shared";

import { useNativeViewPlaceholder } from "./useNativeViewPlaceholder";

/**
 * The desktop web preview view (desktop_web_preview_view_v0): in Raft
 * Desktop the page shows in a real browser view the shell lays over this
 * placeholder (apps/desktop main/webPreviewView.ts), since most sites refuse
 * to be framed. The placeholder reports its box (CSS px, relative to the
 * window; the shell applies the page zoom) whenever it resizes, the window
 * resizes or anything scrolls. Refresh, Back and Forward are the head's
 * (WebPreviewPanel), straight to the bridge. The native view draws above every DOM layer,
 * so while a raft-ui overlay overlaps the placeholder (webPreviewOverlays.ts)
 * the view hides and the placeholder shows the still the shell took of it
 * (useNativeViewPlaceholder, shared with the built-in browser's tabs). This
 * is the one page of a shell without tabs (DesktopBrowserView is theirs).
 */

export function DesktopSiteView({ bridge, url, title }: { bridge: DesktopWebPreviewBridge; url: string; title: string }) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  // One view per window: opened with the page, closed with the panel.
  useEffect(() => {
    bridge.open(url);
    return () => bridge.close();
  }, [bridge, url]);

  const { covered, snapshot } = useNativeViewPlaceholder(placeholderRef, bridge);

  return (
    <div
      ref={placeholderRef}
      className="relative size-full overflow-hidden bg-layer-card"
      aria-label={title}
      role="region"
      data-testid="web-preview-native"
      data-covered={covered ? "" : undefined}
    >
      {snapshot ? (
        // The still of the page, at the placeholder's size (the shell captured the view at it).
        <img src={snapshot} alt="" className="block size-full object-cover object-left-top" draggable={false} data-testid="web-preview-snapshot" />
      ) : null}
    </div>
  );
}
