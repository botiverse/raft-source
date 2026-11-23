import type { RefObject } from "react";
import { useLayoutEffect, useState } from "react";
import { OTTER_DOCK_ATTR, contentBand, findDockPane, placeDock } from "./assistantOtterDock";
import type { DockPlacement, OtterDock, OtterSize } from "./assistantOtterDock";

/**
 * Where a dock puts the otter now: null while its pane is not on screen (it
 * then lies on its composer). Measured again when the pane, an adjacent pane
 * in the same layout (e.g. a sidebar or thread panel resizing), or the window
 * changes size, and after a layout transition (a sidebar sliding).
 */
export function useDockPlacement(
  dock: OtterDock | null,
  size: OtterSize,
  anchorRef: RefObject<HTMLSpanElement | null>,
): DockPlacement | null {
  const [placement, setPlacement] = useState<DockPlacement | null>(null);
  useLayoutEffect(() => {
    if (!dock) {
      setPlacement(null);
      return;
    }
    let pane = findDockPane(dock.pane);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    let mutations: MutationObserver | null = null;
    let observedParent: Element | null = null;

    function syncPane(): boolean {
      if (pane && pane.isConnected) return false;
      const nextPane = findDockPane(dock!.pane);
      if (nextPane === pane) return false;
      pane = nextPane;
      return true;
    }

    function observeLayout() {
      if (observer) {
        observer.disconnect();
        if (pane?.isConnected) observer.observe(pane);
        if (pane?.parentElement) {
          observer.observe(pane.parentElement);
          for (const child of pane.parentElement.children) observer.observe(child);
        }
        for (const sibling of document.querySelectorAll<HTMLElement>(`[${OTTER_DOCK_ATTR}]`)) {
          observer.observe(sibling);
        }
        observer.observe(document.documentElement);
      }
      const nextParent = pane?.parentElement ?? null;
      if (nextParent !== observedParent) {
        mutations?.disconnect();
        mutations = null;
        observedParent = nextParent;
        if (nextParent && typeof MutationObserver !== "undefined") {
          mutations = new MutationObserver(() => {
            // Re-resolve pane before re-observing so a detached pane is never
            // re-observed and a single disconnect/observe pass runs per change.
            syncPane();
            observeLayout();
            measure(false);
          });
          mutations.observe(nextParent, { childList: true });
        }
      }
    }

    function measure(reobserveOnPaneChange = true) {
      if (syncPane() && reobserveOnPaneChange) observeLayout();
      const next = pane ? placeDock(dock!, pane.getBoundingClientRect(), size, contentBand(anchorRef.current)) : null;
      setPlacement((prev) =>
        prev === next || (prev && next && prev.x === next.x && prev.y === next.y && prev.facing === next.facing)
          ? prev
          : next,
      );
    }

    const onLayoutEvent = () => measure();
    observeLayout();
    measure(false);
    window.addEventListener("resize", onLayoutEvent);
    document.addEventListener("transitionend", onLayoutEvent, true);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", onLayoutEvent);
      document.removeEventListener("transitionend", onLayoutEvent, true);
    };
  }, [dock, size, anchorRef]);
  return placement;
}
