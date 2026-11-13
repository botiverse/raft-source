import { useCallback, useEffect, useRef } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- a full swipe's row must leave the list in the same frame it closes (finishFullSwipe); a transition would paint the whole row for a frame.
import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent } from "react";

// Swipe a list row sideways to uncover its action buttons, then tap one, as
// in iOS Mail (Raft DS › Responsive layout › Touch screens, raft-design #785
// and #793; stdrc, 2026-10-23; artin and stdrc, 2026-10-24): left to uncover
// the buttons at the row's end (`end`), right to uncover those at its start
// (`start`). raft-ui has no swipeable row yet, so this is the web's own. It
// depends on React and React DOM alone (no store, copy or router), so it can
// move into raft-ui's InboxItem: the row draws each side's buttons, with
// their labels, and passes each side's total width and full-swipe action.
//
// - A finger only (`pointerType: "touch"`): a mouse or a pen never drags a row.
// - The row claims a drag only on a clearly sideways move: more than twice as
//   far across as up or down, and past the touch slop (10px on the web; the
//   rule is read at 20px). Any move past the slop that is not on track for
//   that hands the gesture to the list and locks the swipe out for the rest of
//   the stroke, so a drag that turns vertical scrolls. The row sets
//   `touch-action: pan-y`, so the browser keeps scrolling the list vertically
//   on its own; a claimed drag stays horizontal.
// - Each side is optional: a closed row swipes only toward a side it has
//   buttons for (no `start`: no right swipe). A stroke keeps to one side: an
//   open row is swiped back only to close it, not through to the other side.
// - A drag that starts within 24px of either edge of the row is left to the
//   browser's and the system's edge swipes (the left edge is the back gesture).
// - Released past half the side's buttons' width, or flicked further open, the
//   row stays open on them; short of that, or flicked back, it springs back.
//   Pulled past 60% of the row's width it is "full" (`data-swipe-full`): the
//   side's first button grows across the uncovered width, the phone ticks once
//   on Android (each crossing), and a release applies the side's full-swipe
//   action (Done; Read or Unread). Only distance applies it, never a flick.
//   A side's `fullSwipe` says what happens to the row: `remove` slides it out
//   (Done takes it out of the list), `keep` slides it back closed (it stays).
// - The parent owns which row is open (`open`, `onOpenChange`), so one row is
//   open at a time, on either side; a tap on the open row closes it rather
//   than opening it, and `swallowClickAfterPress` lets the parent do the same
//   for a press elsewhere that closes it. The guard is bound to the press,
//   not to a time: it takes that press's click however late it comes.
// - A swipe never opens the row: the click that may follow it is swallowed.
// - With reduced motion the row still follows the finger (that is direct
//   manipulation), but it jumps instead of sliding.

/** How far a finger moves before a press is a drag, not a tap. The row's long press gives up at the same distance (`useLongPress`). */
export const ROW_SWIPE_TOUCH_SLOP = 10;
/** A swipe claims the drag at twice the touch slop, as in the App (2 x slop, kept to 16-24dp). */
export const ROW_SWIPE_CLAIM_DISTANCE = 2 * ROW_SWIPE_TOUCH_SLOP;
/** A claim needs the horizontal distance to be more than this many times the vertical one. */
export const ROW_SWIPE_DOMINANCE_RATIO = 2;
/** A drag that starts this close to either edge of the row is never claimed. */
export const ROW_SWIPE_EDGE_ZONE = 24;
/** Each action button's width. */
export const ROW_SWIPE_BUTTON_WIDTH = 72;
/** Past this share of a side's buttons' width, a release leaves the row open. */
export const ROW_SWIPE_OPEN_FRACTION = 0.5;
/** Past this share of the row's width, the swipe is full: a release applies the side's first action. */
export const ROW_SWIPE_FULL_FRACTION = 0.6;
/** A flick at least this fast (px/s) opens the row (away from the uncovered side) or closes it (back). */
export const ROW_SWIPE_FLING_VELOCITY = 800;
/** How long the row takes to slide open, closed or away. */
export const ROW_SWIPE_SETTLE_MS = 200;
/** Only the last stretch of the drag decides how fast the finger left. */
const VELOCITY_WINDOW_MS = 100;

/**
 * How long after a press ends its click guard gives up. A press's own click
 * comes before the next press however late it is (a busy page dispatches it
 * after its render: 450-590ms after the finger lifted on a loaded phone), so
 * the guard does not wait for a time; this only bounds a press that got no
 * click (a swipe), so the guard isn't left armed.
 */
const PRESS_CLICK_CAP_MS = 2_000;

/**
 * Swallows the click that belongs to the press `press` is part of (its
 * `pointerdown`, a move, or its `pointerup`), wherever it lands: the press
 * that closes an open row, or swipes one, does nothing else, as in iOS Mail
 * (tapping another row closes the open one without opening the other). The
 * caller decides which presses those are (in the list, not a toast or the
 * tab bar). It holds until that click comes, however late, and is disarmed
 * without one by the next press, by a cancelled press (the browser took the
 * stroke to scroll, and a cancelled press never gets a click), or
 * PRESS_CLICK_CAP_MS after the press ends. A click no press made (a
 * keyboard's, `detail` 0) goes through.
 */
export function swallowClickAfterPress(press: Event): void {
  let capTimer: number | null = null;
  const onClick = (event: MouseEvent) => {
    // A keyboard's or a script's click (no press made it) is never the press's.
    if (event.detail === 0) return;
    disarm();
    event.preventDefault();
    event.stopPropagation();
  };
  const onNextPress = (event: Event) => {
    if (event !== press) disarm();
  };
  const onPressEnd = () => {
    if (capTimer === null) capTimer = window.setTimeout(disarm, PRESS_CLICK_CAP_MS);
  };
  function disarm() {
    if (capTimer !== null) window.clearTimeout(capTimer);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointerdown", onNextPress, true);
    document.removeEventListener("pointerup", onPressEnd, true);
    document.removeEventListener("pointercancel", disarm, true);
  }
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onNextPress, true);
  document.addEventListener("pointercancel", disarm, true);
  // Armed as the press ends: its click is all that is left of it.
  if (press.type === "pointerup") onPressEnd();
  else document.addEventListener("pointerup", onPressEnd, true);
}

/** Marks the row's action buttons: a tap on one runs it, rather than closing the row. */
export const ROW_SWIPE_ACTION_ATTR = "data-row-swipe-action";

/** The CSS custom property the row's parts read: how far the row is open on its end buttons (swiped left), in px. */
export const ROW_SWIPE_REVEAL_VAR = "--row-swipe-reveal";
/** The same for its start buttons (swiped right), in px. At most one of the two is above 0. */
export const ROW_SWIPE_REVEAL_START_VAR = "--row-swipe-reveal-start";

/** A side of the row: `end` is uncovered by a swipe left, `start` by a swipe right. */
export type RowSwipeSide = "start" | "end";

/** One side's buttons, as the row draws them. */
export type RowSwipeActions = {
  /** The side's buttons' total width, px: how far the row rests open on them. 0: no swipe this way. */
  width: number;
  /**
   * A release past the full point: the side's first action. The one passed
   * when the finger lifts is the one that runs once the row has slid, so it
   * applies what the row showed then.
   */
  onFullSwipe: () => void;
  /**
   * What a full swipe does with the row. `remove` (Done): it slides out
   * across its whole width and `onFullSwipe` runs as it leaves, so its owner
   * takes it out of the list in the same frame. `keep` (Read): it slides back
   * closed and `onFullSwipe` runs then; the row stays where it is.
   */
  fullSwipe: "remove" | "keep";
};

function hasButtons(actions: RowSwipeActions | undefined): actions is RowSwipeActions {
  return actions !== undefined && actions.width > 0;
}

export type RowSwipeDecision = "undecided" | "claim" | "release";

/**
 * The decision for a stroke that has moved (`dx`, `dy`) since it went down.
 * `left` and `right`: whether a move that way may be claimed (the row has
 * buttons on the side it uncovers, or it is open and that way closes it).
 * Stateless; the hook locks a `release` in for the rest of the stroke.
 */
export function rowSwipeDecision(
  dx: number,
  dy: number,
  { startsInEdgeZone = false, left = true, right = false }: { startsInEdgeZone?: boolean; left?: boolean; right?: boolean } = {},
): RowSwipeDecision {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (startsInEdgeZone) {
    return adx >= ROW_SWIPE_TOUCH_SLOP || ady >= ROW_SWIPE_TOUCH_SLOP ? "release" : "undecided";
  }
  if (ady >= ROW_SWIPE_TOUCH_SLOP && adx <= ROW_SWIPE_DOMINANCE_RATIO * ady) return "release";
  if (adx < ROW_SWIPE_CLAIM_DISTANCE || adx <= ROW_SWIPE_DOMINANCE_RATIO * ady) return "undecided";
  return (dx < 0 ? left : right) ? "claim" : "release";
}

/** Whether a row open by `reveal` px is pulled far enough that a release applies the full-swipe action. */
export function rowSwipeFull(reveal: number, width: number): boolean {
  return width > 0 && reveal >= width * ROW_SWIPE_FULL_FRACTION;
}

export type RowSwipeRelease = "full" | "open" | "close";

/**
 * What releasing a row open by `reveal` px does, moving at `velocity` px/s
 * (positive: further open), with the side's buttons `actionsWidth` px wide in all.
 */
export function rowSwipeRelease(reveal: number, velocity: number, width: number, actionsWidth: number): RowSwipeRelease {
  if (rowSwipeFull(reveal, width)) return "full";
  if (velocity >= ROW_SWIPE_FLING_VELOCITY) return "open";
  if (velocity <= -ROW_SWIPE_FLING_VELOCITY) return "close";
  return reveal > 0 && reveal >= actionsWidth * ROW_SWIPE_OPEN_FRACTION ? "open" : "close";
}

/** raft-ui's pull-to-refresh tick: a 10ms vibration, where the browser can vibrate. */
export function rowSwipeHapticTick(): void {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(10);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Stroke = {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  startsInEdgeZone: boolean;
  /** The row was open when the finger went down. */
  wasOpen: boolean;
  decision: RowSwipeDecision;
  /** The side the stroke moves the row on, once claimed. */
  side: RowSwipeSide;
  /** Where the finger was when the row claimed the drag: the row moves from there, without a jump. */
  claimX: number;
  /** How far the row was open on `side` when the drag was claimed. */
  baseReveal: number;
  reveal: number;
  full: boolean;
  samples: { t: number; x: number }[];
};

type Phase = "dragging" | "settling" | "open" | null;

export type RowSwipe<T extends HTMLElement> = {
  /** The row: it carries `data-swipe`, `data-swipe-side`, `data-swipe-full` and the reveal custom properties. */
  ref: (element: T | null) => void;
  /** Spread on the row. Inert unless `enabled`. */
  handlers: {
    onPointerDown: (event: ReactPointerEvent<T>) => void;
    onPointerMove: (event: ReactPointerEvent<T>) => void;
    onPointerUp: (event: ReactPointerEvent<T>) => void;
    onPointerCancel: (event: ReactPointerEvent<T>) => void;
  };
};

/**
 * Swipe-to-uncover for one row, on either side. The row's state is written
 * to the DOM, not to React state, so a drag doesn't render the row on every
 * move: `data-swipe` is `dragging` while the finger holds it, `settling`
 * while it slides, `open` while it rests open on a side's buttons;
 * `data-swipe-side` is that side while it is any of those; `data-swipe-full`
 * is `true` while a release would apply the side's full-swipe action (and
 * while a `remove` row slides away); `--row-swipe-reveal` and
 * `--row-swipe-reveal-start` are how far it is open on its end and its start.
 */
export function useRowSwipe<T extends HTMLElement>({
  enabled,
  end,
  start,
  open,
  onOpenChange,
  shouldYield,
  onFull,
  haptics = true,
}: {
  enabled: boolean;
  /** The buttons a swipe left uncovers, at the row's end. None: no left swipe. */
  end?: RowSwipeActions;
  /** The buttons a swipe right uncovers, at the row's start. None: no right swipe. */
  start?: RowSwipeActions;
  /** Whether this row is the open one (on either side). The parent closes it by setting this false. */
  open: boolean;
  /** The row asks to rest open, or to close. */
  onOpenChange: (open: boolean) => void;
  /** Asked before a drag is claimed; true hands the stroke back, e.g. a long press already opened the row's menu. */
  shouldYield?: () => boolean;
  /** Called each time the drag crosses into full (not again while it stays past it). */
  onFull?: (side: RowSwipeSide) => void;
  /** Vibrate briefly on each crossing into full (`rowSwipeHapticTick`). On by default. */
  haptics?: boolean;
}): RowSwipe<T> {
  const elementRef = useRef<T | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  /** How far the row is open, and on which side. */
  const revealRef = useRef(0);
  const sideRef = useRef<RowSwipeSide>("end");
  const settleTimerRef = useRef<number | null>(null);
  /**
   * The full swipe that is sliding, to apply once it has: its side, and the
   * action and its kind as they were when the finger lifted, so what applies
   * is what the person released on (the row may render again meanwhile).
   */
  const commitRef = useRef<{ side: RowSwipeSide; apply: () => void; keep: boolean } | null>(null);
  const latest = useRef({ open, end, start, onOpenChange, shouldYield, onFull, haptics });
  useEffect(() => {
    latest.current = { open, end, start, onOpenChange, shouldYield, onFull, haptics };
  });

  const write = useCallback((side: RowSwipeSide, reveal: number, phase: Phase, full = false) => {
    revealRef.current = reveal;
    sideRef.current = side;
    const element = elementRef.current;
    if (!element) return;
    element.style.setProperty(ROW_SWIPE_REVEAL_VAR, `${side === "end" ? reveal : 0}px`);
    element.style.setProperty(ROW_SWIPE_REVEAL_START_VAR, `${side === "start" ? reveal : 0}px`);
    if (phase) {
      element.setAttribute("data-swipe", phase);
      element.setAttribute("data-swipe-side", side);
    } else {
      element.removeAttribute("data-swipe");
      element.removeAttribute("data-swipe-side");
    }
    if (full) element.setAttribute("data-swipe-full", "true");
    else element.removeAttribute("data-swipe-full");
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const finishFullSwipe = useCallback(() => {
    settleTimerRef.current = null;
    const commit = commitRef.current;
    if (commit === null) return;
    commitRef.current = null;
    if (commit.keep) {
      // Back closed where it was; the action changes how it reads.
      write(commit.side, 0, null);
      commit.apply();
      return;
    }
    // The row leaves the list before it is closed again, in one synchronous
    // render, so the whole row never paints for a frame in between. A row
    // that comes back (Undo) is a new one, closed; one that stays (its owner
    // kept it) is closed here.
    flushSync(() => commit.apply());
    write(commit.side, 0, null);
  }, [write]);

  /** Slide to `target` px on `side` and rest there (`open`) or closed; under reduced motion, jump. */
  const slideTo = useCallback((side: RowSwipeSide, target: number) => {
    clearSettleTimer();
    const rest: Phase = target > 0 ? "open" : null;
    if (prefersReducedMotion()) {
      write(side, target, rest);
      return;
    }
    write(side, target, "settling");
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      write(side, target, rest);
    }, ROW_SWIPE_SETTLE_MS);
  }, [clearSettleTimer, write]);

  /** A full swipe released on `side`: slide out across `width` (`remove`) or back closed (`keep`), then apply it. */
  const fullSwipe = useCallback((side: RowSwipeSide, width: number, actions: RowSwipeActions) => {
    clearSettleTimer();
    const keep = actions.fullSwipe === "keep";
    commitRef.current = { side, apply: actions.onFullSwipe, keep };
    if (prefersReducedMotion()) {
      finishFullSwipe();
      return;
    }
    if (keep) write(side, 0, "settling");
    else write(side, width, "settling", true);
    settleTimerRef.current = window.setTimeout(finishFullSwipe, ROW_SWIPE_SETTLE_MS);
  }, [clearSettleTimer, finishFullSwipe, write]);

  // The parent closed the row (another row opened, a tap elsewhere, a scroll).
  useEffect(() => {
    if (open || strokeRef.current?.decision === "claim" || commitRef.current !== null) return;
    if (revealRef.current > 0) slideTo(sideRef.current, 0);
  }, [open, slideTo]);

  // A row that leaves mid-slide still applies what the person released.
  useEffect(() => () => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    const commit = commitRef.current;
    if (commit !== null) {
      commitRef.current = null;
      commit.apply();
    }
  }, []);

  const ref = useCallback((element: T | null) => {
    elementRef.current = element;
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<T>) => {
    if (!enabled || event.pointerType !== "touch" || !event.isPrimary) return;
    // Sliding away or back to apply a full swipe: the row is already going.
    if (commitRef.current !== null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fromLeft = event.clientX - rect.left;
    const fromRight = rect.right - event.clientX;
    strokeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      startsInEdgeZone: fromLeft < ROW_SWIPE_EDGE_ZONE || fromRight < ROW_SWIPE_EDGE_ZONE,
      wasOpen: latest.current.open && revealRef.current > 0,
      decision: "undecided",
      side: sideRef.current,
      claimX: event.clientX,
      baseReveal: revealRef.current,
      reveal: revealRef.current,
      full: false,
      samples: [{ t: event.timeStamp, x: event.clientX }],
    };
  }, [enabled]);

  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId || stroke.decision === "release") return;
    if (stroke.decision === "undecided") {
      if (latest.current.shouldYield?.()) {
        stroke.decision = "release";
        return;
      }
      const dx = event.clientX - stroke.startX;
      // An open row moves either way on its own side (further open, or
      // closed); a closed one only toward a side with buttons.
      stroke.decision = rowSwipeDecision(dx, event.clientY - stroke.startY, {
        startsInEdgeZone: stroke.startsInEdgeZone,
        left: stroke.wasOpen || hasButtons(latest.current.end),
        right: stroke.wasOpen || hasButtons(latest.current.start),
      });
      if (stroke.decision !== "claim") return;
      clearSettleTimer();
      stroke.side = stroke.wasOpen ? sideRef.current : dx < 0 ? "end" : "start";
      stroke.claimX = event.clientX;
      stroke.baseReveal = stroke.side === sideRef.current ? revealRef.current : 0;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a convenience: the touch already targets the row.
      }
    }
    // Positive: further open on the stroke's side (left uncovers the end).
    const moved = stroke.side === "end" ? stroke.claimX - event.clientX : event.clientX - stroke.claimX;
    stroke.reveal = Math.min(Math.max(stroke.baseReveal + moved, 0), stroke.width);
    stroke.samples.push({ t: event.timeStamp, x: event.clientX });
    if (stroke.samples.length > 8) stroke.samples.shift();
    const full = rowSwipeFull(stroke.reveal, stroke.width);
    if (full && !stroke.full) {
      if (latest.current.haptics) rowSwipeHapticTick();
      latest.current.onFull?.(stroke.side);
    }
    stroke.full = full;
    write(stroke.side, stroke.reveal, "dragging", full);
  }, [clearSettleTimer, write]);

  const onPointerUp = useCallback((event: ReactPointerEvent<T>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    strokeRef.current = null;
    if (stroke.decision !== "claim") {
      // A tap on the open row closes it, and does nothing else; a tap on one
      // of its buttons is that button's.
      const onAction = event.target instanceof Element && event.target.closest(`[${ROW_SWIPE_ACTION_ATTR}]`) !== null;
      if (stroke.decision === "undecided" && stroke.wasOpen && !onAction) {
        swallowClickAfterPress(event.nativeEvent);
        latest.current.onOpenChange(false);
      }
      return;
    }
    // A swipe never opens the row: a click a browser may send after it is the swipe's.
    swallowClickAfterPress(event.nativeEvent);
    const { side } = stroke;
    const recent = stroke.samples.filter((sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW_MS);
    const first = recent[0];
    const elapsed = first ? event.timeStamp - first.t : 0;
    // Positive: further open on the stroke's side.
    const moved = first ? (side === "end" ? first.x - event.clientX : event.clientX - first.x) : 0;
    const velocity = elapsed > 0 ? (moved / elapsed) * 1000 : 0;
    const { onOpenChange: setOpen } = latest.current;
    const actions = latest.current[side];
    // The side lost its buttons mid-stroke (the row changed): close.
    const release = hasButtons(actions) ? rowSwipeRelease(stroke.reveal, velocity, stroke.width, actions.width) : "close";
    if (release === "full" && actions) {
      setOpen(false);
      fullSwipe(side, stroke.width, actions);
    } else if (release === "open" && actions) {
      slideTo(side, actions.width);
      setOpen(true);
    } else {
      slideTo(side, 0);
      setOpen(false);
    }
  }, [fullSwipe, slideTo]);

  const onPointerCancel = useCallback((event: ReactPointerEvent<T>) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    strokeRef.current = null;
    // The browser took the stroke (it scrolls the list): never leave a row half open.
    if (stroke.decision === "claim" || stroke.wasOpen) {
      slideTo(sideRef.current, 0);
      latest.current.onOpenChange(false);
    }
  }, [slideTo]);

  return {
    ref,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
