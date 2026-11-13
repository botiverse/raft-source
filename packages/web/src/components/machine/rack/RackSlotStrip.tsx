import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ScrollArea } from "@botiverse/raft-ui";

/**
 * A computer row's agent slots on one line that scrolls sideways when there
 * are more than fit, so every row keeps the rack's height. A side with more
 * slots beyond it fades out (raft-ui `mask-fade-x`, 24px, on the side
 * `data-overflow` names), so a cut avatar reads as "more this way" rather
 * than as a clipped one. The padding keeps the focus ring and the activity
 * light inside the scroll box; the negative margin keeps the first avatar on
 * the column's edge. Above its row's stretched link (ComputersRack) and only
 * as wide as its slots, so the strip still scrolls and the room beside it
 * still opens the computer.
 *
 * A horizontal raft-ui ScrollArea, set up as raft-ui's own strip of composer
 * attachments: a small overlay scrollbar that takes no height, and no tab
 * stop of its own (each slot is one, and comes into view when focused).
 */
export function RackSlotStrip({ testId, hideScrollbar = false, children }: {
  testId: string;
  /** A card's strip: its scrollbar shows only while it scrolls (ScrollArea
   *  `trigger="scroll"`), not on hover over the card. The fade says there is
   *  more; a trackpad, shift+wheel or Tab (a focused slot scrolls into view)
   *  reaches it. */
  hideScrollbar?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  // The box's width comes from the row, not the slots: re-measure when a slot
  // is added or removed (a finished move, a new agent).
  const slotCount = Children.count(children);
  useLayoutEffect(measure, [measure, slotCount]);
  const overflow = edges.start && edges.end ? "both" : edges.start ? "start" : edges.end ? "end" : undefined;

  return (
    <ScrollArea
      ref={ref}
      onScroll={measure}
      orientation="horizontal"
      overscroll="contain"
      size="small"
      trigger={hideScrollbar ? "scroll" : "hover"}
      tabIndex={-1}
      className="relative z-raised -m-1 w-fit max-w-[calc(100%+0.5rem)] min-w-0 mask-fade-x"
      contentClassName="flex items-center gap-1 p-1"
      data-testid={testId}
      data-overflow={overflow}
    >
      {children}
    </ScrollArea>
  );
}
