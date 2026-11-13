import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

/**
 * Taps on a message on a touch screen (raft-design foundations/states.md
 * "Taps on a touch screen", patterns/conversation.md "Actions"; stdrc
 * 2026-10-29): a tap opens the thread, a double tap opens the quick-reaction
 * bar, press and hold opens the menu (MessageItem's own long-press path).
 *
 * Detected from touch pointer events, not `dblclick` (unreliable on phones),
 * whatever the device's hover capability: a finger on a touchscreen laptop or
 * an iPad with a trackpad taps the same as on a phone (index.css gives every
 * message row `touch-action: manipulation` so the double tap never zooms).
 * While a double tap is possible, a tap waits for the second one before it
 * opens the thread, and reports `pressed` so the row shows it at once.
 */

/** A touch that moves farther than this is a scroll or a swipe, not a tap. */
export const MESSAGE_TAP_MOVE_TOLERANCE_PX = 10;
/** Longest gap from a tap's lift to the next touch for the two to be a double tap. */
export const MESSAGE_DOUBLE_TAP_WINDOW_MS = 300;
/** How long a tap waits for a second one before it opens the thread. */
export const MESSAGE_TAP_DELAY_MS = 250;
/** A scroll this recent when the finger lands means the touch stopped a moving list. */
const MESSAGE_TAP_SCROLL_SETTLE_MS = 100;
/** How long after a touch's lift the click the browser derives from it may arrive. */
const MESSAGE_TAP_CLICK_WINDOW_MS = 800;

/**
 * Controls inside a message keep their own action: links, buttons, images,
 * code, media, fields, cards (raft-ui `card`, `*-card`), mentions and
 * reaction chips (rendered as links or buttons).
 */
const TAP_CONTROL_SELECTOR = [
  "a",
  "button",
  "input",
  "textarea",
  "select",
  "label",
  "summary",
  "img",
  "video",
  "audio",
  "pre",
  "code",
  "[role='button']",
  "[role='link']",
  "[role='slider']",
  "[contenteditable='true']",
  "[data-slot='card']",
  "[data-slot$='-card']",
].join(", ");

// When each scroller (an element, the document, or the window) last scrolled.
const lastScrollAtByTarget = new WeakMap<EventTarget, number>();
let scrollListenerInstalled = false;
function watchScrolls(): void {
  if (scrollListenerInstalled || typeof window === "undefined") return;
  scrollListenerInstalled = true;
  // One listener for every row: capture sees the scroll of every scroller.
  window.addEventListener("scroll", (event) => {
    if (event.target) lastScrollAtByTarget.set(event.target, Date.now());
  }, { capture: true, passive: true });
}

/**
 * True when a scroller the row sits in (its message list, the page) scrolled
 * just now, so the touch stops that list. A scroll anywhere else on the page
 * (another pane, a code block) leaves the tap alone.
 */
function scrolledJustNow(row: HTMLElement, now: number): boolean {
  const recent = (target: EventTarget) => now - (lastScrollAtByTarget.get(target) ?? Number.NEGATIVE_INFINITY) <= MESSAGE_TAP_SCROLL_SETTLE_MS;
  for (let node: Node | null = row; node; node = node.parentNode) {
    if (recent(node)) return true;
  }
  return recent(window);
}

function selectionInside(row: HTMLElement): boolean {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return row.contains(selection.anchorNode) || row.contains(selection.focusNode);
}

/**
 * The touch that closed a popup over the messages (the quick-reaction bar),
 * popover convention on touch: that touch only closes it. No row takes it as
 * a tap, and the click the browser derives from it is swallowed, so a link,
 * button or the composer under the finger does not act either. It ends with
 * that click, when the touch turns into a scroll (pointercancel), at the next
 * touch, or after the click window, whichever comes first.
 */
let dismissingTouch: { pointerId: number; until: number; lifted: boolean; release: () => void } | null = null;

export function consumeDismissingTouch(event: PointerEvent): void {
  if (event.pointerType !== "touch" || typeof window === "undefined") return;
  dismissingTouch?.release();
  // No mouse events derived from the touch (mousedown handlers, focus).
  event.preventDefault();
  const origin = event;
  const touch = {
    pointerId: event.pointerId,
    until: Date.now() + MESSAGE_TAP_CLICK_WINDOW_MS,
    lifted: false,
    release: () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      if (dismissingTouch === touch) dismissingTouch = null;
    },
  };
  function onClick(click: MouseEvent) {
    touch.release();
    if (Date.now() > touch.until) return;
    click.preventDefault();
    click.stopImmediatePropagation();
  }
  function onPointerDown(next: PointerEvent) {
    if (next !== origin) touch.release();
  }
  function onPointerEnd(end: PointerEvent) {
    if (end.pointerId !== touch.pointerId) return;
    if (end.type === "pointercancel") touch.release();
    else touch.lifted = true;
  }
  window.addEventListener("click", onClick, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
  dismissingTouch = touch;
}

/** True while `pointerId` is the finger still down after closing a popup. */
function isDismissingTouch(pointerId: number): boolean {
  return !!dismissingTouch && !dismissingTouch.lifted && dismissingTouch.pointerId === pointerId;
}

export type MessageTapPoint = { x: number; y: number };
type Point = MessageTapPoint;

function within(a: Point, b: Point): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= MESSAGE_TAP_MOVE_TOLERANCE_PX ** 2;
}

export interface MessageTouchTapsOptions {
  rowRef: RefObject<HTMLElement | null>;
  /** False while the row has no tap gestures (select mode, read-only rows). */
  enabled: boolean;
  /** Opens the thread; null where a tap does nothing (inside a thread). */
  onTap: (() => void) | null;
  /**
   * Opens the quick-reaction bar at the second tap's point (viewport
   * coordinates), where the finger still is; null where the message has none.
   */
  onDoubleTap: ((point: MessageTapPoint) => void) | null;
  /** True once the touch's long press opened the menu: then it was no tap. */
  longPressFired: () => boolean;
}

export function useMessageTouchTaps({ rowRef, enabled, onTap, onDoubleTap, longPressFired }: MessageTouchTapsOptions) {
  const [pressed, setPressed] = useState(false);
  // The finger on the row now, and whether it is still a tap.
  const touchRef = useRef<{ start: Point; tap: boolean } | null>(null);
  // The last tap's lift, for the second tap of a double tap.
  const lastTapRef = useRef<{ at: number; point: Point } | null>(null);
  // A tap waiting for a possible second one before it opens the thread.
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A pending tap whose wait a second touch interrupted: it still opens the
  // thread unless that touch turns out to be the second tap.
  const owedTapRef = useRef(false);
  const lastTouchUpAtRef = useRef(Number.NEGATIVE_INFINITY);

  const clearPending = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  // Select mode can start while a tap waits: its timer still clears the
  // press, but opens nothing.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) return;
    owedTapRef.current = false;
    lastTapRef.current = null;
    touchRef.current = null;
  }, [enabled]);
  useEffect(() => { watchScrolls(); }, []);
  useEffect(() => clearPending, [clearPending]);

  const payOwedTap = useCallback(() => {
    if (!owedTapRef.current) return;
    owedTapRef.current = false;
    setPressed(false);
    onTap?.();
  }, [onTap]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType !== "touch" || !event.isPrimary) return;
    // The touch that closed the quick-reaction bar only closes it.
    if (isDismissingTouch(event.pointerId)) {
      touchRef.current = null;
      return;
    }
    // The previous tap counts toward a double tap only within the window.
    const previous = lastTapRef.current;
    if (previous && Date.now() - previous.at > MESSAGE_DOUBLE_TAP_WINDOW_MS) lastTapRef.current = null;
    const row = rowRef.current;
    const target = event.target;
    const start = { x: event.clientX, y: event.clientY };
    const tap = !!row
      && target instanceof Element
      && row.contains(target)
      && !target.closest(TAP_CONTROL_SELECTOR)
      && !scrolledJustNow(row, Date.now())
      && !selectionInside(row);
    if (pendingTimerRef.current) {
      clearPending();
      owedTapRef.current = true;
    }
    touchRef.current = { start, tap };
  }, [clearPending, enabled, rowRef]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const touch = touchRef.current;
    if (!touch || event.pointerType !== "touch" || !touch.tap) return;
    if (!within(touch.start, { x: event.clientX, y: event.clientY })) touch.tap = false;
  }, []);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch" || !touchRef.current) return;
    touchRef.current = null;
    lastTapRef.current = null;
    // The browser took the touch for a scroll: the tap before it still counts.
    payOwedTap();
  }, [payOwedTap]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const touch = touchRef.current;
    if (!touch || event.pointerType !== "touch") return;
    touchRef.current = null;
    const now = Date.now();
    lastTouchUpAtRef.current = now;
    const end = { x: event.clientX, y: event.clientY };
    if (longPressFired()) {
      // Press and hold opened the menu: neither this touch nor one before it acts.
      owedTapRef.current = false;
      lastTapRef.current = null;
      setPressed(false);
      return;
    }
    if (!touch.tap || !within(touch.start, end)) {
      lastTapRef.current = null;
      payOwedTap();
      return;
    }
    const previous = lastTapRef.current;
    if (onDoubleTap && previous && within(previous.point, touch.start)) {
      // The second tap of a double tap: the bar, and the first tap's thread
      // is dropped (onPointerDown expired a previous tap outside the window).
      lastTapRef.current = null;
      owedTapRef.current = false;
      setPressed(false);
      onDoubleTap(end);
      return;
    }
    // A tap too far from the previous one: that one still opens its thread.
    payOwedTap();
    lastTapRef.current = onDoubleTap ? { at: now, point: touch.start } : null;
    if (!onTap) return;
    if (!onDoubleTap) {
      onTap();
      return;
    }
    setPressed(true);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      // The thread opens now, so this tap can no longer be half of a double
      // tap: a touch after the wait but inside the window is a new tap.
      lastTapRef.current = null;
      setPressed(false);
      if (enabledRef.current) onTap();
    }, MESSAGE_TAP_DELAY_MS);
  }, [longPressFired, onDoubleTap, onTap, payOwedTap]);

  /**
   * True when a click is the one the browser derived from a touch these
   * handlers already took, so the row's click handler leaves it alone. A
   * click with no touch before it (a mouse, a screen reader's activation)
   * is not theirs, even when the browser labels it a touch: only a touch
   * these handlers saw lift just before makes the click theirs.
   */
  const ownsClick = useCallback(() => {
    if (!enabled) return false;
    return Date.now() - lastTouchUpAtRef.current <= MESSAGE_TAP_CLICK_WINDOW_MS;
  }, [enabled]);

  return {
    pressed,
    ownsClick,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
