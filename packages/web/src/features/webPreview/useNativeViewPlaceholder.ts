import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { DesktopWebPreviewBounds } from "@botiverse/raft-shared";

import { useOverlayCovers } from "./webPreviewOverlays";

/** What a placeholder needs of the shell: the single view's bridge, or the tabs' (both have these two). */
export interface NativeViewPlacement {
  setBounds(bounds: DesktopWebPreviewBounds): void;
  setVisible(visible: boolean): Promise<string | null>;
}

/**
 * The placeholder a native view of the shell is laid over
 * (desktop_web_preview_view_v0): reports its box (CSS px, relative to the
 * window; the shell applies the page zoom) whenever it resizes, the window
 * resizes or anything scrolls, and keeps the overlay rule: the native view
 * draws above every DOM layer, so while a raft-ui overlay overlaps the
 * placeholder (webPreviewOverlays.ts) the view hides and the placeholder
 * shows the still the shell took of it. Returns whether it is covered and
 * that still. `stillKey` names the page the still is of (the tab): a still
 * of another one is never shown.
 */
export function useNativeViewPlaceholder(
  placeholderRef: RefObject<HTMLElement | null>,
  view: NativeViewPlacement,
  stillKey = "",
): { covered: boolean; snapshot: string | null } {
  const [still, setStill] = useState<{ key: string; image: string } | null>(null);
  // The still is taken when the overlay comes, of the page showing then: the key only labels it.
  const stillKeyRef = useRef(stillKey);
  stillKeyRef.current = stillKey;

  // The placeholder's box → the view's bounds.
  useEffect(() => {
    const element = placeholderRef.current;
    if (!element) return;
    let frame = 0;
    const send = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      view.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(send);
    };
    send();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(element);
    window.addEventListener("resize", schedule);
    // Capture: a scroll in any ancestor moves the placeholder.
    window.addEventListener("scroll", schedule, true);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [placeholderRef, view]);

  // The overlay rule: hidden (with its still shown here) while an overlay overlaps.
  const covered = useOverlayCovers(placeholderRef);
  useEffect(() => {
    let current = true;
    if (covered) {
      void view.setVisible(false).then((image) => {
        if (current) setStill(typeof image === "string" && image.startsWith("data:image/") ? { key: stillKeyRef.current, image } : null);
      }, () => {});
    } else {
      void view.setVisible(true).then(() => {
        if (current) setStill(null);
      }, () => {});
    }
    return () => {
      current = false;
    };
  }, [view, covered]);

  return { covered, snapshot: covered && still && still.key === stillKey ? still.image : null };
}
