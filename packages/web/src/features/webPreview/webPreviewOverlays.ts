import { useCallback, useSyncExternalStore } from "react";
import type { RefObject } from "react";

/**
 * The overlay rule of the desktop web preview view
 * (desktop_web_preview_view_v0): the shell's native view always draws above
 * the page, so a raft-ui popover, menu, select, tooltip, preview card,
 * dialog, drawer, lightbox or toast that overlaps the panel's placeholder
 * would be hidden under it. While one does, the panel hides the view and
 * shows a still of the page in its place, then shows the view again.
 *
 * How it is found: raft-ui marks the portal container of every overlay with
 * `data-raft-ui-overlay` (its isInsideOverlay contract). An overlay counts
 * while something in that container is open or closing (Base UI's
 * `data-open` / `data-ending-style`, or a toast) and its box intersects the
 * placeholder's. A document-level MutationObserver (nodes added or removed,
 * those attributes) re-checks on the next frame, and once more shortly after
 * (a popup is positioned after it mounts). Overlays not drawn by raft-ui
 * (an app's own createPortal) are not seen.
 */
export const OVERLAY_PORTAL_SELECTOR = "[data-raft-ui-overlay]";
const OPEN_SURFACE_SELECTOR = "[data-open], [data-ending-style], [data-slot='toast']";
/** The second look, after the overlay's positioner has placed it. */
const SETTLE_RECHECK_MS = 120;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Whether an open raft-ui overlay's surface overlaps `target` (an overlay containing `target` itself does not count). */
export function overlayCovers(target: Element, doc: Document = target.ownerDocument): boolean {
  const box = target.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  for (const portal of doc.querySelectorAll(OVERLAY_PORTAL_SELECTOR)) {
    if (portal.contains(target)) continue;
    for (const surface of portal.querySelectorAll(OPEN_SURFACE_SELECTOR)) {
      const rect = surface.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && intersects(rect, box)) return true;
    }
  }
  return false;
}

/**
 * Whether an open raft-ui overlay overlaps the element in `ref` (re-checked
 * as overlays open, move and close): an external store over the document,
 * read with useSyncExternalStore.
 */
export function useOverlayCovers(ref: RefObject<Element | null>): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const notify = () => {
      frame = 0;
      onChange();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(notify);
      clearTimeout(settle);
      settle = setTimeout(notify, SETTLE_RECHECK_MS);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-open", "data-ending-style", "data-raft-ui-overlay"],
    });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, []);
  const read = useCallback(() => (ref.current ? overlayCovers(ref.current) : false), [ref]);
  return useSyncExternalStore(subscribe, read, () => false);
}
