import { useLayoutEffect } from "react";
import type { RefObject } from "react";
import { FLOATING_OVERLAY_VIEWPORT_PADDING, getFloatingOverlayViewport, placeFloatingOverlay } from "./floatingOverlayPosition";
import type { FloatingOverlayPoint, FloatingOverlayPosition } from "./floatingOverlayPosition";

export function useFloatingOverlayPosition({
  anchor,
  floatingRef,
  open,
  padding = FLOATING_OVERLAY_VIEWPORT_PADDING,
  onPositionChange,
}: {
  anchor: FloatingOverlayPoint | null;
  floatingRef: RefObject<HTMLElement | null>;
  open: boolean;
  padding?: number;
  onPositionChange: (position: FloatingOverlayPosition) => void;
}) {
  useLayoutEffect(() => {
    if (!open || !anchor) return;

    let frame = 0;
    const update = () => {
      const floating = floatingRef.current;
      if (!floating) return;
      const rect = floating.getBoundingClientRect();
      onPositionChange(placeFloatingOverlay({
        anchor,
        floatingSize: { width: rect.width, height: rect.height },
        viewport: getFloatingOverlayViewport(),
        padding,
      }));
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    window.visualViewport?.addEventListener("scroll", scheduleUpdate, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, { capture: true });
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [anchor, floatingRef, onPositionChange, open, padding]);
}
