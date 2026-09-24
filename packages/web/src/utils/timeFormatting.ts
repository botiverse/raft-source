import { normalizeTimeFormatPreference } from "@botiverse/raft-shared";
import type { TimeFormatPreference } from "@botiverse/raft-shared";

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

export function detectBrowserTimezone(): string | null {
  if (typeof Intl === "undefined") return null;
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

export function detectBrowserTimeFormat(locale?: string | string[]): TimeFormatPreference {
  if (typeof Intl === "undefined") return "12h";
  const resolved = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions();
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
  return date.toLocaleTimeString(options.locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

// Always 24-hour HH:MM, independent of the user's 12h/24h preference. Use only
// for audit-style metadata surfaces that intentionally require fixed 24-hour
// output.
export function formatClock24(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return date.toLocaleTimeString(options.locale, {
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
  return date.toLocaleString(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone: timeZoneOption(options.timeZone),
  });
}

export function formatClockWithSeconds(value: DateInput, options: TimeFormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return value == null ? "" : String(value);
  return date.toLocaleTimeString(options.locale, {
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
  return date.toLocaleString(options.locale, {
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
  return date.toLocaleString(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: hour12(options.timeFormat),
    timeZone: timeZoneOption(options.timeZone),
  });
}

function calendarDayKey(date: Date, options: TimeFormatOptions): string {
  return date.toLocaleDateString("en-CA", {
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

  const sameYear = date.toLocaleDateString("en-CA", {
    year: "numeric",
    timeZone: timeZoneOption(options.timeZone),
  }) === now.toLocaleDateString("en-CA", {
    year: "numeric",
    timeZone: timeZoneOption(options.timeZone),
  });
  const datePart = date.toLocaleDateString(options.locale, sameYear
    ? { month: "2-digit", day: "2-digit", timeZone: dateOptions.timeZone }
    : { year: "numeric", month: "2-digit", day: "2-digit", timeZone: dateOptions.timeZone });
  return `${datePart} ${time}`;
}
