import { useEffect, useState } from "react";
import type { RefObject } from "react";

/** The thread's origin row, in each of its lists (ThreadPanelReplies, useThreadTimelineRows). */
const PARENT_ROW_SELECTOR = '[data-testid="thread-panel-parent"]';
/** The scrollers the origin row scrolls in: the replies' timeline, or the ScrollArea while they load or are none. */
const SCROLLER_SELECTOR = '[data-testid="thread-message-scroller"], [data-testid="thread-replies-placeholder-scroll"]';
/** The timeline's rows (raft-ui VirtualList): each mounted row is a child, the origin row's wrapper among them. */
const ROWS_SELECTOR = '[data-slot="virtual-list-visible-items"]';

/**
 * Whether the message the thread started from has scrolled fully out of view in the thread's list (the head then
 * names it; raft-design conversation.md, Threads). An IntersectionObserver on the origin row, in its scroller; the
 * replies' timeline mounts only the rows near the viewport, so an origin row that unmounts is out of view. Off
 * (false) where there is no origin row to look for: the panel shows none, or it isn't loaded yet.
 *
 * The row is looked for again when its list's rows change, and only then: the region's own children (the
 * placeholder giving way to the timeline) and the rows' container, never the messages' insides.
 */
export function useThreadParentOutOfView(regionRef: RefObject<HTMLElement | null>, enabled: boolean, conversationKey: string | null): boolean {
  // Keyed by the conversation, so another thread's answer is never this one's.
  const [seen, setSeen] = useState<{ key: string | null; out: boolean }>({ key: null, out: false });
  useEffect(() => {
    const region = regionRef.current;
    if (!enabled || !region || typeof IntersectionObserver === "undefined") return;
    const report = (out: boolean) => setSeen((previous) => (previous.key === conversationKey && previous.out === out ? previous : { key: conversationKey, out }));
    let observed: Element | null = null;
    let intersection: IntersectionObserver | null = null;
    let watchedRows: Element | null = null;
    const rowsChanged = new MutationObserver(() => attach());
    const watchRows = (row: Element | null) => {
      // The timeline's rows; else the row's own parent (the placeholder's list); else, before either is there,
      // the scroller, deep, until it is.
      const rows = region.querySelector(ROWS_SELECTOR) ?? row?.parentElement ?? region.querySelector(SCROLLER_SELECTOR);
      if (rows === watchedRows) return;
      rowsChanged.disconnect();
      watchedRows = rows;
      if (rows) rowsChanged.observe(rows, { childList: true, subtree: !rows.matches(ROWS_SELECTOR) && rows !== row?.parentElement });
    };
    const attach = () => {
      const row = region.querySelector(PARENT_ROW_SELECTOR);
      watchRows(row);
      if (row === observed) return;
      intersection?.disconnect();
      intersection = null;
      observed = row;
      if (!row) {
        // Unmounted by the timeline as it scrolled away (it holds the rows near the viewport only).
        report(true);
        return;
      }
      const root = row.closest(SCROLLER_SELECTOR) ?? region;
      intersection = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) report(!entry.isIntersecting);
      }, { root });
      intersection.observe(row);
    };
    attach();
    // The list itself comes and goes (the placeholder gives way to the timeline): the region's children only.
    const listChanged = new MutationObserver(() => attach());
    listChanged.observe(region, { childList: true });
    return () => {
      listChanged.disconnect();
      rowsChanged.disconnect();
      intersection?.disconnect();
    };
  }, [conversationKey, enabled, regionRef]);
  return enabled && seen.key === conversationKey && seen.out;
}
