import { useCallback, useEffect, useMemo, useRef } from "react";

import { distanceFromBottom } from "./messageTimelineShared";

export interface TimelineTopAnchor {
  id: string;
  offset: number;
}

/** A reading: the message first in view and its offset, and whether the view was at the end of content taller than it. */
interface TimelineWidthReading {
  anchor: TimelineTopAnchor | null;
  atEnd: boolean;
}

/**
 * A width change of the timeline's scroller (a seam dragged, the window resized, the sidebar toggled, the thread
 * folding over the conversation or standing beside it; #189) rewraps every row. Where `enabled` (the thread), the
 * message first in view stays at its offset across it, rather than the list following its end: a thread whose
 * replies just filled its view keeps its parent under the head, not under it. A view at the end of content taller
 * than it stays at its end (`atEnd`): a thread at its last reply before a region expanded in its row is there again
 * when the row is restored (#189 rule 5), however the content fitted in between. `note` reads that message a frame
 * after the reader scrolls or the list adjusts (the width it was read at, the first time); content that fits its view
 * (at its top and its end at once) leaves the reading before it as it was, the first one aside; one taken while the
 * list follows its end (`following`) is at its end, though a reflow has the view short of it for a frame or two (a
 * column narrowed to 160 rewraps the replies before the list re-pins them); and none is taken while a width change
 * waits for `take` (the browser's scroll anchoring scrolls the rewrapped rows before the list hears of the resize, and
 * would have the reading say the view left its end). `take` gives back,
 * once the scroller's width changed, "end" where the view was at its end and may follow it (`canEnd`: the list holds
 * its live end), else the message; null where the width didn't change.
 */
export function useTimelineWidthAnchor(
  enabled: boolean,
  listEl: () => HTMLElement | null,
  topOf: (el: HTMLElement) => TimelineTopAnchor | null,
  following: { readonly current: boolean },
): { note: () => void; take: (el: HTMLElement, canEnd: boolean) => TimelineTopAnchor | "end" | null } {
  const reading = useRef<TimelineWidthReading | null>(null);
  const width = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const note = useCallback(() => {
    if (!enabled || frame.current !== null) return;
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
      if (!overflows && reading.current) return;
      reading.current = { anchor: topOf(el), atEnd: overflows && (following.current || distanceFromBottom(el) <= 1) };
    });
  }, [enabled, following, listEl, topOf]);
  // Read once as it mounts too: a list that never scrolls nor resizes its content before its width changes.
  useEffect(() => {
    note();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [note]);
  const take = useCallback((el: HTMLElement, canEnd: boolean): TimelineTopAnchor | "end" | null => {
    if (!enabled) return null;
    const next = el.getBoundingClientRect().width;
    const was = width.current;
    width.current = next;
    if (was === null || Math.abs(next - was) < 0.5 || !reading.current) return null;
    return reading.current.atEnd && canEnd ? "end" : reading.current.anchor;
  }, [enabled]);
  return useMemo(() => ({ note, take }), [note, take]);
}
