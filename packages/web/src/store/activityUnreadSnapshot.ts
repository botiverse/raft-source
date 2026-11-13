import { useSyncExternalStore } from "react";
import { useChannelStore } from "./channelStore";
import type { Channel } from "./channelStore";
import { getInboxItemKey, inboxItemGroupChannelId, readInboxItem } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { registerServerReset } from "./serverResetRegistry";

/**
 * Under an Unread filter Activity's list is a snapshot that only grows (stdrc;
 * as the unread views of Gmail, Apple Mail and Outlook). Read is data: a row
 * read here (opened, Mark all read) or elsewhere (another device, the
 * conversation itself) reads at once, and its count, the totals and the
 * badges drop. The list is what the person is looking at: every row it has
 * shown that was read stays where it was, shown read, also after a pane
 * closes (on a phone, Back to the list), while new unread rows come in as
 * they arrive. It is taken again, without the read rows, when the list
 * changes (filter, scope, sort, search), on another server, when the
 * Activity visit ends, or on a reload.
 *
 * Read is a signal, not an absence: the inbox store notes each row it reads
 * (`noteActivityUnreadRowsRead`: markRead, Mark all read, a channel read
 * here, a read-state projection from another device). A row the store stops
 * listing for any other reason (Done elsewhere, access lost, a reload's
 * shorter window) leaves the list as it leaves the store. Done here takes a
 * row out at once, as does its conversation going away (deleted, left).
 *
 * Only the list shows it. The inbox store's rows and counts stay the server's:
 * while the store lists a row (unread again after a new message, say), the
 * store's copy and place are shown; once it doesn't, the last copy is shown
 * read where it was. The store patches those copies as it patches its rows (a
 * retracted preview, a task's status).
 *
 * Its own state, not the list's: the list remounts when the detail pane opens
 * or closes (MainLayout), and on a phone the opened conversation replaces it.
 */
export interface ActivityUnreadSnapshot {
  /** The list it was taken of (server, filter, scope, ...); another list takes a new one. */
  list: string;
  /** The Activity visit it was taken in (`activityVisit`); the next visit takes a new one. */
  visit: number;
  /** The rows as last shown, in order. */
  rows: readonly InboxItem[];
  /** The rows the store no longer lists, kept read, the earliest first. */
  kept: readonly string[];
  /** The rows read since it was taken, and not unread again since. */
  read: ReadonlySet<string>;
}

/**
 * At most this many read rows are kept: past it the earliest leave. The
 * snapshot holds only rows the list has shown and ends with the visit; this
 * bounds a long visit to a busy server.
 */
export const MAX_KEPT_ACTIVITY_ROWS = 500;

const NO_KEYS: ReadonlySet<string> = new Set();

let snapshot: ActivityUnreadSnapshot | null = null;
const listeners = new Set<() => void>();

function set(next: ActivityUnreadSnapshot | null) {
  if (snapshot === next) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function isRead(item: InboxItem): boolean {
  if (item.kind === "mention_action") return true;
  if (item.kind === "object") return item.unreadCount === 0 && !item.hasMention;
  return item.unreadCount === 0 && !item.hasMention && item.firstUnreadMessageId === null;
}

/** The row shown read: the same copy once it is, so showing it again changes nothing. */
function asRead(item: InboxItem): InboxItem {
  return isRead(item) ? item : readInboxItem(item);
}

/** Its latest activity: a new message changes it, and with it the row's place in the store. */
function activityOf(item: InboxItem): string {
  if (item.kind === "mention_action") return item.messageId;
  // An object row's newest event (its Done frontier) moves with each new one.
  if (item.kind === "object") return item.doneFrontierSeq;
  const latest = item.kind === "thread" ? item.latestActivityMessageId : item.lastMessageId;
  return `${latest}:${item.latestActivitySeq ?? ""}`;
}

function sameRows(a: readonly InboxItem[], b: readonly InboxItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

export function useActivityUnreadSnapshot(): ActivityUnreadSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot, () => null);
}

/**
 * The list to show: the store's `items`, in the store's order, with each row
 * of `previous` that was read and the store no longer lists back where it
 * was, read. `kept` is those rows' keys, the earliest kept first.
 */
export function showActivityUnreadSnapshot(
  items: InboxItem[],
  previous: ActivityUnreadSnapshot | null,
): { rows: InboxItem[]; kept: readonly string[] } {
  if (!previous) return { rows: items, kept: [] };
  const listedItems = new Map(items.map((item) => [getInboxItemKey(item), item]));
  const { read } = previous;
  const leaving = new Set<string>();
  for (const row of previous.rows) {
    const key = getInboxItemKey(row);
    if (!listedItems.has(key) && read.has(key)) leaving.add(key);
  }
  if (leaving.size === 0) return { rows: items, kept: [] };
  // Still kept in the order they were kept, then the ones that left the store since.
  const order = previous.kept.filter((key) => leaving.has(key));
  const known = new Set(order);
  for (const key of leaving) if (!known.has(key)) order.push(key);
  const kept = order.length > MAX_KEPT_ACTIVITY_ROWS ? order.slice(order.length - MAX_KEPT_ACTIVITY_ROWS) : order;
  const keeping = new Set(kept);

  // Each kept row stays after the nearest row above it that has not moved: one
  // the store listed then and lists now with the same latest activity. A row
  // that got a new message moves (to the top) without the rows below it. With
  // none above, it goes before the nearest one below that has not moved (new
  // rows on top come in above it); with none at all, after the store's rows.
  const wasKept = new Set(previous.kept);
  const stays = (row: InboxItem, key: string) => {
    const now = listedItems.get(key);
    return now !== undefined && !wasKept.has(key) && activityOf(now) === activityOf(row);
  };
  const followers = new Map<string, InboxItem[]>();
  const leaders = new Map<string, InboxItem[]>();
  let after: string | null = null;
  let leading: InboxItem[] = [];
  for (const row of previous.rows) {
    const key = getInboxItemKey(row);
    if (stays(row, key)) {
      if (after === null && leading.length > 0) {
        leaders.set(key, leading);
        leading = [];
      }
      after = key;
      continue;
    }
    if (!keeping.has(key)) continue;
    if (after === null) {
      leading.push(asRead(row));
      continue;
    }
    const group = followers.get(after);
    if (group) group.push(asRead(row));
    else followers.set(after, [asRead(row)]);
  }
  const rows: InboxItem[] = [];
  for (const item of items) {
    const key = getInboxItemKey(item);
    const before = leaders.get(key);
    if (before) rows.push(...before);
    rows.push(item);
    const group = followers.get(key);
    if (group) rows.push(...group);
  }
  rows.push(...leading);
  return { rows, kept };
}

/**
 * The list as shown under an Unread filter: what the next change is shown
 * against. Anything else (another filter) ends the snapshot. The rows noted
 * read carry over while it is the same list.
 */
export function recordActivityUnreadSnapshot(next: Omit<ActivityUnreadSnapshot, "read"> | null): void {
  if (!next) {
    set(null);
    return;
  }
  const current = snapshot !== null && snapshot.list === next.list && snapshot.visit === next.visit ? snapshot : null;
  if (current && sameRows(current.rows, next.rows) && sameKeys(current.kept, next.kept)) return;
  set({ ...next, read: current?.read ?? NO_KEYS });
}

/** Takes the next snapshot afresh: the visit ended. */
export function dropActivityUnreadSnapshot(): void {
  set(null);
}

/**
 * The inbox store read these rows (here or on another device): once it stops
 * listing them, the list keeps them, read. Call it in the same task as the
 * store change.
 */
export function noteActivityUnreadRowsRead(keys: Iterable<string>): void {
  if (!snapshot) return;
  const current = snapshot.read;
  let read: Set<string> | null = null;
  for (const key of keys) {
    if (current.has(key) || read?.has(key)) continue;
    read ??= new Set(current);
    read.add(key);
  }
  if (read) set({ ...snapshot, read });
}

/**
 * The inbox store's rows changed: a row noted read that it lists unread again
 * (a new message) is no longer read, so if it then leaves for another reason
 * the list lets it go. The store calls this on every change of its rows, also
 * while the list is not mounted (a phone's open conversation).
 */
export function forgetActivityUnreadRowsUnreadAgain(items: readonly InboxItem[]): void {
  if (!snapshot || snapshot.read.size === 0) return;
  const { read } = snapshot;
  const again = items.filter((item) => item.unreadCount > 0 && read.has(getInboxItemKey(item))).map(getInboxItemKey);
  if (again.length === 0) return;
  const next = new Set(read);
  for (const key of again) next.delete(key);
  set({ ...snapshot, read: next });
}

/** The snapshot's copy of the row `key`, when it is kept (the store no longer lists it). */
export function keptActivityUnreadRow(key: string): InboxItem | undefined {
  if (!snapshot?.kept.includes(key)) return undefined;
  return snapshot.rows.find((row) => getInboxItemKey(row) === key);
}

/**
 * Where to put the row `key` among `items` (the store's rows) so it stays
 * where the list shows it: before the nearest row shown after it that the
 * store lists, else after the nearest one shown before it, else at the end.
 * For a row the store lists again while the list shows it (Mark as Unread
 * on a row kept read).
 */
export function activityUnreadSnapshotIndex(key: string, items: readonly InboxItem[]): number {
  const rows = snapshot?.rows ?? [];
  const at = rows.findIndex((row) => getInboxItemKey(row) === key);
  if (at === -1) return items.length;
  const indexOf = (row: InboxItem) => items.findIndex((item) => getInboxItemKey(item) === getInboxItemKey(row));
  for (const row of rows.slice(at + 1)) {
    const index = indexOf(row);
    if (index !== -1) return index;
  }
  for (const row of rows.slice(0, at).reverse()) {
    const index = indexOf(row);
    if (index !== -1) return index + 1;
  }
  return items.length;
}

/** Takes the rows that match out of the snapshot (Done, the conversation gone). */
export function dropActivityUnreadRowsIf(matches: (item: InboxItem) => boolean): void {
  if (!snapshot || !snapshot.rows.some(matches)) return;
  const rows = snapshot.rows.filter((row) => !matches(row));
  const left = new Set(rows.map(getInboxItemKey));
  set({ ...snapshot, rows, kept: snapshot.kept.filter((key) => left.has(key)) });
}

/**
 * Takes the kept row `key` out (Done on it) and returns what puts it back
 * where it was, read, if the Done fails while the same list is shown.
 */
export function takeKeptActivityUnreadRow(key: string): (() => void) | null {
  const taken = snapshot;
  const index = taken ? taken.rows.findIndex((row) => getInboxItemKey(row) === key) : -1;
  if (!taken || index === -1 || !taken.kept.includes(key)) return null;
  const item = taken.rows[index];
  const above = taken.rows.slice(0, index).map(getInboxItemKey).reverse();
  dropActivityUnreadRowsIf((row) => getInboxItemKey(row) === key);
  return () => {
    const now = snapshot;
    if (!now || now.list !== taken.list || now.visit !== taken.visit) return;
    if (now.rows.some((row) => getInboxItemKey(row) === key)) return;
    const keys = now.rows.map(getInboxItemKey);
    const anchor = above.find((candidate) => keys.includes(candidate));
    const at = anchor === undefined ? 0 : keys.indexOf(anchor) + 1;
    const read = new Set(now.read);
    read.add(key);
    set({
      ...now,
      rows: [...now.rows.slice(0, at), item, ...now.rows.slice(at)],
      kept: [...now.kept, key],
      read,
    });
  };
}

/** The store's patches to its rows, applied to the snapshot's copies too. */
export function patchActivityUnreadSnapshot(patch: (item: InboxItem) => InboxItem): void {
  if (!snapshot) return;
  const rows = snapshot.rows.map(patch);
  if (!sameRows(rows, snapshot.rows)) set({ ...snapshot, rows });
}

// A row's conversation is gone when the channel (or DM) it sits in is: deleted,
// left, or no longer readable (channelStore drops it when a refresh answers 404).
function listedChannelIds(state: { channels: Channel[]; dmChannels: Channel[] }): Set<string> {
  const ids = new Set<string>();
  for (const channel of state.channels) if (channel.joined !== false) ids.add(channel.id);
  for (const channel of state.dmChannels) ids.add(channel.id);
  return ids;
}
useChannelStore.subscribe((state, previous) => {
  if (!snapshot || (state.channels === previous.channels && state.dmChannels === previous.dmChannels)) return;
  const before = listedChannelIds(previous);
  const now = listedChannelIds(state);
  dropActivityUnreadRowsIf((item) => {
    const id = inboxItemGroupChannelId(item);
    return id !== null && before.has(id) && !now.has(id);
  });
});

// Another server, or signed out.
registerServerReset(() => set(null));
