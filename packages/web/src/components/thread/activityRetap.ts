// Tapping Activity again on a phone (its tab on the tab bar, or its title
// bar) goes to the next unread item below the current position, puts it at
// the top of the list and flashes it; after the last one it goes back to the
// top, and the cycle starts again. With nothing unread it goes to the top.
// Only the rows of the current filter count, and nothing is marked read.
// (artin 2026-10-21; Raft DS › Navigation › Going back.)

/** A row of the list, in list order. */
export type ActivityRetapRow = {
  key: string;
  /** The scroll position that puts this row at the top of the list (under
   *  anything pinned there), before clamping to what the list can scroll. */
  top: number;
  /** The row shows an unread count or mention (`unreadCount > 0`). */
  unread: boolean;
};

/** Where the previous tap sent the list: a row (`key`), or the top (`null`),
 *  the scroll position it was headed to, and when. */
export type ActivityRetapAnchor = { key: string | null; to: number; at: number };

export type ActivityRetapTarget =
  | { kind: "row"; key: string; top: number }
  | { kind: "top" };

/** How far a row must be below the current position to count as below it. */
export const ACTIVITY_RETAP_EPSILON = 4;
/** How long a tap's smooth scroll may still be on its way. */
export const ACTIVITY_RETAP_IN_FLIGHT_MS = 700;

/**
 * The next place a tap on Activity goes.
 *
 * "Below the current position" is the first unread row whose top is below
 * `scrollTop + epsilon`. At the top of the list nothing has been passed yet,
 * so the first unread row counts even when it already sits at the top.
 *
 * The previous tap's anchor stands in for the current position only while
 * the list is still where that tap sent it, or within
 * `ACTIVITY_RETAP_IN_FLIGHT_MS` of it (the scroll is smooth, so a quick
 * second tap finds the list on its way). Then the next row is the first
 * unread one below the anchored row as it is now (rows move when activity
 * arrives), or after a trip to the top the first unread row. Positions alone
 * would repeat a row near the end of the list, which can't scroll far enough
 * to reach the top. The caller drops the anchor when the user scrolls or the
 * filter changes.
 */
export function nextActivityRetapTarget({
  rows,
  scrollTop,
  maxScrollTop,
  anchor,
  now,
  epsilon = ACTIVITY_RETAP_EPSILON,
}: {
  rows: readonly ActivityRetapRow[];
  scrollTop: number;
  maxScrollTop: number;
  anchor: ActivityRetapAnchor | null;
  now: number;
  epsilon?: number;
}): ActivityRetapTarget {
  const anchorHolds = anchor !== null
    && (Math.abs(scrollTop - anchor.to) <= epsilon || now - anchor.at <= ACTIVITY_RETAP_IN_FLIGHT_MS);
  const anchorRow = anchorHolds && anchor.key !== null ? rows.find((row) => row.key === anchor.key) : undefined;
  const next = anchorRow
    ? rows.find((row) => row.unread && row.top > anchorRow.top + epsilon)
    : (anchorHolds && anchor.key === null) || scrollTop <= epsilon
      ? rows.find((row) => row.unread)
      : rows.find((row) => row.unread && row.top > scrollTop + epsilon);
  if (!next) return { kind: "top" };
  return { kind: "row", key: next.key, top: Math.max(0, Math.min(next.top, Math.max(0, maxScrollTop))) };
}

/** Past the last loaded unread row, more unread rows may be in pages not
 *  loaded yet: the filter's unread total is more than the loaded rows add
 *  up to, and the server has more. */
export function hasUnloadedUnread({ loadedUnreadCount, totalUnreadCount, hasMore }: {
  loadedUnreadCount: number;
  totalUnreadCount: number;
  hasMore: boolean;
}): boolean {
  return hasMore && totalUnreadCount > loadedUnreadCount;
}
