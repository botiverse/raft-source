import { currentTimeMs, normalizeTimeFormatPreference } from "@botiverse/raft-shared";
import type { TimeFormatPreference } from "@botiverse/raft-shared";
import { formatRelativeTimeParts, withZhSpacing } from "./relativeTime";

export type { TimeFormatPreference } from "@botiverse/raft-shared";

export interface TimeFormatOptions {
  timeFormat?: TimeFormatPreference | null;
  timeZone?: string | null;
  locale?: string | string[];
  yesterdayLabel?: string;
  now?: Date;
}

type DateInput = Date | string | number | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hour12(timeFormat: TimeFormatPreference | null | undefined): boolean | undefined {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return undefined;
}

function timeZoneOption(timeZone: string | null | undefined): string | undefined {
  return timeZone || undefined;
}

// A message row formats its time and day several times, and toLocale*String
// builds a new Intl.DateTimeFormat on every call: in a long channel that was a
// visible share of each scroll's render (task #5). Formatters are reused per
// locale and options; the few combinations an app uses keep the cache small.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export function cachedDateTimeFormat(
  locale: string | string[] | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

function format(date: Date, locale: string | string[] | undefined, options: Intl.DateTimeFormatOptions): string {
  return cachedDateTimeFormat(locale, options).format(date);
}

export function detectBrowserTimezone(): string | null {
  if (typeof Intl === "undefined") return null;
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

export function detectBrowserTimeFormat(locale?: string | string[]): TimeFormatPreference {
  if (typeof Intl === "undefined") return "12h";
  const resolved = cachedDateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
  if (resolved.hour12 === false) return "24h";
  if (resolved.hourCycle === "h23" || resolved.hourCycle === "h24") return "24h";
  return "12h";
}

export function normalizePreferredTimeFormat(value: unknown): TimeFormatPreference | null {
  return normalizeTimeFormatPreference(value);
}

export function resolveTimeFormatPreference(
  preferredTimeFormat: TimeFormatPreference | null | undefined,
  locale?: string | string[],
): TimeFormatPreference {
  return preferredTimeFormat ?? detectBrowserTimeFormat(locale);
}

export function formatClock(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

// The clock in a continuation row's 35px gutter: hour and minute in the
// person's 12h/24h preference, without the day period ("6:35", "18:35").
// "06:35 PM" doesn't fit the gutter and wrapped; the period is already in the
// group header's time above, and the tooltip carries the full date and time.
export function formatGutterClock(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  const twelveHour = hour12(options.timeFormat) ?? detectBrowserTimeFormat(options.locale) === "12h";
  const parts = cachedDateTimeFormat(options.locale, {
    hour: twelveHour ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: twelveHour,
    timeZone: timeZoneOption(options.timeZone),
  }).formatToParts(date);
  const hourIndex = parts.findIndex((part) => part.type === "hour");
  const minuteIndex = parts.findIndex((part) => part.type === "minute");
  if (hourIndex < 0 || minuteIndex < hourIndex) return formatClock(date, options);
  return parts.slice(hourIndex, minuteIndex + 1).map((part) => part.value).join("");
}

// Always 24-hour HH:MM, independent of the user's 12h/24h preference. Use only
// for audit-style metadata surfaces that intentionally require fixed 24-hour
// output.
export function formatClock24(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timeZoneOption(options.timeZone),
  });
}

// Full date + time output, always 24-hour, for audit-style metadata surfaces.
export function formatMediumDateTime24(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: timeZoneOption(options.timeZone),
  });
}

export function formatClockWithSeconds(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

export function formatShortDateTime(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

export function formatMediumDateTime(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return format(date, options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

/** `date`'s day in the person's time zone, "YYYY-MM-DD". */
export function calendarDayKey(date: Date, options: Pick<TimeFormatOptions, "timeZone">): string {
  return format(date, "en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timeZoneOption(options.timeZone),
  });
}

export function formatMessageTime(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  const now = options.now ?? new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const time = formatClock(date, options);
  const dateOptions = {
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  };

  if (calendarDayKey(date, options) === calendarDayKey(now, options)) return time;
  if (calendarDayKey(date, options) === calendarDayKey(yesterday, options)) {
    return `${options.yesterdayLabel ?? "Yesterday"} ${time}`;
  }

  const sameYear = format(date, "en-CA", {
    year: "numeric",
    timeZone: timeZoneOption(options.timeZone),
  }) === format(now, "en-CA", {
    year: "numeric",
    timeZone: timeZoneOption(options.timeZone),
  });
  const datePart = format(date, options.locale, sameYear
    ? { month: "2-digit", day: "2-digit", timeZone: dateOptions.timeZone }
    : { year: "numeric", month: "2-digit", day: "2-digit", timeZone: dateOptions.timeZone });
  return `${datePart} ${time}`;
}

// The time in a compact row's trailing group (the Files card): as short as
// it can be and still place the item. Today: the clock in the person's
// 12h/24h choice ("15:00", "03:00 PM"); earlier this year: the month and day
// ("Oct 21"); an earlier year: the ISO date ("2025-10-21"). The full date
// and time go in its tooltip (raft-design patterns/tasks.md, Rows in a
// compact list).
export function formatCompactDate(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  const now = options.now ?? new Date();
  const timeZone = timeZoneOption(options.timeZone);
  if (calendarDayKey(date, options) === calendarDayKey(now, options)) return formatClock(date, options);
  const year = (d: Date) => format(d, "en-CA", { year: "numeric", timeZone });
  if (year(date) === year(now)) {
    return format(date, options.locale, { month: "short", day: "numeric", timeZone });
  }
  return calendarDayKey(date, options);
}

/** The calendar day before `dayKey` ("YYYY-MM-DD"; noon UTC: no zone or DST shifts it). */
function previousDayKey(dayKey: string): string {
  const day = new Date(`${dayKey}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Weekday and date, with the year when it isn't `today`'s: "Tuesday, October 20", "Tuesday, October 20, 2025". */
function formatLongDay(date: Date, today: string, options: TimeFormatOptions): string {
  const sameYear = calendarDayKey(date, options).slice(0, 4) === today.slice(0, 4);
  return format(date, options.locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: timeZoneOption(options.timeZone),
  });
}

/**
 * A day's name in the person's own time zone, as a conversation's date line and
 * Activity's day headings say it: Today, Yesterday, then the weekday and date
 * ("Monday, June 30"), with the year for an earlier year. Empty for a time that
 * doesn't parse.
 */
export function formatDayLabel(value: DateInput, options: {
  /** Today in `timeZone`, "YYYY-MM-DD" (useCurrentDay). */
  today: string;
  locale?: string | string[];
  timeZone?: string | null;
  todayLabel: string;
  yesterdayLabel: string;
}): string {
  const date = toDate(value);
  if (!date) return "";
  const { today } = options;
  const dateKey = calendarDayKey(date, options);
  if (dateKey === today) return options.todayLabel;
  if (dateKey === previousDayKey(today)) return options.yesterdayLabel;
  return formatLongDay(date, today, options);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The words of a row's time, from the catalog (`activity.list.time.*`). */
export interface RowTimeCopy {
  now: string;
  minutes: (count: number) => string;
  hours: (count: number) => string;
  yesterdayAt: (time: string) => string;
  dayAt: (day: string, time: string) => string;
}

/**
 * Which step of a row's time applies (raft-design patterns/lists.md, "Times in
 * list rows"): under a minute, whole minutes under an hour on any day, whole
 * hours while it is still today, and older after that. A time a little ahead of
 * this device's clock reads as now.
 */
function rowTimeStep(date: Date, options: TimeFormatOptions): { kind: "now" } | { kind: "older" } | { kind: "minutes" | "hours"; count: number } {
  const now = options.now ?? new Date(currentTimeMs());
  const elapsed = Math.max(0, now.getTime() - date.getTime());
  if (elapsed < MINUTE_MS) return { kind: "now" };
  if (elapsed < HOUR_MS) return { kind: "minutes", count: Math.floor(elapsed / MINUTE_MS) };
  if (calendarDayKey(date, options) !== calendarDayKey(now, options)) return { kind: "older" };
  return { kind: "hours", count: Math.floor(elapsed / HOUR_MS) };
}

/**
 * Changes exactly when what `formatRowTime` says changes, for a live row to
 * re-render only then. An older row's words depend on the day ("yesterday at",
 * then "Tuesday at"), so its key has today in it.
 */
export function rowTimeKey(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  const step = rowTimeStep(date, options);
  if (step.kind === "now") return "now";
  if (step.kind === "older") return `older:${calendarDayKey(options.now ?? new Date(currentTimeMs()), options)}`;
  return `${step.kind}:${step.count}`;
}

/**
 * The clock in a list row, in the person's 12-hour or 24-hour choice, with no
 * leading zero: "5:20 PM", "17:20", "9:05" (raft-design content/writing.md,
 * Times). `h23`, since `hour12: false` reads midnight as 24:05 in some locales.
 */
export function formatRowClock(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  const twelveHour = hour12(options.timeFormat) ?? detectBrowserTimeFormat(options.locale) === "12h";
  const clock = format(date, options.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(twelveHour ? { hour12: true } : { hourCycle: "h23" as const }),
    timeZone: timeZoneOption(options.timeZone),
  });
  return withZhSpacing(clock.replace(/^0(?=\d)/, ""), options.locale ?? []);
}

export interface RowTime {
  /** What the row shows: "now", "3m", "2h"; on an older row its clock. */
  shown: string;
  /** Shown only on hover or keyboard focus (`InboxItemTimestamp reveal="hover"`). */
  older: boolean;
  /** The time in words, for the row's accessible name: "2 hours ago", "yesterday at 17:20", "Tuesday at 9:05". */
  words: string;
}

/**
 * A list row's time, in a list grouped by day. Beside `formatCompactDate` and
 * not `formatRelativeTime`: this one has no "ago" and counts whole steps down, so
 * 1h 59m is 1h, and its words agree ("1 hour ago"), where the other rounds.
 */
export function formatRowTime(value: DateInput, options: TimeFormatOptions & { copy: RowTimeCopy }): RowTime | null {
  const date = toDate(value);
  if (!date) return null;
  const { copy } = options;
  const locale = options.locale ?? [];
  const step = rowTimeStep(date, options);
  if (step.kind === "now") return { shown: copy.now, older: false, words: copy.now };
  if (step.kind === "minutes") {
    return { shown: copy.minutes(step.count), older: false, words: formatRelativeTimeParts(-step.count, "minute", locale, { numeric: "always" }) };
  }
  if (step.kind === "hours") {
    return { shown: copy.hours(step.count), older: false, words: formatRelativeTimeParts(-step.count, "hour", locale, { numeric: "always" }) };
  }
  const clock = formatRowClock(date, options);
  const today = calendarDayKey(options.now ?? new Date(currentTimeMs()), options);
  const day = calendarDayKey(date, options);
  if (day === previousDayKey(today)) return { shown: clock, older: true, words: copy.yesterdayAt(clock) };
  // A weekday names a day only within the last week; past that the name needs its date.
  const daysAgo = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / DAY_MS);
  const dayName = daysAgo < 7
    ? format(date, options.locale, { weekday: "long", timeZone: timeZoneOption(options.timeZone) })
    : formatLongDay(date, today, options);
  return { shown: clock, older: true, words: copy.dayAt(dayName, clock) };
}
