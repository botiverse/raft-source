import { useCallback, useEffect, useRef } from "react";
import type { FocusEvent, ReactNode } from "react";
import { ScrollArea } from "@botiverse/raft-ui";

/**
 * A phone's row of filters: their text is never cut, so a row that doesn't fit
 * scrolls sideways, its scrollbar hidden, the side that hides more fading
 * (`mask-fade-x`, Raft DS › Spacing › Edges fade). The phone toolbars of
 * Artifacts and Computers use it (Raft DS › Select › Filters), as the Apps
 * toolbar's filter strip; a candidate for raft-ui. Kept current the way
 * raft-ui's TabsList keeps its row (a private hook there): which side hides more is written straight to
 * `data-overflow` on every scroll, resize and change of what is in the row, so the
 * fade is gone at the end, and a vertical wheel scrolls it. A button that takes
 * focus comes into view clear of the 24px fade (`scroll-px-6`). The row's 44px of
 * padding is its buttons' hit area, which a scroller would otherwise clip.
 *
 * The scroller is a horizontal raft-ui ScrollArea set up as raft-ui's strip of
 * composer attachments: a small scrollbar only while it scrolls, no tab stop of
 * its own (each filter is one). The row and its padding are its content.
 */
export function FilterStrip({ children, testId }: { children: ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => {
      const max = row.scrollWidth - row.clientWidth;
      const start = row.scrollLeft > 1;
      const end = max > 1 && row.scrollLeft < max - 1;
      const next = start && end ? "both" : start ? "start" : end ? "end" : null;
      if (next) row.setAttribute("data-overflow", next);
      else row.removeAttribute("data-overflow");
    };
    const onWheel = (event: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const before = row.scrollLeft;
      row.scrollLeft += event.deltaY;
      if (row.scrollLeft !== before) event.preventDefault();
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- intentional, as raft-ui's TabsList: a wheel the row took mustn't scroll the page too, and it only cancels while the row moves.
    row.addEventListener("wheel", onWheel, { passive: false });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resize?.observe(row);
    const changes = new MutationObserver(update);
    changes.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      row.removeEventListener("scroll", update);
      row.removeEventListener("wheel", onWheel);
      resize?.disconnect();
      changes.disconnect();
    };
  }, []);
  const reveal = useCallback((event: FocusEvent<HTMLDivElement>) => {
    // Optional: not every environment lays out (jsdom has no scrollIntoView).
    event.target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);
  return (
    <ScrollArea
      ref={ref}
      onFocus={reveal}
      orientation="horizontal"
      overscroll="contain"
      size="small"
      trigger="scroll"
      tabIndex={-1}
      className="-mx-1 -my-1.5 min-w-0 scroll-px-6 mask-fade-x"
      contentClassName="flex items-center gap-2 px-1 py-1.5"
      data-testid={testId}
    >
      {children}
    </ScrollArea>
  );
}
