// When the otter on a composer sinks into it (#proj-assistant #20, option a):
// it floats over its conversation's message list and takes no room there, so
// the list never moves for it. Instead, whenever it would cover the end of
// that list (the last message's text reaching under it, or the pointer on the
// last message, whose toolbar then shows), it goes into the composer head
// first, as it does while the person types.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** A message row of VirtualMessageTimeline (a folded group is one row, its first message's). */
const MESSAGE_ROW = "[data-timeline-message-id]";

/**
 * The message list beside this composer: the nearest one around its frame,
 * unless another composer's frame comes first (a thread panel whose list is
 * still loading next to a channel's must not take the channel's list).
 */
function hostTimeline(from: Element): HTMLElement | null {
  const frame = from.closest("[data-composer-frame-edge]");
  for (let el = frame?.parentElement ?? null; el; el = el.parentElement) {
    if (el.querySelectorAll("[data-composer-frame-edge]").length > 1) return null;
    const timeline = el.querySelector<HTMLElement>("[data-virtual-timeline]");
    if (timeline) return timeline;
  }
  return null;
}

/** The list's last message row in the DOM: the bottom one whenever the list's end can be in view. */
function lastMessageRow(timeline: HTMLElement): HTMLElement | null {
  const rows = timeline.querySelectorAll<HTMLElement>(MESSAGE_ROW);
  return rows[rows.length - 1] ?? null;
}

type Box = { left: number; top: number; right: number; bottom: number };

function overlaps(a: Box, b: Box): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

/**
 * A line of the row's text inside `box`. Read from the row's end upward,
 * stopping at the first text wholly above the box: the text before it in the
 * row is higher still.
 */
function textUnder(row: HTMLElement, box: Box): boolean {
  if (!overlaps(row.getBoundingClientRect(), box)) return false;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let last: Node = row;
  while (last.lastChild) last = last.lastChild;
  walker.currentNode = last;
  const range = document.createRange();
  for (let node: Node | null = last.nodeType === Node.TEXT_NODE ? last : walker.previousNode(); node; node = walker.previousNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
    if (lines.some((rect) => overlaps(rect, box))) return true;
    if (lines.length > 0 && lines.every((rect) => rect.bottom <= box.top)) return false;
  }
  return false;
}

/**
 * True while the otter should sink. `rest` is where it rests (not where it
 * is: it measures the same sunk or not), `extra` what lies beside it (its
 * bubble). Measured again on any scroll, the list's size or content changing,
 * the pointer moving onto or off a message, and `look` (its pose and bubble,
 * by mood) changing.
 */
export function useOtterSink(rest: RefObject<HTMLElement | null>, extra: RefObject<HTMLElement | null>, look: string): boolean {
  const [sunk, setSunk] = useState(false);
  // The message row under the pointer: kept across a mood change (a DM
  // arriving must not raise the otter over the toolbar it made room for).
  const hovered = useRef<Element | null>(null);
  useEffect(() => {
    const restEl = rest.current;
    if (!restEl) return;
    let observed: HTMLElement | null = null;
    let frame = 0;
    function schedule() {
      if (!frame) frame = requestAnimationFrame(evaluate);
    }
    // Absent only where nothing lays out (a DOM test).
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    // A message arriving, edited or deleted at the end of a list that does not scroll (a short channel).
    const content = new MutationObserver(schedule);
    function evaluate() {
      frame = 0;
      const timeline = hostTimeline(restEl!);
      if (timeline !== observed) {
        resize?.disconnect();
        content.disconnect();
        if (timeline) {
          resize?.observe(timeline);
          content.observe(timeline, { childList: true, subtree: true, characterData: true });
        }
        observed = timeline;
      }
      const row = timeline ? lastMessageRow(timeline) : null;
      if (!timeline || !row) return setSunk(false);
      // Its box, cut to the list's view: rows scrolled out of it are hidden.
      const own = restEl!.getBoundingClientRect();
      const beside = extra.current?.getBoundingClientRect();
      const view = timeline.getBoundingClientRect();
      const box = {
        left: Math.max(view.left, Math.min(own.left, beside?.left ?? Infinity)),
        top: Math.max(view.top, Math.min(own.top, beside?.top ?? Infinity)),
        right: Math.min(view.right, Math.max(own.right, beside?.right ?? -Infinity)),
        bottom: Math.min(view.bottom, Math.max(own.bottom, beside?.bottom ?? -Infinity)),
      };
      setSunk(row.contains(hovered.current) || textUnder(row, box));
    }
    const onPointerOver = (event: PointerEvent) => {
      // A touch shows no hover toolbar.
      if (event.pointerType === "touch") return;
      hovered.current = event.target instanceof Element ? event.target.closest(MESSAGE_ROW) : null;
      schedule();
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      hovered.current = null;
      schedule();
    };
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("pointerover", onPointerOver, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    evaluate();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      content.disconnect();
      document.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("resize", schedule);
    };
  }, [rest, extra, look]);
  return sunk;
}
