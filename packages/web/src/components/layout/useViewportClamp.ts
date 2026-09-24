import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  RefObject,
} from "react";

// useViewportClamp — small popover-positioning helper that nudges a floating
// element (popup, dropdown, menu) so it always fits inside the visible
// viewport.
//
// Usage:
//   const triggerRef = useRef<HTMLElement>(null);
//   const popoverRef = useRef<HTMLDivElement>(null);
//   const { style } = useViewportClamp({
//     triggerRef,
//     popoverRef,
//     placement: "right" | "below" | "vertical-smart",
//     open: open,
//     gutter: 8,
//   });
//   <button ref={triggerRef}>…</button>
//   {open && <div ref={popoverRef} style={style}>…</div>}
//
// Behavior:
//   - "right":  popover floats to the right of the trigger; vertically aligned
//               so its top sits at the trigger's top, but flips to bottom-anchor
//               (popover bottom = trigger bottom) when it would overflow the
//               viewport bottom — so a Rail trigger near the bottom of the
//               screen pops *upward* instead of off-screen.
//   - "below":  popover drops below the trigger; horizontally anchored to the
//               trigger's right edge by default, nudged left (or right) just
//               enough to keep both edges inside the viewport.
//   - "vertical-smart": popover is centered horizontally on the trigger, then
//               picks above-or-below based on which side has more room.
//               Used for hover cards where the natural
//               anchor is "next to the inline span" not "below a button".
//
// For all placements `maxHeight` is set to `viewport - gutter` so the popover
// is internally scrollable when its content is taller than the screen.
//
// The hook re-measures on open, window resize, and visualViewport resize
// (mobile keyboard / address bar).

export type ViewportClampPlacement = "right" | "below" | "vertical-smart";

export interface ViewportClampOptions {
  triggerRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  placement: ViewportClampPlacement;
  open: boolean;
  /** Pixel margin from the trigger edge and the viewport edges. Default 8. */
  gutter?: number;
}

export interface ViewportClampResult {
  /** Inline style to spread onto the popover container. position is fixed. */
  style: CSSProperties;
}

export interface ViewportClampRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ViewportClampSize {
  width: number;
  height: number;
}

export function calculateViewportClampStyle({
  triggerRect,
  popoverRect,
  viewport,
  placement,
  gutter = 8,
}: {
  triggerRect: ViewportClampRect;
  popoverRect: ViewportClampRect;
  viewport: ViewportClampSize;
  placement: ViewportClampPlacement;
  gutter?: number;
}): CSSProperties {
  const next: CSSProperties = {
    position: "fixed",
    visibility: "visible",
  };

  if (placement === "right") {
    // Horizontal: place to the right of the trigger.
    const left = Math.min(
      triggerRect.right + gutter,
      viewport.width - gutter - popoverRect.width,
    );
    next.left = Math.max(gutter, left);
    next.maxHeight = viewport.height - gutter * 2;

    // Vertical: anchor at trigger top by default; flip to bottom-anchor if
    // the popover would extend past the viewport bottom.
    const idealTop = triggerRect.top;
    const wouldOverflowBottom = idealTop + popoverRect.height > viewport.height - gutter;
    if (wouldOverflowBottom) {
      // Anchor popover bottom to trigger bottom (or viewport bottom,
      // whichever is closer). Top derives from height.
      const bottomAnchor = Math.min(triggerRect.bottom, viewport.height - gutter);
      const top = Math.max(gutter, bottomAnchor - popoverRect.height);
      next.top = top;
    } else {
      next.top = Math.max(gutter, idealTop);
    }
  } else if (placement === "below") {
    // "below" — drop popover beneath the trigger.
    const idealTop = triggerRect.bottom + gutter;
    const wouldOverflowBottom = idealTop + popoverRect.height > viewport.height - gutter;
    if (wouldOverflowBottom) {
      // Flip above the trigger if there's no room below.
      const bottomAnchor = triggerRect.top - gutter;
      const top = Math.max(gutter, bottomAnchor - popoverRect.height);
      next.top = top;
    } else {
      next.top = idealTop;
    }
    next.maxHeight = viewport.height - gutter * 2;

    // Horizontal: align right edge of popover to right edge of trigger,
    // then clamp into viewport.
    const idealLeft = triggerRect.right - popoverRect.width;
    const left = Math.min(
      Math.max(gutter, idealLeft),
      viewport.width - gutter - popoverRect.width,
    );
    next.left = Math.max(gutter, left);
  } else {
    // "vertical-smart" — pick above-or-below by which side has more room,
    // then center horizontally on the trigger. Used for hover cards
    // anchored to inline elements (e.g. @mention spans) where there is no
    // natural "right edge" to align to.
    const spaceAbove = triggerRect.top;
    const spaceBelow = viewport.height - triggerRect.bottom;
    const placeBelow =
      spaceBelow >= popoverRect.height + gutter || spaceBelow >= spaceAbove;

    next.top = placeBelow
      ? triggerRect.bottom + gutter
      : Math.max(gutter, triggerRect.top - popoverRect.height - gutter);

    const desiredLeft =
      triggerRect.left + triggerRect.width / 2 - popoverRect.width / 2;
    next.left = Math.max(
      gutter,
      Math.min(desiredLeft, viewport.width - popoverRect.width - gutter),
    );
    next.maxHeight = viewport.height - gutter * 2;
  }

  // Width is measured (intrinsic), so we don't override it. But cap at
  // viewport - 2*gutter so popovers wider than the screen scroll inside.
  next.maxWidth = viewport.width - gutter * 2;

  return next;
}

export function useViewportClamp({
  triggerRef,
  popoverRef,
  placement,
  open,
  gutter = 8,
}: ViewportClampOptions): ViewportClampResult {
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  // Used to schedule a re-measure once the popover renders so we know its
  // intrinsic height/width.
  const rafRef = useRef<number | null>(null);

  const measure = () => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const tr = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    // Use visualViewport when available (mobile address bar / keyboard),
    // else fall back to window inner size.
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const vw = vv?.width ?? window.innerWidth;
    const vh = vv?.height ?? window.innerHeight;

    setStyle(calculateViewportClampStyle({
      triggerRect: tr,
      popoverRect: popRect,
      viewport: { width: vw, height: vh },
      placement,
      gutter,
    }));
  };

  // Re-measure synchronously after the popover renders so users don't see a
  // jump on first frame.
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ position: "fixed", visibility: "hidden" });
      return;
    }
    measure();
    // One extra rAF to catch reflow after fonts / images load inside the popover.
    rafRef.current = requestAnimationFrame(() => {
      measure();
    });
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure on viewport changes.
  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize);
      // passive: this listener never calls preventDefault — opt out of the
      // blocking default so mobile scroll on iOS doesn't stall waiting for us.
      window.visualViewport.addEventListener("scroll", onResize, { passive: true });
    }
    return () => {
      window.removeEventListener("resize", onResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResize);
        window.visualViewport.removeEventListener("scroll", onResize);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-measure when popover content size changes while open. This matches the
  // standard floating-ui `autoUpdate` pattern and keeps generic floating
  // surfaces correctly clamped if their measured size changes after mount.
  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return;
    const popover = popoverRef.current;
    if (!popover) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(popover);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { style };
}
