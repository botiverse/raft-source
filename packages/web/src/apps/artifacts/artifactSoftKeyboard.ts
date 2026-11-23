import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

import { readSoftKeyboardBox, subscribeSoftKeyboard } from "../../utils/visualViewport";

export type SoftKeyboardBox = { bottom: number; inset: number; height: number };

/**
 * The visible area while the on-screen keyboard is up (`readSoftKeyboardBox`), kept current as the
 * keyboard opens, closes and the browser scrolls the visible area; `null` while it is down or
 * `active` is false. For a phone's comment sheet (ArtifactCardShell), which is drawn on the page's
 * bottom outside #root: #root shrinks above the keyboard (trackVisualViewport), the sheet does not
 * unless it is told how far to rise (xxchan, #proj-mobile msg=9e51cd9d: the box was under the
 * keyboard in a phone's browser). The iOS app's WKWebView shrinks only the visual viewport, as Safari does, so the
 * sheet rises there too (Lagoon: the app-side lift, mobile #5053, was withdrawn); a WebView that resizes its whole
 * layout never marks #root, and nothing moves.
 */
export function useSoftKeyboardBox(active: boolean, frozen = false): SoftKeyboardBox | null {
  // `frozen`: the last box this caller saw while live, not followed any more (a sheet on its way
  // out, which iOS's blur on close would otherwise drop behind the keyboard in its first frame).
  const held = useRef<SoftKeyboardBox | null>(null);
  const read = useCallback(() => {
    if (frozen) return held.current;
    const box = snapshot();
    held.current = box;
    return box;
  }, [frozen]);
  const live = active && !frozen;
  return useSyncExternalStore(live ? subscribe : subscribeNone, active ? read : none, none);
}

let last: SoftKeyboardBox | null = null;

/** The same object while nothing moved by a whole pixel, as useSyncExternalStore needs. */
function snapshot(): SoftKeyboardBox | null {
  const read = readSoftKeyboardBox();
  if (!read) return (last = null);
  const next = { bottom: Math.round(read.bottom), inset: Math.round(read.inset), height: Math.round(read.height) };
  if (last && last.bottom === next.bottom && last.inset === next.inset && last.height === next.height) return last;
  return (last = next);
}

function none(): null {
  return null;
}

function subscribeNone(): () => void {
  return () => {};
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  // The viewport's events can come many times a frame while the keyboard slides: once a frame.
  let frame: number | null = null;
  const schedule = () => {
    if (typeof window.requestAnimationFrame !== "function") return onChange();
    frame ??= window.requestAnimationFrame(() => {
      frame = null;
      onChange();
    });
  };
  const vv = window.visualViewport;
  vv?.addEventListener("resize", schedule);
  vv?.addEventListener("scroll", schedule, { passive: true });
  // #root's `data-soft-keyboard`, written a frame after the keyboard moves (trackVisualViewport).
  const stop = subscribeSoftKeyboard(schedule);
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    vv?.removeEventListener("resize", schedule);
    vv?.removeEventListener("scroll", schedule);
    stop();
  };
}

/**
 * The phone sheet's place while the keyboard is up: its bottom on the keyboard's top edge, no
 * taller than 90% of what the keyboard leaves (raft-ui's 82vh and 16rem floor are of the whole
 * screen), and no home-indicator inset under it, which the keyboard covers. Raft-ui's bottom
 * Drawer is fixed to the page's bottom and portaled outside #root, which alone shrinks above the
 * keyboard (trackVisualViewport). `undefined` (raft-ui's own place) while the keyboard is down.
 */
export function keyboardSheetStyle(keyboard: SoftKeyboardBox | null): CSSProperties | undefined {
  if (!keyboard) return undefined;
  const tallest = Math.round(keyboard.height * 0.9);
  return {
    bottom: `${keyboard.inset}px`,
    maxHeight: `${tallest}px`,
    minHeight: `min(16rem, ${tallest}px)`,
    paddingBottom: 0,
  };
}

/**
 * While the keyboard is up (`up`), the field being typed in kept in view inside the sheet's own
 * scroller (raft-ui's DrawerBody): once the sheet has risen and shrunk to fit, and again whenever the
 * sheet changes size; a box taller than the view is left to the browser's caret scrolling. Only that scroller moves, never the page,
 * and panning the page does not pull a sheet the person scrolled back to the field.
 */
export function useFieldInSheetView(popup: HTMLElement | null, up: boolean): void {
  useEffect(() => {
    if (!popup || !up) return;
    const reveal = () => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !popup.contains(focused)) return;
      const scroller = focused.closest<HTMLElement>("[data-slot='drawer-body']");
      if (!scroller || !popup.contains(scroller)) return;
      const field = focused.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      // A box that already fills the view (a long draft): the browser keeps its caret in view.
      if (field.top <= view.top && field.bottom >= view.bottom) return;
      if (field.bottom > view.bottom) scroller.scrollTop += Math.min(field.bottom - view.bottom, field.top - view.top);
      else if (field.top < view.top) scroller.scrollTop -= view.top - field.top;
    };
    const frame = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(reveal) : null;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reveal);
    observer?.observe(popup);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [popup, up]);
}
