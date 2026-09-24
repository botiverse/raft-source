import type { IntlShape } from "react-intl";

import { formatClock, formatMediumDateTime } from "./timeFormatting";
import type { TimeFormatOptions } from "./timeFormatting";

function timeZoneOption(options: TimeFormatOptions): string | undefined {
  return options.timeZone || undefined;
}

function dateKey(date: Date, options: TimeFormatOptions): string {
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timeZoneOption(options),
  });
}

function yearKey(date: Date, options: TimeFormatOptions): string {
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    timeZone: timeZoneOption(options),
  });
}

function formatLocalClock(date: Date, options: TimeFormatOptions = {}): string {
  return formatClock(date, options);
}

export type ReminderReceiptContentPart =
  | { type: "text"; value: string }
  | { type: "reminderFireAt"; value: string };

const reminderFireAtTokenPattern = /<span\s+data-reminder-fire-at="([^"]+)">[^<]*<\/span>/g;

export function splitReminderReceiptFireAtTokens(content: string): ReminderReceiptContentPart[] {
  const parts: ReminderReceiptContentPart[] = [];
  let cursor = 0;

  for (const match of content.matchAll(reminderFireAtTokenPattern)) {
    if (match.index === undefined) continue;
    if (match.index > cursor) {
      parts.push({ type: "text", value: content.slice(cursor, match.index) });
    }
    parts.push({ type: "reminderFireAt", value: match[1] });
    cursor = match.index + match[0].length;
  }

  if (cursor === 0) return [{ type: "text", value: content }];
  if (cursor < content.length) {
    parts.push({ type: "text", value: content.slice(cursor) });
  }
  return parts;
}

export function formatReminderReceiptContentTitle(content: string, options: TimeFormatOptions = {}): string {
  return splitReminderReceiptFireAtTokens(content)
    .map((part) => part.type === "reminderFireAt" ? formatReminderReceiptTooltip(part.value, options) : part.value)
    .join("");
}

export function formatReminderReceiptTime(
  value: string,
  formatMessage: IntlShape["formatMessage"],
  now = new Date(),
  options: TimeFormatOptions = {},
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const time = formatLocalClock(date, options);

  if (dateKey(date, options) === dateKey(now, options)) {
    return formatMessage({ id: "message.receipt.todayAt" }, { time });
  }

  if (dateKey(date, options) === dateKey(tomorrow, options)) {
    return formatMessage({ id: "message.receipt.tomorrowAt" }, { time });
  }

  const sameYear = yearKey(date, options) === yearKey(now, options);
  const datePart = date.toLocaleDateString(options.locale, sameYear
    ? { month: "short", day: "numeric", timeZone: timeZoneOption(options) }
    : { year: "numeric", month: "short", day: "numeric", timeZone: timeZoneOption(options) });

  return formatMessage({ id: "message.receipt.dateAt" }, { date: datePart, time });
}

export function formatReminderReceiptTooltip(value: string, options: TimeFormatOptions = {}): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatMediumDateTime(date, options);
}
