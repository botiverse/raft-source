import { useCallback } from "react";
import { ROW_SWIPE_EDGE_ZONE, rowSwipeDecision, swallowClickAfterPress } from "../../hooks/useRowSwipe";
import type { RowSwipeDecision } from "../../hooks/useRowSwipe";
import { hasOpenLayerOver } from "../topbar/layerGuard";
import { TIME_REVEAL_ATTR, TIME_REVEAL_MOTION_ATTR } from "./messageTimelineShared";

// Drag the conversation left on a touch screen to see every message's time,
// as in iMessage (raft-design Conversation › Dates and grouping, Responsive
// layout › Touch screens; artin, 2026-11-04, #triage:530f8c36). Every message
// row slides left together and its time, hour and minute in the merged
// message's clock format, comes in at the right edge; the release springs
// them back. A touch screen's only way to read a merged message's own time.
//
// - Touch only: it listens to touch events, which a mouse or a trackpad never
//   sends. Any touch screen, tablets included.
// - It claims a drag on the same terms as a row swipe (`rowSwipeDecision`):
//   clearly sideways, past twice the touch slop, and only to the left. A drag
//   that turns vertical first is the list's scroll for the rest of the stroke.
//   Once claimed, the rows move exactly with the finger, counted from where
//   it went down (the distance before the claim included), from the claim's
//   own frame on.
// - Its listeners are passive and it never captures the pointer, so the list
//   scrolls without waiting for the page (utils/touchDragRegion.ts) and the
//   rows keep `touch-action: manipulation`: pinch zoom stays. The cost is that
//   a diagonal drag may also scroll the list a little.
// - It leaves a drag alone that starts within 24px of either screen edge (the
//   system's back and app-switch gestures), inside a code block, display math,
//   a Mermaid diagram, a field, a slider or media, or inside anything that
//   scrolls sideways and has something to scroll (a wide table). Such a drag
//   never hands over, even once that scroller has reached its end. So does a
//   drag while a popup is open, or once the long-press menu has opened.
// - A claimed drag is no tap: it never opens the thread, counts toward a
//   double tap or opens the menu (the rows' own gestures give up past the
//   slop), and the click a browser may send after it is swallowed.
// - Per frame it translates the mounted top-level message rows (inline
//   transforms, `will-change` only while dragging), and it finds them again
//   after a scroll: the list mounts and unmounts rows as it scrolls.
// - With reduced motion nothing slides and nothing lands on text: while the
//   drag is claimed each merged row's time fades in in its empty left gutter,
//   where a mouse's hover shows it, and fades out on release (160ms, color
//   only). A group's first row already shows its time in its header.
// - On for every list on a touch screen: no list on the web switches tabs by
//   swiping (the Chat/Tasks/Files tabs without task v2 switch by tap), so
//   nothing competes for the drag, unlike the app's old tabbed conversations.

/** How far the rows slide before the rubber band: room for the time. */
export const TIME_REVEAL_DISTANCE = 64;
/** Past TIME_REVEAL_DISTANCE the rows follow the finger at this rate. */
export const TIME_REVEAL_RUBBER_BAND = 0.55;
/** The farthest the rows slide, however far the finger goes. */
export const TIME_REVEAL_MAX = 88;
/** How long the rows take to spring back, and the times to fade (raft-ui `motion-drag-settle-duration`). */
export const TIME_REVEAL_SETTLE_MS = 160;
/** A drag that starts this close to either edge of the screen is the system's. */
export const TIME_REVEAL_EDGE_ZONE = ROW_SWIPE_EDGE_ZONE;

/**
 * Where a drag can't start: code, display math, Mermaid, fields, sliders and
 * media keep their own gestures (selecting, panning, seeking, zooming).
 */
const EXCLUDED_START_SELECTOR = [
  "pre",
  "[data-code-block]",
  ".raft-math-display",
  ".r-mermaid-viewport",
  "input",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='slider']",
  "video",
  "audio",
  "img[data-select-screenshot-attachment-id]",
].join(", ");

const MESSAGE_ROW_SELECTOR = "[data-message-item]";

/** How far the rows slide for a finger `pulled` px left of where the drag was claimed. */
export function timeRevealOffset(pulled: number): number {
  if (!(pulled > 0)) return 0;
  if (pulled <= TIME_REVEAL_DISTANCE) return pulled;
  return Math.min(TIME_REVEAL_DISTANCE + (pulled - TIME_REVEAL_DISTANCE) * TIME_REVEAL_RUBBER_BAND, TIME_REVEAL_MAX);
}

/** Whether a touch at `x` starts within the edge zone of a screen `viewportWidth` px wide. */
export function startsInScreenEdgeZone(x: number, viewportWidth: number): boolean {
  return x < TIME_REVEAL_EDGE_ZONE || viewportWidth - x < TIME_REVEAL_EDGE_ZONE;
}

/** Whether an `overflow-x` value makes a box scroll sideways (`hidden` and `clip` don't: no finger scrolls them). */
export function overflowXScrolls(overflowX: string): boolean {
  return overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay";
}

/** Whether a box scrolls sideways and has something to scroll: a wide table, not one that fits. */
export function scrollsSideways(box: { overflowX: string; scrollWidth: number; clientWidth: number }): boolean {
  return overflowXScrolls(box.overflowX) && box.scrollWidth > box.clientWidth + 1;
}

/** Whether a drag that starts on `target` is left to what it starts on (`root`: the list's wrapper). */
export function timeRevealExcludedStart(target: Element, root: Element): boolean {
  const excluded = target.closest(EXCLUDED_START_SELECTOR);
  if (excluded && root.contains(excluded)) return true;
  const view = root.ownerDocument.defaultView;
  for (let node: Element | null = target; node && node !== root; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    // The style first: only a box that scrolls sideways is measured.
    const overflowX = view ? view.getComputedStyle(node).overflowX : node.style.overflowX;
    if (!overflowXScrolls(overflowX)) continue;
    if (scrollsSideways({ overflowX, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth })) return true;
  }
  return false;
}

/** The message rows to slide: the mounted top-level ones (a row nested in a card slides with its own). */
function messageRows(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR))
    .filter((row) => !row.parentElement?.closest(MESSAGE_ROW_SELECTOR));
}

/** A message in the list has its menu (a long press opened it) or its quick reactions open. */
function messagePopupOpen(root: Element): boolean {
  return root.querySelector("[data-popup-open]") !== null;
}

/** A popup is open: a message's, or any layer over the list (a menu, a dialog, a sheet). */
function popupOpen(root: Element): boolean {
  return messagePopupOpen(root) || hasOpenLayerOver(root);
}

function prefersReducedMotion(view: Window | null): boolean {
  return !!view && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type TouchPoint = { identifier: number; clientX: number; clientY: number };

/** An element's listener is typed for any event (Element has no touch event map). */
function isTouchEvent(event: Event): event is TouchEvent {
  return "changedTouches" in event && "touches" in event;
}

function findTouch(list: TouchList | ArrayLike<TouchPoint> | undefined, identifier: number): TouchPoint | null {
  if (!list) return null;
  for (let index = 0; index < list.length; index += 1) {
    const touch = list[index];
    if (touch && touch.identifier === identifier) return touch;
  }
  return null;
}

type Stroke = {
  identifier: number;
  startX: number;
  startY: number;
  decision: RowSwipeDecision;
  /** Where the finger went down: its touch events keep going there, even once it has left the page. */
  target: Element;
};

/**
 * Wires the time reveal onto the list's wrapper (`div[data-virtual-timeline]`).
 * Returns the teardown. The state is written to the DOM, never to React, so a
 * drag renders nothing: TIME_REVEAL_ATTR on `root` (`dragging`, `settling`)
 * and an inline transform on each row.
 */
export function attachTimelineTimeReveal(root: HTMLElement): () => void {
  const view = root.ownerDocument.defaultView;
  let stroke: Stroke | null = null;
  let rows: HTMLElement[] = [];
  let offset = 0;
  let rowsStale = false;
  let frame = 0;
  /** This stroke fades the times in place instead of sliding the rows (reduced motion). */
  let fading = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const setPhase = (phase: "dragging" | "settling" | null) => {
    if (phase) root.setAttribute(TIME_REVEAL_ATTR, phase);
    else root.removeAttribute(TIME_REVEAL_ATTR);
  };
  const release = (row: HTMLElement) => {
    row.style.removeProperty("transform");
    row.style.removeProperty("will-change");
  };
  const collectRows = () => {
    const next = messageRows(root);
    const kept = new Set(next);
    for (const row of rows) if (!kept.has(row)) release(row);
    for (const row of next) row.style.setProperty("will-change", "transform");
    rows = next;
    rowsStale = false;
  };
  const paint = () => {
    frame = 0;
    if (rowsStale) collectRows();
    // Hundredths of a pixel: the rubber band's fractions, without float noise.
    const transform = `translate3d(${-Math.round(offset * 100) / 100}px, 0, 0)`;
    for (const row of rows) row.style.setProperty("transform", transform);
  };
  const cancelFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const clearSettle = () => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  };
  const finish = () => {
    settleTimer = null;
    cancelFrame();
    for (const row of rows) release(row);
    rows = [];
    offset = 0;
    fading = false;
    root.removeAttribute(TIME_REVEAL_MOTION_ATTR);
    setPhase(null);
  };
  /** The finger let go (or the stroke was taken): the rows go back. */
  const springBack = () => {
    cancelFrame();
    if (fading) {
      // index.css fades the times out while `settling`.
      setPhase("settling");
      settleTimer = setTimeout(finish, TIME_REVEAL_SETTLE_MS);
      return;
    }
    if (offset === 0) {
      finish();
      return;
    }
    // index.css gives the rows the settle transition while `settling`.
    setPhase("settling");
    offset = 0;
    for (const row of rows) row.style.setProperty("transform", "translate3d(0px, 0, 0)");
    settleTimer = setTimeout(finish, TIME_REVEAL_SETTLE_MS);
  };
  // Touch events keep going to the element the finger went down on, even
  // once it has left the page (an image placeholder swapped for the image, a
  // row re-created as its message is confirmed): from then on they no longer
  // reach the list. So a claimed stroke also listens on that element, and
  // acts on what it hears only once the element has left the list (until
  // then the same event reaches the list as well).
  let strokeTarget: Element | null = null;
  const onDetachedTargetEvent = (event: Event) => {
    if (!strokeTarget || root.contains(strokeTarget) || !isTouchEvent(event)) return;
    if (event.type === "touchmove") onTouchMove(event);
    else onTouchEnd(event);
  };
  const unbindTarget = () => {
    if (!strokeTarget) return;
    strokeTarget.removeEventListener("touchmove", onDetachedTargetEvent);
    strokeTarget.removeEventListener("touchend", onDetachedTargetEvent);
    strokeTarget.removeEventListener("touchcancel", onDetachedTargetEvent);
    strokeTarget = null;
  };
  const bindTarget = (target: Element) => {
    unbindTarget();
    strokeTarget = target;
    target.addEventListener("touchmove", onDetachedTargetEvent, { passive: true });
    target.addEventListener("touchend", onDetachedTargetEvent, { passive: true });
    target.addEventListener("touchcancel", onDetachedTargetEvent, { passive: true });
  };
  const endStroke = () => {
    const claimed = stroke?.decision === "claim";
    stroke = null;
    unbindTarget();
    if (claimed) springBack();
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      // A second finger: a pinch, never a reveal.
      endStroke();
      return;
    }
    // A new touch ends the last stroke, springing it back if it was claimed:
    // a stroke whose end never arrived can't leave the rows slid.
    endStroke();
    const touch = event.touches[0];
    const target = event.target;
    if (!touch || !(target instanceof Element) || !root.contains(target)) return;
    if (startsInScreenEdgeZone(touch.clientX, view?.innerWidth ?? Number.POSITIVE_INFINITY)) return;
    // What the drag starts in and any open popup are read at the claim, not
    // here: most touches are scrolls and taps that never get that far.
    stroke = { identifier: touch.identifier, startX: touch.clientX, startY: touch.clientY, decision: "undecided", target };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!stroke || stroke.decision === "release") return;
    // Fading in place: once claimed, the finger moves nothing.
    if (stroke.decision === "claim" && fading) return;
    if (event.touches.length !== 1) {
      endStroke();
      return;
    }
    const touch = findTouch(event.changedTouches, stroke.identifier) ?? findTouch(event.touches, stroke.identifier);
    if (!touch) return;
    if (stroke.decision === "undecided") {
      // The long-press menu opened while the finger held still.
      if (messagePopupOpen(root)) {
        stroke.decision = "release";
        return;
      }
      stroke.decision = rowSwipeDecision(touch.clientX - stroke.startX, touch.clientY - stroke.startY, { left: true, right: false });
      if (stroke.decision !== "claim") return;
      // About to claim: leave the drag to what it started in, and to any popup.
      if (timeRevealExcludedStart(stroke.target, root) || popupOpen(root)) {
        stroke.decision = "release";
        return;
      }
      bindTarget(stroke.target);
      // A reveal still settling from the last stroke ends here: this one starts at rest.
      clearSettle();
      finish();
      if (prefersReducedMotion(view)) {
        // The merged rows' gutter times fade in (index.css); the rows stay still.
        fading = true;
        root.setAttribute(TIME_REVEAL_MOTION_ATTR, "fade");
        setPhase("dragging");
        swallowClickAfterPress(event);
        return;
      }
      setPhase("dragging");
      collectRows();
      // The drag is no tap: a click the browser may still send is the drag's.
      swallowClickAfterPress(event);
      // The rows catch up with the finger in the frame the drag is claimed:
      // the travel counts from where the finger went down, the 20px before
      // the claim included, so they never lag it or jump later.
      offset = timeRevealOffset(stroke.startX - touch.clientX);
      cancelFrame();
      paint();
      return;
    }
    offset = timeRevealOffset(stroke.startX - touch.clientX);
    schedule();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (!stroke) return;
    if (!findTouch(event.changedTouches, stroke.identifier)) return;
    endStroke();
  };

  // A scroll mounts and unmounts rows: find them again on the next frame.
  const onScroll = () => {
    if (root.getAttribute(TIME_REVEAL_ATTR) !== "dragging") return;
    rowsStale = true;
    schedule();
  };

  const passive = { passive: true } as const;
  root.addEventListener("touchstart", onTouchStart, passive);
  root.addEventListener("touchmove", onTouchMove, passive);
  root.addEventListener("touchend", onTouchEnd, passive);
  root.addEventListener("touchcancel", onTouchEnd, passive);
  root.addEventListener("scroll", onScroll, { passive: true, capture: true });
  return () => {
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", onTouchEnd);
    root.removeEventListener("touchcancel", onTouchEnd);
    root.removeEventListener("scroll", onScroll, { capture: true });
    stroke = null;
    unbindTarget();
    clearSettle();
    finish();
  };
}

/** The ref for the list's wrapper: attaches the time reveal while it is mounted. */
export function useTimelineTimeReveal(): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLElement | null) => (element ? attachTimelineTimeReveal(element) : undefined), []);
}
