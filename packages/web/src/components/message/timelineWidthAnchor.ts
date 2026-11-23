import { useCallback, useEffect, useMemo, useRef } from "react";

import type { TimelineTopAnchor } from "./timelineTopRow";

export type { TimelineTopAnchor } from "./timelineTopRow";

/** A reading: the message first in view and its offset, and whether the view was at the end of content taller than it. */
interface TimelineWidthReading {
  anchor: TimelineTopAnchor | null;
  atEnd: boolean;
}

/**
 * A width change of the timeline's scroller (a seam dragged, the window resized, the sidebar toggled, the thread
 * folding over the conversation or standing beside it; #189) rewraps every row. Across it, a reader scrolled away from
 * the end keeps the message first in view at its offset, on every surface (channel, DM and thread). Where
 * `keepTopWhenShort` (the thread), a list whose content fitted its view before narrowing also keeps its top message
 * (the parent under the head) rather than following its end; a channel (`!keepTopWhenShort`) following its tail stays
 * at its end whether short or overflowing (`atEnd`). `note` reads that message a frame after the reader scrolls or the
 * list adjusts (the width it was read at, the first time); content that fits its view leaves a prior thread reading as
 * it was; and none is taken while a width change waits for `take`. `take` gives back, once the scroller's width
 * changed, "end" where the view was at its end and may follow it (`canEnd`), else the message; null where unchanged.
 */
export function useTimelineWidthAnchor(
  keepTopWhenShort: boolean,
  listEl: () => HTMLElement | null,
  topOf: (el: HTMLElement) => TimelineTopAnchor | null,
  following: { readonly current: boolean },
): { note: () => void; take: (el: HTMLElement, canEnd: boolean) => TimelineTopAnchor | "end" | null } {
  const reading = useRef<TimelineWidthReading | null>(null);
  const width = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const note = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = listEl();
      if (!el) return;
      // Only `take` moves the width on: a read landing after a width change and before the list's resize handling
      // still holds the message where it was (rows grow downward from it), and must not hide the change.
      const now = el.getBoundingClientRect().width;
      width.current ??= now;
      if (Math.abs(now - width.current) >= 0.5) return;
      const overflows = el.scrollHeight - el.clientHeight > 1;
      if (!overflows && reading.current) {
        if (!keepTopWhenShort && following.current) reading.current = { anchor: topOf(el), atEnd: true };
        return;
      }
      const atEnd = keepTopWhenShort ? overflows && following.current : following.current;
      reading.current = { anchor: topOf(el), atEnd };
    });
  }, [following, keepTopWhenShort, listEl, topOf]);
  // Read once as it mounts too: a list that never scrolls nor resizes its content before its width changes.
  useEffect(() => {
    note();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [note]);
  const take = useCallback((el: HTMLElement, canEnd: boolean): TimelineTopAnchor | "end" | null => {
    const next = el.getBoundingClientRect().width;
    const was = width.current;
    width.current = next;
    if (was === null || Math.abs(next - was) < 0.5 || !reading.current) return null;
    return reading.current.atEnd && canEnd ? "end" : reading.current.anchor;
  }, []);
  return useMemo(() => ({ note, take }), [note, take]);
}
