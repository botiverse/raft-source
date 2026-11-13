import type { ActivitySortDirection, InboxItem } from "../../store/inboxStore";
import { calendarDayKey, formatDayLabel } from "../../utils/timeFormatting";

/** The time a row shows, which is the time it is grouped by. */
export function inboxItemTime(item: InboxItem): string {
  if (item.kind === "thread" || item.kind === "object") return item.lastActivityAt;
  return item.kind === "mention_action" ? item.createdAt : item.lastMessageAt;
}

/** A row's time as a Date; invalid when it has none, which `new Date(null)` would read as 1970. */
function inboxItemDate(item: InboxItem): Date {
  return new Date(inboxItemTime(item) || Number.NaN);
}

export interface ActivityDayGroup {
  /** "YYYY-MM-DD" in the person's time zone, the group's key: stable when its heading turns from Today to Yesterday, so its rows stay mounted. Empty for rows with no readable time. */
  day: string;
  /** The heading. Empty for rows with no readable time, which have none. */
  label: string;
  rows: InboxItem[];
}

export interface DayGroupOptions {
  /** Today in `timeZone`, "YYYY-MM-DD" (useCurrentDay). */
  today: string;
  timeZone?: string;
  locale?: string | string[];
  todayLabel: string;
  yesterdayLabel: string;
  sortDirection?: ActivitySortDirection;
}

/**
 * The rows in the order the list shows them, so what picks "the first row" picks
 * the one first on screen: by the time they show, equal times keeping the list's
 * order (a stable sort), and rows with no readable time last, whichever way the
 * list is sorted.
 */
export function sortInboxRowsByTime(items: readonly InboxItem[], sortDirection: ActivitySortDirection = "desc"): InboxItem[] {
  const direction = sortDirection === "asc" ? 1 : -1;
  return items
    .map((item) => ({ item, time: inboxItemDate(item).getTime() }))
    .sort((left, right) => {
      const leftUnreadable = Number.isNaN(left.time);
      const rightUnreadable = Number.isNaN(right.time);
      if (leftUnreadable || rightUnreadable) return Number(leftUnreadable) - Number(rightUnreadable);
      return (left.time - right.time) * direction;
    })
    .map(({ item }) => item);
}

/**
 * Activity's rows by day (raft-design patterns/lists.md, "Rows grouped by day"):
 * one group per day that has rows, so a day with no rows has no heading, newest
 * first.
 *
 * The rows are sorted by the time they show first (sortInboxRowsByTime), so the
 * order inside a day matches the times on screen. The list isn't always in that
 * order: the server orders rows by its own activity
 * time, and the Unread snapshot puts back rows the store no longer lists (Jasper,
 * #13030). A time a little ahead of this device's clock counts as today, not as a
 * day still to come.
 */
export function groupInboxRowsByDay(items: readonly InboxItem[], options: DayGroupOptions): ActivityDayGroup[] {
  const { today, timeZone, sortDirection = "desc" } = options;
  // In time order, so the days come out in order too.
  const groups = new Map<string, ActivityDayGroup>();
  for (const item of sortInboxRowsByTime(items, sortDirection)) {
    const at = inboxItemDate(item);
    const valid = !Number.isNaN(at.getTime());
    const rawDay = valid ? calendarDayKey(at, { timeZone }) : "";
    const day = rawDay > today ? today : rawDay;
    let group = groups.get(day);
    if (!group) {
      group = {
        day,
        label: !valid ? "" : day === today ? options.todayLabel : formatDayLabel(at, options),
        rows: [],
      };
      groups.set(day, group);
    }
    group.rows.push(item);
  }
  return [...groups.values()];
}
