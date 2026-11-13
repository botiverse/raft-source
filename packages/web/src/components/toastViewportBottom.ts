import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { PHONE_MEDIA_QUERY } from "./ui/NarrowDialog";
import { readSoftKeyboardOpen, subscribeSoftKeyboard } from "../utils/visualViewport";

/**
 * Where a toast sits, at every width (Raft DS › Toast › Where it appears,
 * stdrc 2026-10-23; every width since raft-design #1217, Jasper,
 * #triage:#334): just above whatever holds the bottom of the page: the
 * composer on a conversation page (or the bar in its place), the tab bar on
 * a phone's tab root, and the on-screen keyboard while it is up; a page with
 * no floor puts it at the window's bottom. raft-ui (0.28) puts the toast 16px
 * above `--toast-viewport-bottom`, the distance from the window's bottom to
 * that thing's top edge; only the app knows it, so it is measured here.
 *
 * - What can hold the bottom registers itself as a "floor"
 *   (`useToastViewportFloor`): a conversation's and a thread's footer (the
 *   composer, or the select-mode toolbar, the read-only, archived, guest or
 *   Join bar in its place), any other composer, and the tab bar. A
 *   ResizeObserver follows a floor that grows (a longer draft) or hides (the
 *   tab bar while the keyboard is up). A floor counts as the distance from
 *   its top edge to #root's bottom, so padding or anything under it is
 *   included. Of several on screen, those lowest on the page count, and the
 *   tallest of them wins: a toast too high is harmless, one too low covers
 *   (so a conversation's footer hidden under a phone thread can lift the
 *   thread's toast a little; a desktop thread open beside its channel has
 *   both footers on the page's bottom, and the taller one, the longer draft,
 *   wins). Wider than a phone, only a floor that reaches the page's bottom
 *   counts: a composer floating mid-page there (a dialog's, a comment
 *   bubble's) does not hold the bottom, and would otherwise lift the toast
 *   up the window, and neither does one under a dialog or the Artifact cover
 *   (hit-tested at its top edge). Floors are measured again when one
 *   resizes, registers or leaves, on window / visual viewport resize, scroll
 *   or the keyboard, and every 250 ms while one reads as covered (an overlay
 *   leaving fires none of those); a floor that only moves, without any of
 *   those, is not seen.
 * - The keyboard: with it up on iOS, `position: fixed` (the toast) is laid out
 *   against the layout viewport, which the keyboard does not shrink, while
 *   #root is pinned to the visual viewport above it (utils/visualViewport.ts).
 *   So the keyboard's part is what the visual viewport leaves at the layout
 *   viewport's bottom: `innerHeight - visualViewport.height -
 *   visualViewport.offsetTop`, counted only while #root says the keyboard is
 *   up (otherwise #root isn't pinned and a short visual viewport, e.g. a stale
 *   one after a PWA resume, says nothing about the composer). Where the
 *   keyboard shrinks the layout viewport itself (Android Chrome's default),
 *   #root is never pinned, `fixed` already sits above the keyboard, and the
 *   part is 0.
 * - While a toast shows, it does not move down with the page (raft-design
 *   toast.md › Where it appears, artin 2026-11-07, #proj-raft-ui:#208): when
 *   the page changes under it (another page's bar is lower, or a page still
 *   loading has no floor yet), the tallest page part (the floors' distance)
 *   seen since the toast appeared is held until the last toast is gone, and a
 *   taller one raises it, so it never covers the composer. The keyboard is not
 *   part of that: while it is up the toast follows the live edge (keyboard
 *   part plus the composer riding on it, which #root, pinned above the
 *   keyboard, already measures without the keyboard), and nothing measured
 *   then is held, so when it closes the toast comes back to the held height.
 *   Shown = max(held, live), as the mobile app's RaftToastHost
 *   (botiverse/mobile #4398).
 * - A notice that sits where toasts go (the new-version banner,
 *   NewWebVersionBanner) registers itself (`useToastViewportNotice`) and is
 *   placed by this same measure, without notices (`stackOnNotices` false):
 *   16px above the composer (or the bar in its place), 16px above the
 *   window's bottom on a page without a floor. A toast shown with it stacks
 *   above it, 16px clear: the toast's offset is at least the notice's top
 *   (its resolved CSS `bottom` plus its height). Stacking, not a higher
 *   layer: a toast over it would hide its Reload for 5 to 8 seconds.
 * - A notice in the page's flow (`useToastViewportFlowNotice`): a phone's
 *   open-in-app row sits in flow right above the tab bar (or is the last
 *   thing in the window, as on the sign-in page), so it is not the
 *   bottom-most floor and has no `bottom` of its own. It is part of the
 *   bottom of the page (raft-design #1218): a toast and a floating notice
 *   (the new-version banner, placing itself) both sit above its top edge,
 *   measured from #root's bottom as a floor's is. In a composer's footer the
 *   row is inside the floor, so the floor's own top edge already is the
 *   row's.
 *
 * The value goes on the toast viewport itself, not on :root: a custom property
 * on :root restyles the whole document each time it changes (index.css, #root).
 */

const floors = new Set<Element>();
const notices = new Set<Element>();
/** Notices in the page's flow, not `fixed` at a `bottom` of their own. */
const flowNotices = new WeakSet<Element>();
const listeners = new Set<() => void>();
let resizeObserver: ResizeObserver | null | undefined;

function notify() {
  for (const listener of listeners) listener();
}

function observer(): ResizeObserver | null {
  if (resizeObserver === undefined) {
    resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(notify) : null;
  }
  return resizeObserver;
}

function register(set: Set<Element>, element: Element): () => void {
  set.add(element);
  observer()?.observe(element);
  notify();
  return () => {
    set.delete(element);
    observer()?.unobserve(element);
    notify();
  };
}

/** Counts `element` as something a toast must sit above, until the returned cleanup. */
export function registerToastViewportFloor(element: Element): () => void {
  return register(floors, element);
}

/** A callback ref for a floor's root element (React 19 ref cleanup). */
export function useToastViewportFloor(): (element: Element | null) => (() => void) | undefined {
  return useCallback((element: Element | null) => (element ? registerToastViewportFloor(element) : undefined), []);
}

/** Counts `element` as a notice at the toast's place, which a toast stacks above, until the returned cleanup. */
export function registerToastViewportNotice(element: Element): () => void {
  return register(notices, element);
}

/** A callback ref for a notice's root element (React 19 ref cleanup). */
export function useToastViewportNotice(): (element: Element | null) => (() => void) | undefined {
  return useCallback((element: Element | null) => (element ? registerToastViewportNotice(element) : undefined), []);
}

/**
 * A callback ref for a notice that is in the page's flow, right above the
 * floor (a phone's open-in-app row above the tab bar): a toast stacks above
 * its top edge, measured as a floor's is.
 */
export function useToastViewportFlowNotice(): (element: Element | null) => (() => void) | undefined {
  return useCallback((element: Element | null) => {
    if (!element) return undefined;
    flowNotices.add(element);
    return registerToastViewportNotice(element);
  }, []);
}

/** A notice moved without resizing (its own offset changed): measure again. */
export function toastViewportNoticeMoved(): void {
  notify();
}

/**
 * The highest visible notice's top edge, as a distance from the window's
 * bottom: its resolved CSS `bottom` (a fixed element's, so already counting
 * the safe area and the keyboard as the notice placed itself) plus its
 * height. A notice in the page's flow has no `bottom`: its top edge from
 * #root's bottom, as a floor's. Null without one. `flowOnly`: a floating
 * notice placing itself counts those in the page's flow, which it must not
 * cover either, and no floating one (itself).
 */
function noticeTop(flowOnly: boolean): number | null {
  let top: number | null = null;
  for (const element of notices) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (flowNotices.has(element)) {
      top = Math.max(top ?? 0, pageBottomEdge() - rect.top);
      continue;
    }
    if (flowOnly) continue;
    const bottom = Number.parseFloat(getComputedStyle(element).bottom) || 0;
    top = Math.max(top ?? 0, bottom + rect.height);
  }
  return top;
}

/** #root's bottom edge (the window's without #root). */
function pageBottomEdge(): number {
  return document.getElementById("root")?.getBoundingClientRect().bottom || window.innerHeight;
}

/** The keyboard's height over the layout viewport's bottom while #root is pinned above it, else 0. */
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv || !readSoftKeyboardOpen()) return 0;
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
}

/** Marks the toast viewport, which `covered` sees through. */
const RECHECK_COVERED_MS = 250;
const TOAST_VIEWPORT_ATTRIBUTE = "data-toast-viewport"; // set in LocalizedToastProvider

/**
 * Whether something drawn over `element` hides its top edge: a dialog, the
 * Artifact cover. Toasts and notices, which sit right above a floor, and an
 * overlay on its way out (Base UI's closed / exit state) don't count. Without
 * hit testing (jsdom), nothing is covered.
 */
/** Set by the last measure: a floor was skipped as covered (see `useToastViewportBottom`). */
let sawCoveredFloor = false;

function covered(element: Element, rect: DOMRect): boolean {
  if (typeof document.elementsFromPoint !== "function") return false;
  for (const hit of document.elementsFromPoint(rect.left + rect.width / 2, rect.top + 1)) {
    if (element.contains(hit)) return false;
    if (hit.closest(`[${TOAST_VIEWPORT_ATTRIBUTE}],[data-ending-style],[data-closed]`)) continue;
    if ([...notices].some((notice) => notice.contains(hit))) continue;
    return true;
  }
  return false;
}

/**
 * The bottom-most visible floors' distance from #root's bottom (the window's
 * without #root). Wider than a phone, only floors that reach the page's
 * bottom and that nothing covers count: a composer floating mid-page there (a
 * dialog's, a comment bubble's), or one under a dialog or the Artifact cover,
 * does not hold it.
 */
function floorDistance(): number {
  const pageBottom = pageBottomEdge();
  const phone = typeof window.matchMedia === "function" && window.matchMedia(PHONE_MEDIA_QUERY).matches;
  let lowestBottom = Number.NEGATIVE_INFINITY;
  let distance = 0;
  sawCoveredFloor = false;
  for (const element of floors) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue; // hidden, e.g. the tab bar under a keyboard
    if (!phone && rect.bottom < pageBottom - 1) continue;
    if (!phone && covered(element, rect)) {
      sawCoveredFloor = true;
      continue;
    }
    const fromBottom = Math.max(0, pageBottom - rect.top);
    if (rect.bottom > lowestBottom + 1) {
      lowestBottom = rect.bottom;
      distance = fromBottom;
    } else if (rect.bottom >= lowestBottom - 1) {
      distance = Math.max(distance, fromBottom);
    }
  }
  return distance;
}

type ToastViewportParts = { keyboardOpen: boolean; keyboard: number; page: number };

/** The keyboard's and the page's parts of the offset, at every width. */
function measureToastViewportParts(): ToastViewportParts {
  return { keyboardOpen: readSoftKeyboardOpen(), keyboard: keyboardInset(), page: floorDistance() };
}

/**
 * Tracks `--toast-viewport-bottom` in px at every width (null, unset, only
 * before the first measure): the live offset (keyboard part + page part), but
 * while `showing` (a toast is on screen) never below the tallest page part
 * measured with the keyboard down since it appeared. With `stackOnNotices`
 * (the toast viewport's), never below a registered notice's top either; a
 * notice measures its own place with it off.
 */
export function useToastViewportBottom(showing: boolean, stackOnNotices = true): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  const showingRef = useRef(showing);
  const heldPage = useRef(0);
  const updateRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    showingRef.current = showing;
    if (!showing) heldPage.current = 0;
    updateRef.current();
  }, [showing]);
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    // The offset now: 0 on a page without a floor (the window's bottom).
    const measure = (): number => {
      const parts = measureToastViewportParts();
      const notice = noticeTop(!stackOnNotices);
      const live = parts.keyboard + parts.page;
      if (!showingRef.current) return Math.round(Math.max(live, notice ?? 0));
      // A notice put away while the toast shows does not drop the toast either.
      if (!parts.keyboardOpen) heldPage.current = Math.max(heldPage.current, parts.page, notice ?? 0);
      return Math.round(Math.max(heldPage.current, live, notice ?? 0));
    };
    // An overlay leaving (a dialog closing) fires nothing measured here: while
    // a floor reads as covered, measure again every RECHECK_COVERED_MS.
    let recheck: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      setBottom(measure());
      if (sawCoveredFloor && recheck === null) {
        recheck = setTimeout(() => {
          recheck = null;
          updateRef.current();
        }, RECHECK_COVERED_MS);
      }
    };
    updateRef.current = update;
    // The visual viewport fires many events a frame while the keyboard moves:
    // measure once per frame.
    let frame: number | null = null;
    const schedule = () => {
      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        update();
      });
    };
    update();
    const vv = window.visualViewport;
    listeners.add(schedule);
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const unsubscribeKeyboard = subscribeSoftKeyboard(schedule);
    return () => {
      listeners.delete(schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      unsubscribeKeyboard();
      updateRef.current = () => {};
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (recheck !== null) clearTimeout(recheck);
    };
  }, [stackOnNotices]);
  return bottom;
}
