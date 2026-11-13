import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode, RefObject, TouchEvent } from "react";

import { ScrollArea } from "@botiverse/raft-ui";
import { dismissLayerProps } from "../ui/dismissLayer";

/** How far up (px) a drag that starts on the panel must travel to close it. */
const SWIPE_CLOSE_DISTANCE_PX = 40;

/** The event started inside the panel's own DOM (not a portaled menu's). */
function ownsTarget(panelRef: RefObject<HTMLDivElement | null>, target: EventTarget): boolean {
  return !!panelRef.current?.contains(target as Node);
}

/**
 * On a phone, once the task's head has scrolled away with the conversation,
 * the bar pulls it down again as a panel over the messages (Kirby, for
 * artin, #proj-mobile): the same head as the conversation's first row,
 * editable the same way, without losing the place in the discussion.
 *
 * Not a raft-ui Popover or Drawer: it is neither modal (no scrim, the
 * messages stay live under it) nor anchored to a point. It hangs from the
 * bar's whole width, on the page's surface with the float shadow under its
 * edge, at most 70% of the screen tall (its own content scrolls beyond that),
 * and slides down from the bar with `ease-slide` (none with reduced motion).
 *
 * It closes on a tap outside it and the bar, on focus moving outside them
 * (the composer), on Escape, on a swipe up once its content is at its end,
 * and when the reader starts scrolling the messages (the caller's). Focus
 * moves into it when it opens and back to the bar when it closes, unless a
 * tap outside it closed it: that tap puts focus where the reader meant.
 */
export default function TaskHeadPullDown({ id, label, barRef, onClose, children }: {
  id: string;
  /** The region's name (the task's label, "Task #7"). */
  label: string;
  /** The bar's toggle: a tap or focus there is not outside the panel. */
  barRef: RefObject<HTMLElement | null>;
  /** Stable (the listeners are bound to it while the panel is open). */
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // React events travel the React tree, portals included, so a menu the head
  // opens (Status, Assignee) is inside the panel though its DOM is not: the
  // capture handlers below mark it before the document hears the event.
  const insideRef = useRef(false);
  // Stable handlers: the panel is a raft-ui ScrollArea (a component).
  const markInside = useCallback(() => {
    insideRef.current = true;
  }, []);
  const restoreFocusRef = useRef(true);

  // Leaving: focus still in the panel goes back to the bar. A layout cleanup
  // runs before the panel leaves the DOM, while it still holds the focus.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const bar = barRef.current;
    return () => {
      if (restoreFocusRef.current && panel?.contains(document.activeElement)) bar?.focus({ preventScroll: true });
    };
  }, [barRef]);

  // The panel was displayed: take focus into it, and listen for presses and
  // focus outside it for as long as it is open.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
    const reset = () => {
      insideRef.current = false;
    };
    const closeIfOutside = (event: Event) => {
      const target = event.target as Node | null;
      const inside = insideRef.current
        || (!!target && (!!panelRef.current?.contains(target) || !!barRef.current?.contains(target)));
      insideRef.current = false;
      if (inside) return;
      if (event.type === "pointerdown") restoreFocusRef.current = false;
      onClose();
    };
    document.addEventListener("pointerdown", reset, true);
    document.addEventListener("focusin", reset, true);
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("focusin", closeIfOutside);
    return () => {
      document.removeEventListener("pointerdown", reset, true);
      document.removeEventListener("focusin", reset, true);
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("focusin", closeIfOutside);
    };
  }, [barRef, onClose]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // A menu the head opened (portaled) handles its own Escape.
    if (event.key !== "Escape" || !ownsTarget(panelRef, event.target)) return;
    event.stopPropagation();
    onClose();
  }, [onClose]);

  const swipeRef = useRef<{ x: number; y: number; atEnd: boolean } | null>(null);
  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    const panel = panelRef.current;
    if (!touch || !panel || !ownsTarget(panelRef, event.target)) {
      swipeRef.current = null;
      return;
    }
    // Up is the panel's own scroll until its content is at its end.
    const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
    swipeRef.current = { x: touch.clientX, y: touch.clientY, atEnd };
  }, []);
  const onTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    const touch = event.changedTouches[0];
    if (!start?.atEnd || !touch) return;
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (dy <= -SWIPE_CLOSE_DISTANCE_PX && Math.abs(dy) > Math.abs(dx)) onClose();
  }, [onClose]);

  return (
    // The clip hangs from the bar and lets the panel slide out from under it;
    // its bottom padding leaves the shadow room, and passes taps through.
    <div className="pointer-events-none absolute inset-x-0 top-full z-float overflow-hidden pb-6">
      {/* The panel is the scroller (a raft-ui ScrollArea): the swipe reads
          its scrollTop, and it takes focus from code only (tabIndex -1). */}
      <ScrollArea
        ref={panelRef}
        {...dismissLayerProps}
        id={id}
        role="region"
        aria-label={label}
        tabIndex={-1}
        overscroll="contain"
        className="pointer-events-auto max-h-[70dvh] bg-layer-canvas shadow-float outline-none motion-safe:transition-transform motion-safe:duration-220 motion-safe:ease-slide motion-safe:starting:-translate-y-full"
        onPointerDownCapture={markInside}
        onFocusCapture={markInside}
        onKeyDown={onKeyDown}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        data-testid="task-head-pull-down"
      >
        {children}
      </ScrollArea>
    </div>
  );
}
