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

export function formatRelativeTime(value: string | null | undefined, locale: string | string[]): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diffMs = date.getTime() - currentTimeMs();
  const absMs = Math.abs(diffMs);
  const rtf = getRelativeTimeFormat(locale, { numeric: "auto" });

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let rendered: string;
  if (absMs < hour) rendered = rtf.format(Math.round(diffMs / minute), "minute");
  else if (absMs < day) rendered = rtf.format(Math.round(diffMs / hour), "hour");
  else rendered = rtf.format(Math.round(diffMs / day), "day");
  return isZhLocale(locale) ? zhMixedScriptSpacing(rendered) : rendered;
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
