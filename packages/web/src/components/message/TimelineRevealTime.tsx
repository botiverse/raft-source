import type { ReactNode } from "react";
import { TIMELINE_REVEAL_TIME_ATTR } from "./messageTimelineShared";

const REVEAL_TIME_PROPS = { [TIMELINE_REVEAL_TIME_ATTR]: "" };

/**
 * A message's time for the touch reveal (useTimelineTimeReveal): the hour and
 * minute, in the merged message's clock format, 20px past the row's right
 * edge, where it comes in as the conversation is dragged left. Out of the
 * layout at rest (index.css). Hidden from screen readers: each message's
 * article is already named by its time (raft-ui MessageItem), so this would
 * read it twice. Raft-ui has no part for it yet.
 */
export function TimelineRevealTime({ dateTime, children }: { dateTime: string | undefined; children: ReactNode }) {
  return (
    <time
      {...REVEAL_TIME_PROPS}
      aria-hidden="true"
      dateTime={dateTime}
      className="timeline-reveal-time pointer-events-none absolute left-[calc(100%+20px)] top-[calc(var(--spacing-timeline-row)+(var(--text-body--line-height)-var(--text-mono-meta--line-height))/2)] select-none whitespace-nowrap font-mono text-mono-meta tabular-nums text-foreground-hint"
    >
      {children}
    </time>
  );
}
