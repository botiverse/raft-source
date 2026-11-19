/**
 * #triage:#244: a conversation opened here (inboxStore clearReadForChannel)
 * is read at once, before its read reaches the server. An answer to a list or
 * row read SENT before the open still carries the old count; taking it brought
 * that count back until the next read corrected it (15 unread for ~2 s on an
 * opened thread, after a socket-gap list read). So each open holds its row
 * read against answers to reads sent before it (the request captured
 * currentInboxOpenReadClock() before the hold), at the row's authority marker:
 * - an answer to a read sent after the open is taken as served, so the drift
 *   check still sees the server disagree;
 * - the hold ends when the server's read state for the row covers the marker,
 *   at the hold time at most, or on a server switch.
 *
 * Not covered, as before (Tenny, #15024): a read sent before the open whose
 * answer already has a message newer than the marker is taken as served, so
 * until the saved read comes back its count is the old unread plus the new
 * message. That needs the page to be behind on a live message at the moment
 * of opening.
 */
import { compareActivitySeq } from "./activitySeq";
import { getInboxItemKey, readInboxItem } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { registerServerReset } from "./serverResetRegistry";

type OpenReadHold = { scopeId: string; marker: string; at: number; until: number };

let clock = 0;
const holds = new Map<string, OpenReadHold>();

/** The open-read clock now: a read request captures it when it is sent. */
export function currentInboxOpenReadClock(): number {
  return clock;
}

/** Open of `scopeId` read these rows (`markerOf`: each row's authority marker, null: no hold). */
export function rememberInboxOpenReads(
  rows: readonly InboxItem[],
  scopeId: string,
  markerOf: (row: InboxItem) => string | null,
  holdMs: number,
  nowMs: number,
): void {
  // Expired holds go here too, not only when an answer names their row.
  for (const [key, hold] of holds) if (nowMs > hold.until) holds.delete(key);
  for (const row of rows) {
    const marker = markerOf(row);
    if (marker !== null) holds.set(getInboxItemKey(row), { scopeId, marker, at: ++clock, until: nowMs + holdMs });
  }
}

type Applied = { items: InboxItem[]; suppressedCount: number; suppressedUnreadCount: number };

/**
 * Rows of an answer to a read sent at `sentAt` (after `previous`, another
 * hold's result, whose counts are carried): one opened here since, at no
 * newer message, shows read; outside the "all" filter it is left out.
 */
export function applyInboxOpenReadHolds(
  previous: Applied,
  allFilter: boolean,
  sentAt: number,
  markerOf: (row: InboxItem) => string | null,
  readMaxSeqOf: (scopeId: string) => number | null,
  nowMs: number,
): Applied {
  if (holds.size === 0) return previous;
  let { suppressedCount, suppressedUnreadCount } = previous;
  const items: InboxItem[] = [];
  for (const item of previous.items) {
    const key = item.kind === "mention_action" || item.kind === "object" ? null : getInboxItemKey(item);
    const hold = key === null ? undefined : holds.get(key);
    const ended = hold !== undefined && (nowMs > hold.until || compareActivitySeq(String(readMaxSeqOf(hold.scopeId) ?? ""), hold.marker) >= 0);
    if (ended) holds.delete(key!);
    if (!hold || ended || hold.at <= sentAt || compareActivitySeq(markerOf(item), hold.marker) > 0) {
      items.push(item);
      continue;
    }
    suppressedUnreadCount += item.unreadCount;
    if (allFilter) items.push(readInboxItem(item));
    else suppressedCount += 1;
  }
  return { items, suppressedCount, suppressedUnreadCount };
}

registerServerReset(() => {
  holds.clear();
});

export function resetInboxOpenReadHoldsForTests(): void {
  holds.clear();
  clock = 0;
}
