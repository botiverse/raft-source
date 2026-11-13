import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  formatClock,
  formatClockWithSeconds,
  formatCompactDate,
  formatDayLabel,
  formatGutterClock,
  formatMediumDateTime,
  formatMessageTime,
  formatRowClock,
  formatRowTime,
  formatShortDateTime,
  normalizePreferredTimeFormat,
  resolveTimeFormatPreference,
  rowTimeKey,
} from "../src/utils/timeFormatting";
import type { RowTimeCopy, TimeFormatOptions } from "../src/utils/timeFormatting";
import { en } from "../src/i18n/messages/en";
import { zhCn } from "../src/i18n/messages/zh-cn";
import { isTestPath } from "../scripts/testLocations";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function sourceFilesUnder(path: string): string[] {
  const root = resolve(repoRoot, path);
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const visit = (entry: string) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) visit(resolve(entry, child));
      return;
    }
    // Feature tests (src/features/<feature>/tests/) are test code, not display surfaces.
    if (/\.(tsx?|jsx?)$/.test(entry) && !isTestPath(relative(repoRoot, entry))) results.push(relative(repoRoot, entry));
  };
  visit(root);
  return results.sort();
}

test("time formatter honors explicit 12h and 24h UI preferences", () => {
  const value = "2026-05-14T13:05:00.000Z";
  const base = { locale: "en-US", timeZone: "UTC" };

  assert.equal(formatClock(value, { ...base, timeFormat: "24h" }), "13:05");
  assert.equal(formatClockWithSeconds(value, { ...base, timeFormat: "24h" }), "13:05:00");
  assert.equal(formatClock(value, { ...base, timeFormat: "12h" }), "01:05 PM");
  assert.equal(formatShortDateTime(value, { ...base, timeFormat: "24h" }), "May 14, 13:05");
  assert.equal(formatMediumDateTime(value, { ...base, timeFormat: "24h" }), "May 14, 2026, 13:05");
  assert.equal(formatMediumDateTime(value, { ...base, timeFormat: "12h" }), "May 14, 2026, 1:05 PM");
  assert.equal(
    formatMessageTime(value, {
      ...base,
      timeFormat: "24h",
      now: new Date("2026-05-14T18:00:00.000Z"),
    }),
    "13:05",
  );
});

test("gutter clock keeps hour and minute in the preferred format, without the day period", () => {
  const evening = "2026-10-19T18:35:00Z";
  const morning = "2026-10-19T06:05:00Z";
  const utc = { timeZone: "UTC" };
  assert.equal(formatGutterClock(evening, { ...utc, locale: "en-US", timeFormat: "12h" }), "6:35");
  assert.equal(formatGutterClock(morning, { ...utc, locale: "en-US", timeFormat: "12h" }), "6:05");
  assert.equal(formatGutterClock(evening, { ...utc, locale: "en-US", timeFormat: "24h" }), "18:35");
  assert.equal(formatGutterClock(morning, { ...utc, locale: "en-US", timeFormat: "24h" }), "06:05");
  assert.equal(formatGutterClock(evening, { ...utc, locale: "zh-CN", timeFormat: "12h" }), "6:35");
  assert.equal(formatGutterClock(evening, { ...utc, locale: "zh-CN", timeFormat: "24h" }), "18:35");
  for (const value of [
    formatGutterClock(evening, { ...utc, locale: "en-US" }),
    formatGutterClock(evening, { ...utc, locale: "zh-CN" }),
  ]) {
    assert.match(value, /^\d{1,2}:\d{2}$/, `the gutter fits only hour and minute, got "${value}"`);
  }
  assert.equal(formatGutterClock(null), "");
});

test("time formatter honors display locale and caller-provided relative-day labels", () => {
  const value = "2026-05-14T13:05:00.000Z";
  const base = { locale: "zh-CN", timeZone: "UTC", timeFormat: "24h" as const };

  assert.doesNotMatch(formatShortDateTime(value, base), /May/i);
  assert.equal(
    formatMessageTime(value, {
      ...base,
      yesterdayLabel: "昨天",
      now: new Date("2026-05-15T18:00:00.000Z"),
    }),
    "昨天 13:05",
  );
});

test("compact date: the clock today, the month and day this year, the ISO date before", () => {
  const now = new Date("2026-10-21T18:00:00.000Z");
  const base = { locale: "en-US", timeZone: "UTC", now };
  assert.equal(formatCompactDate("2026-10-21T15:00:00.000Z", { ...base, timeFormat: "24h" }), "15:00");
  assert.equal(formatCompactDate("2026-10-21T15:00:00.000Z", { ...base, timeFormat: "12h" }), "03:00 PM");
  assert.equal(formatCompactDate("2026-10-20T15:00:00.000Z", base), "Oct 20");
  assert.equal(formatCompactDate("2026-01-02T15:00:00.000Z", base), "Jan 2");
  assert.equal(formatCompactDate("2025-10-21T15:00:00.000Z", base), "2025-10-21");
  // The day follows the person's time zone, not UTC.
  assert.equal(formatCompactDate("2026-10-21T02:00:00.000Z", { ...base, timeZone: "America/Los_Angeles", timeFormat: "24h" }), "Oct 20");
  assert.equal(formatCompactDate(null), "");
});

// A row's words, from the real catalogs, so the expectations below pin the copy too.
function rowCopy(catalog: typeof en | typeof zhCn): RowTimeCopy {
  const fill = (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  return {
    now: catalog["activity.list.time.now"],
    minutes: (count) => fill(catalog["activity.list.time.minutes"], { count }),
    hours: (count) => fill(catalog["activity.list.time.hours"], { count }),
    yesterdayAt: (time) => fill(catalog["activity.list.time.yesterdayAt"], { time }),
    dayAt: (day, time) => fill(catalog["activity.list.time.dayAt"], { day, time }),
  };
}

const ROW_BASE: TimeFormatOptions = { locale: "en-US", timeZone: "UTC", timeFormat: "24h" };
const rowTime = (value: string, now: string, options: TimeFormatOptions = {}, catalog: typeof en | typeof zhCn = en) =>
  formatRowTime(value, { ...ROW_BASE, ...options, now: new Date(now), copy: rowCopy(catalog) });

test("row time: now under a minute, then whole minutes, then whole hours, with no ago and no space", () => {
  const now = "2026-11-05T12:00:00.000Z";
  const shown = (value: string) => rowTime(value, now)?.shown;
  assert.equal(shown("2026-11-05T12:00:00.000Z"), "now");
  assert.equal(shown("2026-11-05T11:59:00.001Z"), "now", "59.999 seconds");
  assert.equal(shown("2026-11-05T11:59:00.000Z"), "1m", "exactly a minute");
  assert.equal(shown("2026-11-05T11:57:00.000Z"), "3m");
  assert.equal(shown("2026-11-05T11:00:00.001Z"), "59m", "59.999 minutes");
  assert.equal(shown("2026-11-05T11:00:00.000Z"), "1h", "exactly an hour");
  assert.equal(shown("2026-11-05T10:00:00.001Z"), "1h", "1h 59m is 1h: whole hours count down");
  assert.equal(shown("2026-11-05T10:00:00.000Z"), "2h");
  assert.equal(shown("2026-11-05T00:00:00.000Z"), "12h", "the day's first moment is still today");
  assert.equal(rowTime("2026-11-05T10:00:00.000Z", now)?.older, false);
});

test("row time: a time a little ahead of this device's clock reads as now", () => {
  assert.equal(rowTime("2026-11-05T12:00:05.000Z", "2026-11-05T12:00:00.000Z")?.shown, "now");
});

test("row time: under an hour old it keeps its short time past midnight; only then does it follow older rows (Jasper)", () => {
  const justPast = "2026-11-06T00:06:00.000Z";
  const row = rowTime("2026-11-06T00:00:00.000Z", justPast);
  assert.equal(row?.shown, "6m");
  const beforeMidnight = rowTime("2026-11-05T23:06:00.001Z", justPast);
  assert.deepEqual(beforeMidnight, { shown: "59m", older: false, words: "59 minutes ago" });
  const anHourOld = rowTime("2026-11-05T23:06:00.000Z", justPast);
  assert.deepEqual(anHourOld, { shown: "23:06", older: true, words: "yesterday at 23:06" });
});

test("row time: an older row shows its clock, and says the day in words", () => {
  const now = "2026-11-05T12:00:00.000Z"; // A Thursday.
  assert.deepEqual(rowTime("2026-11-04T17:20:00.000Z", now), { shown: "17:20", older: true, words: "yesterday at 17:20" });
  assert.deepEqual(rowTime("2026-11-03T09:05:00.000Z", now), { shown: "9:05", older: true, words: "Tuesday at 9:05" });
  // Within the last week a weekday is enough; past it the words need the date, and an earlier year's the year.
  assert.equal(rowTime("2026-10-30T09:05:00.000Z", now)?.words, "Friday at 9:05");
  assert.equal(rowTime("2026-10-29T09:05:00.000Z", now)?.words, "Thursday, October 29 at 9:05");
  assert.equal(rowTime("2025-10-21T09:05:00.000Z", now)?.words, "Tuesday, October 21, 2025 at 9:05");
});

test("row time: in words, today's rows say how long ago, agreeing with what they show", () => {
  const now = "2026-11-05T12:00:00.000Z";
  assert.equal(rowTime("2026-11-05T12:00:00.000Z", now)?.words, "now");
  assert.equal(rowTime("2026-11-05T11:59:00.000Z", now)?.words, "1 minute ago");
  assert.equal(rowTime("2026-11-05T10:00:00.001Z", now)?.words, "1 hour ago");
  assert.equal(rowTime("2026-11-05T10:00:00.000Z", now)?.words, "2 hours ago");
});

test("row time: the clock follows the person's 12-hour or 24-hour choice", () => {
  const now = "2026-11-05T12:00:00.000Z";
  assert.deepEqual(rowTime("2026-11-04T17:20:00.000Z", now, { timeFormat: "12h" }), { shown: "5:20 PM", older: true, words: "yesterday at 5:20 PM" });
  assert.equal(rowTime("2026-11-03T09:05:00.000Z", now, { timeFormat: "12h" })?.shown, "9:05 AM");
  assert.equal(formatRowClock("2026-11-03T00:05:00.000Z", { ...ROW_BASE, timeFormat: "12h" }), "12:05 AM");
  assert.equal(formatRowClock("2026-11-03T00:05:00.000Z", ROW_BASE), "0:05", "midnight is never 24:05");
});

test("row time: days are counted in the person's own time zone", () => {
  // 02:30 UTC on the 5th is still the evening of the 4th in New York, so 00:30 UTC is the same day there.
  const newYork = { timeZone: "America/New_York" };
  const now = "2026-11-05T02:30:00.000Z";
  assert.equal(rowTime("2026-11-05T00:30:00.000Z", now, newYork)?.shown, "2h", "still today there");
  assert.equal(rowTime("2026-11-04T23:30:00.000Z", now)?.older, true, "yesterday in UTC");
});

test("row time: zh-cn uses its own shortest words, a space between digits and CJK", () => {
  const now = "2026-11-05T12:00:00.000Z";
  const zh = { locale: "zh-cn" };
  assert.deepEqual(rowTime("2026-11-05T11:59:30.000Z", now, zh, zhCn), { shown: "刚刚", older: false, words: "刚刚" });
  assert.deepEqual(rowTime("2026-11-05T11:57:00.000Z", now, zh, zhCn), { shown: "3 分钟", older: false, words: "3 分钟前" });
  assert.deepEqual(rowTime("2026-11-05T10:00:00.000Z", now, zh, zhCn), { shown: "2 小时", older: false, words: "2 小时前" });
  assert.deepEqual(rowTime("2026-11-04T17:20:00.000Z", now, zh, zhCn), { shown: "17:20", older: true, words: "昨天 17:20" });
  assert.equal(rowTime("2026-11-03T09:05:00.000Z", now, zh, zhCn)?.words, "星期二 9:05");
  assert.equal(formatRowClock("2026-11-04T17:20:00.000Z", { ...ROW_BASE, ...zh, timeFormat: "12h" }), "下午 5:20");
});

test("row time: a time that doesn't parse shows nothing", () => {
  assert.equal(rowTime("not a time", "2026-11-05T12:00:00.000Z"), null);
  assert.equal(rowTimeKey("not a time", ROW_BASE), "");
});

test("row time key: changes when the words change, and only then", () => {
  const key = (value: string, now: string) => rowTimeKey(value, { ...ROW_BASE, now: new Date(now) });
  const at = "2026-11-05T12:00:00.000Z";
  assert.equal(key(at, "2026-11-05T12:00:30.000Z"), key(at, "2026-11-05T12:00:59.000Z"));
  assert.notEqual(key(at, "2026-11-05T12:00:59.000Z"), key(at, "2026-11-05T12:01:00.000Z"));
  assert.equal(key(at, "2026-11-05T12:03:00.000Z"), key(at, "2026-11-05T12:03:59.000Z"));
  assert.notEqual(key(at, "2026-11-05T12:59:59.000Z"), key(at, "2026-11-05T13:00:00.000Z"));
  // An older row: the same all day, and new the next ("yesterday at" becomes a weekday).
  const older = "2026-11-03T12:00:00.000Z";
  assert.equal(key(older, "2026-11-05T01:00:00.000Z"), key(older, "2026-11-05T23:00:00.000Z"));
  assert.notEqual(key(older, "2026-11-05T23:00:00.000Z"), key(older, "2026-11-06T01:00:00.000Z"));
});

test("day label: Today, Yesterday, then the weekday and date, with the year for an earlier year", () => {
  const label = (value: string, today = "2026-11-05") => formatDayLabel(value, { today, locale: "en-US", timeZone: "UTC", todayLabel: "Today", yesterdayLabel: "Yesterday" });
  assert.equal(label("2026-11-05T23:59:00.000Z"), "Today");
  assert.equal(label("2026-11-04T00:00:00.000Z"), "Yesterday");
  assert.equal(label("2026-10-20T12:00:00.000Z"), "Tuesday, October 20");
  assert.equal(label("2025-10-21T12:00:00.000Z"), "Tuesday, October 21, 2025");
  // Yesterday across a year's end is still Yesterday.
  assert.equal(label("2025-12-31T12:00:00.000Z", "2026-01-01"), "Yesterday");
  assert.equal(label("not a time"), "");
});

test("time format preference normalization keeps system-locale fallback separate from user override", () => {
  assert.equal(normalizePreferredTimeFormat("24H"), "24h");
  assert.equal(normalizePreferredTimeFormat("12h"), "12h");
  assert.equal(normalizePreferredTimeFormat("system"), null);
  assert.equal(resolveTimeFormatPreference("24h", "en-US"), "24h");
  assert.equal(resolveTimeFormatPreference(null, "en-US"), "12h");
  assert.equal(resolveTimeFormatPreference(null, "en-GB"), "24h");
});

test("components and pages do not format UI times with raw browser APIs", () => {
  const offenders: string[] = [];
  const rawTimeFormatPattern = /toLocaleTimeString|toLocaleString\(|Intl\.DateTimeFormat/;

  for (const sourcePath of [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/features"),
    ...sourceFilesUnder("src/pages"),
  ]) {
    const source = readSource(sourcePath);
    if (rawTimeFormatPattern.test(source)) offenders.push(sourcePath);
  }

  assert.deepEqual(offenders, []);
});

test("display surfaces do not read the 24-hour preference outside the settings toggle", () => {
  const offenders: string[] = [];
  const preferencePattern = /preferredTimeFormat|effectiveTimeFormat/;
  const allowed = new Set(["src/features/settings/language-region/LanguageRegionSection.tsx"]);

  for (const sourcePath of [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/features"),
    ...sourceFilesUnder("src/pages"),
  ]) {
    if (allowed.has(sourcePath)) continue;
    const source = readSource(sourcePath);
    if (preferencePattern.test(source)) offenders.push(sourcePath);
  }

  assert.deepEqual(offenders, []);
});
