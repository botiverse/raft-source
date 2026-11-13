// Shared relative-time formatter. Canonical home for the Intl.RelativeTimeFormat
// logic that was previously duplicated across several components.
//
// Returns a localized relative string like "2 hours ago" / "in 3 days", or null
// when the input is absent/invalid.
//
// Uses the shared `currentTimeMs()` clock rather than calling the system clock
// directly, keeping time deterministic in tests.
//
// 盘古之白 (task #61): CLDR renders zh relative times with the digit pressed
// against the unit ("5分钟后"). @artin made CJK/digit mixed-script spacing a
// typography red line on 2026-08-03; @AngLee/@Wug ruled digit-CJK adjacency RED,
// and the mobile lane landed the same fix in task #103. So zh output gets a
// space inserted between ASCII digits and CJK. Only zh locales are affected
// (the app ships en + zh-cn catalogs); en output is untouched.

import { currentTimeMs } from "@botiverse/raft-shared";

// Perf: Intl.RelativeTimeFormat construction is not free, and both entry points
// run per visible row (Activity/Inbox lists are unvirtualized — render cost
// grows with row count). @铁根 patrol 2026-08-04 (landed 81fbf35e9): the
// pre-migration react-intl path cached its formatter; this helper re-created it
// every call. Cache by (locale, options) key — the app has ~2 locales and one
// options shape, so the cache is tiny and unbounded is fine. Different
// locale/options keys stay isolated.
const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeTimeFormat(
  locale: string | string[],
  options: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  const key = `${String(locale)}\u0000${JSON.stringify(options)}`;
  let rtf = rtfCache.get(key);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, options);
    rtfCache.set(key, rtf);
  }
  return rtf;
}

function isZhLocale(locale: string | string[]): boolean {
  return (Array.isArray(locale) ? locale : [locale]).some((l) =>
    String(l).toLowerCase().startsWith("zh"),
  );
}

/** Insert a space between ASCII digits and CJK ("5分钟后" -> "5 分钟后"). */
function zhMixedScriptSpacing(value: string): string {
  return value
    .replace(/(\d)\s*([\u4e00-\u9fff\u3400-\u4dbf])/g, "$1 $2")
    .replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s*(\d)/g, "$1 $2");
}

/** The zh digit/CJK spacing, for text this file's formatters didn't produce (a row's clock: "下午 5:20"). */
export function withZhSpacing(value: string, locale: string | string[]): string {
  return isZhLocale(locale) ? zhMixedScriptSpacing(value) : value;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The unit a span is counted in: minutes under an hour, hours under a day, then days. */
function relativeStep(absMs: number): { unit: "minute" | "hour" | "day"; ms: number } {
  if (absMs < HOUR_MS) return { unit: "minute", ms: MINUTE_MS };
  if (absMs < DAY_MS) return { unit: "hour", ms: HOUR_MS };
  return { unit: "day", ms: DAY_MS };
}

export function formatRelativeTime(value: string | null | undefined, locale: string | string[]): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - currentTimeMs();
  const absMs = Math.abs(diffMs);
  const rtf = getRelativeTimeFormat(locale, { numeric: "auto" });
  const { unit, ms } = relativeStep(absMs);
  const rendered = rtf.format(Math.round(diffMs / ms), unit);
  return isZhLocale(locale) ? zhMixedScriptSpacing(rendered) : rendered;
}

/**
 * How long ago, as short as it gets ("9d ago", "9 天前"), for a phone's tight lines. The same steps as
 * `formatRelativeTime`, with `numeric: "always"`: its "this minute" and "yesterday" are the long forms here. A clock
 * a little behind the server's reads as just now, never "in 0m" (the negated zero is what says past). Where a locale's
 * narrow form only marks the past with a minus (Russian: "-9 дн."), which reads as a sum, it says `short` ("9 дн. назад").
 */
export function formatShortRelativeTime(value: string | null | undefined, locale: string | string[]): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const age = Math.max(0, currentTimeMs() - date.getTime());
  const { unit, ms } = relativeStep(age);
  const count = -Math.round(age / ms);
  const narrow = formatRelativeTimeParts(count, unit, locale, { numeric: "always", style: "narrow" });
  return /^[-\u2212]/.test(narrow) ? formatRelativeTimeParts(count, unit, locale, { numeric: "always", style: "short" }) : narrow;
}

/**
 * react-intl-signature parts formatter (value + unit) with the same zh spacing
 * pass. Several components previously called `intl.formatRelativeTime`
 * DIRECTLY, splitting the app's relative-time display across two formatter APIs
 * and silently skipping the 盘古之白 spacing (zh rendered "3小时前"). This is the
 * single replacement for those direct calls: it reproduces react-intl's output
 * (Intl.RelativeTimeFormat under the hood) plus the spacing, so the runtime
 * spacing blind spot cannot split again. A source contract test pins the four
 * consumer files to this entry point.
 */
export function formatRelativeTimeParts(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  locale: string | string[],
  options?: Intl.RelativeTimeFormatOptions,
): string {
  const rtf = getRelativeTimeFormat(locale, { numeric: "auto", ...options });
  const rendered = rtf.format(value, unit);
  return isZhLocale(locale) ? zhMixedScriptSpacing(rendered) : rendered;
}
