import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the end still counts as reading the newest (and follows it). */
const END_PX = 24;
const AT_END: { atEnd: boolean; newCount: number } = { atEnd: true, newCount: 0 };

/**
 * Following the newest (raft-design Conversation) for a timeline in a plain
 * scroll container, newest at the bottom: it opens at the newest entry and
 * keeps it in view while the end is in view; once the reader scrolls up, the
 * row they read stays where it is (entries dropped off the top at a limit, or
 * loaded above, don't move it) and `newCount` counts what arrived below, for
 * the Back to bottom pill. It follows the newest entry changing, not the
 * count: at a limit the count stays the same while entries keep arriving.
 *
 * Put `scrollRef` and `onScroll` on the scrolling element and `listRef` on
 * the element whose children are the rows, and give that container
 * `overflow-anchor: none`: this keeps the reader's place itself.
 */
export function useFollowNewest<T>(entries: readonly T[], keyOf: (entry: T) => string) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const followingRef = useRef(true);
  const readingRef = useRef<{ row: Element; offset: number } | null>(null);
  const newestKeyRef = useRef<string | null>(null);
  // Whether the end is in view, and how many entries arrived below since the reader left it.
  const [view, setView] = useState(AT_END);

  const pinToEnd = useCallback(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const end = container.scrollHeight - container.scrollTop - container.clientHeight <= END_PX;
    followingRef.current = end;
    setView((current) => (end ? AT_END : current.atEnd ? { atEnd: false, newCount: current.newCount } : current));
    if (end) {
      readingRef.current = null;
      return;
    }
    // The row at the top of the view, found by halving: rows are in order.
    const viewTop = container.getBoundingClientRect().top;
    const rows = listRef.current?.children ?? [];
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rows[mid]!.getBoundingClientRect().bottom > viewTop) high = mid;
      else low = mid + 1;
    }
    const row = rows[low];
    readingRef.current = row ? { row, offset: row.getBoundingClientRect().top - viewTop } : null;
  }, []);

  const jumpToNewest = useCallback(() => {
    followingRef.current = true;
    readingRef.current = null;
    setView(AT_END);
    pinToEnd();
  }, [pinToEnd]);

  const newestKey = entries.length > 0 ? keyOf(entries[entries.length - 1]!) : null;
  useLayoutEffect(() => {
    const previousNewest = newestKeyRef.current;
    newestKeyRef.current = newestKey;
    if (newestKey === null) {
      // Cleared (a reset): the next entries open at the newest again.
      followingRef.current = true;
      readingRef.current = null;
      setView(AT_END);
      return;
    }
    if (followingRef.current) {
      pinToEnd();
      return;
    }
    const container = scrollRef.current;
    const reading = readingRef.current;
    if (container && reading?.row.isConnected) {
      const drift = reading.row.getBoundingClientRect().top - container.getBoundingClientRect().top - reading.offset;
      if (Math.abs(drift) >= 1) container.scrollTop += drift;
    }
    if (previousNewest !== null && previousNewest !== newestKey) {
      let arrived = 0;
      for (let i = entries.length - 1; i >= 0 && keyOf(entries[i]!) !== previousNewest; i--) arrived++;
      // The newest the reader saw is gone (replaced by another copy): one entry.
      if (arrived === entries.length) arrived = 1;
      setView((current) => ({ atEnd: current.atEnd, newCount: current.newCount + arrived }));
    }
  }, [entries, keyOf, newestKey, pinToEnd]);

  // Rows settle after the first paint (fonts, a row expanded): a reader at
  // the end stays there.
  const hasRows = newestKey !== null;
  useEffect(() => {
    const list = listRef.current;
    if (!hasRows || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToEnd();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [hasRows, pinToEnd]);

  return { scrollRef, listRef, onScroll, atEnd: view.atEnd, newCount: view.newCount, jumpToNewest };
}
