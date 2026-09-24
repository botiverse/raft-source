// Pure functions: parse / compute next fire / format for the three v0
// recurrence forms (interval, daily, weekly). No DB, no clock — everything
// is an argument so the scheduler's tx branch and the CLI parse path share
// the same validated shape.
//
// Storage shape is a versioned envelope so future kinds (cron, rrule,
// monthly, end_at, maxCount) can be added without a column migration.
// Unknown kinds at read time are surfaced to the caller so the scheduler
// can skip-fire and warn instead of crashing or silently completing.

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export const WEEKDAY_ORDER: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type Rule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number; tz: string }
  | { kind: "weekly"; days: Weekday[]; hour: number; minute: number; tz: string };

export interface Recurrence {
  version: 1;
  rule: Rule;
}

export type ParseResult = { ok: true; recurrence: Recurrence } | { ok: false; error: string };

export const DEFAULT_RECURRENCE_TZ = "UTC";

const INTERVAL_MIN_SECONDS = 30; // guard against pathological re-fire loops
const INTERVAL_MAX_SECONDS = 365 * 24 * 3600;

/**
 * Parse the wire-level `--repeat` / `repeat` string into a stored Recurrence.
 * Grammar (v0):
 *   every:<N>(m|h|d)
 *   daily@HH:MM
 *   weekly:<dow-list>@HH:MM
 * Any other input is an error — callers surface the message to the user.
 */
export function parseRecurrenceString(
  input: string,
  tz: string = DEFAULT_RECURRENCE_TZ,
): ParseResult {
  const s = input.trim();
  if (s.length === 0) return { ok: false, error: "repeat rule is empty" };

  if (s.startsWith("every:")) return parseInterval(s.slice("every:".length));
  if (s.startsWith("daily@")) return parseDaily(s.slice("daily@".length), tz);
  if (s.startsWith("weekly:")) return parseWeekly(s.slice("weekly:".length), tz);

  return {
    ok: false,
    error: `unknown repeat form "${s}"; expected every:<N>(m|h|d) | daily@HH:MM | weekly:<dow-list>@HH:MM`,
  };
}

function parseInterval(rest: string): ParseResult {
  const m = /^(\d+)([mhd])$/.exec(rest);
  if (!m) {
    return { ok: false, error: `every:<N>(m|h|d) expected (e.g. every:15m, every:2h, every:1d), got "${rest}"` };
  }
  const n = Number(m[1]);
  const unit = m[2];
  const seconds = unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n * 86400;
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    return { ok: false, error: "interval overflow" };
  }
  if (seconds < INTERVAL_MIN_SECONDS) {
    return { ok: false, error: `interval must be >= 30s; got ${seconds}s` };
  }
  if (seconds > INTERVAL_MAX_SECONDS) {
    return { ok: false, error: "interval must be <= 1 year" };
  }
  return { ok: true, recurrence: { version: 1, rule: { kind: "interval", seconds } } };
}

function parseHM(s: string): { ok: true; hour: number; minute: number } | { ok: false; error: string } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return { ok: false, error: `expected HH:MM, got "${s}"` };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, error: `hour must be 0-23, got ${m[1]}` };
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    return { ok: false, error: `minute must be 0-59, got ${m[2]}` };
  }
  return { ok: true, hour, minute };
}

function parseDaily(rest: string, tz: string): ParseResult {
  const hm = parseHM(rest);
  if (!hm.ok) return { ok: false, error: `daily@${rest}: ${hm.error}` };
  return { ok: true, recurrence: { version: 1, rule: { kind: "daily", hour: hm.hour, minute: hm.minute, tz } } };
}

function parseWeekly(rest: string, tz: string): ParseResult {
  // weekly:<dow-list>@HH:MM
  const at = rest.lastIndexOf("@");
  if (at === -1) return { ok: false, error: `weekly:<dow-list>@HH:MM expected, got "weekly:${rest}"` };
  const dowsRaw = rest.slice(0, at);
  const hmRaw = rest.slice(at + 1);
  if (dowsRaw.length === 0) return { ok: false, error: "weekly: day-of-week list is empty" };

  const tokens = dowsRaw.split(",").map((t) => t.trim().toLowerCase());
  const seen = new Set<Weekday>();
  for (const t of tokens) {
    if (!isWeekday(t)) {
      return { ok: false, error: `unknown weekday "${t}"; use sun,mon,tue,wed,thu,fri,sat` };
    }
    seen.add(t);
  }
  const days = WEEKDAY_ORDER.filter((d) => seen.has(d)); // sorted, deduped
  if (days.length === 0) return { ok: false, error: "weekly: no valid weekdays parsed" };

  const hm = parseHM(hmRaw);
  if (!hm.ok) return { ok: false, error: `weekly: ${hm.error}` };
  return {
    ok: true,
    recurrence: { version: 1, rule: { kind: "weekly", days, hour: hm.hour, minute: hm.minute, tz } },
  };
}

function isWeekday(s: string): s is Weekday {
  return (WEEKDAY_ORDER as readonly string[]).includes(s);
}

/**
 * Human-facing one-line render of a Recurrence. Shown in CLI `list` output
 * and in activity log next to `reminder_fire (recurring)`.
 */
export function formatRecurrence(r: Recurrence): string {
  const rule = r.rule;
  if (rule.kind === "interval") return `every ${formatDurationSeconds(rule.seconds)}`;
  if (rule.kind === "daily") return `daily at ${pad2(rule.hour)}:${pad2(rule.minute)} ${rule.tz}`;
  return `weekly ${rule.days.join(",")} at ${pad2(rule.hour)}:${pad2(rule.minute)} ${rule.tz}`;
}

function formatDurationSeconds(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Compute the next fire time strictly greater than `from`. Throws on unknown
 * kind — callers (scheduler) must catch and skip-fire to keep forward-compat
 * with future variants written by newer versions.
 *
 * Timezone handling: `interval` is wall-clock-agnostic. `daily` and `weekly`
 * resolve HH:MM in the rule's stored tz so DST transitions don't shift the
 * user-visible fire time. The tz is snapshot into the rule at creation so
 * changing the owner agent's tz later doesn't retroactively shift schedules.
 */
export function computeNextFire(recurrence: Recurrence, from: Date): Date {
  const rule = recurrence.rule;
  if (rule.kind === "interval") {
    return new Date(from.getTime() + rule.seconds * 1000);
  }
  if (rule.kind === "daily") {
    return nextHM(from, rule.hour, rule.minute, rule.tz, null);
  }
  if (rule.kind === "weekly") {
    return nextHM(from, rule.hour, rule.minute, rule.tz, rule.days);
  }
  throw new UnsupportedRecurrenceError(
    `unsupported recurrence kind "${(rule as { kind: string }).kind}"`,
  );
}

export class UnsupportedRecurrenceError extends Error {
  readonly kind = "UnsupportedRecurrence";
}

/**
 * Returns true if the stored JSON shape is parseable by this version.
 * Used at read time to decide "fire normally" vs "skip + warn forward-compat".
 */
export function isSupportedRecurrence(value: unknown): value is Recurrence {
  if (!value || typeof value !== "object") return false;
  const v = value as { version?: unknown; rule?: unknown };
  if (v.version !== 1) return false;
  const rule = v.rule as { kind?: unknown } | null | undefined;
  if (!rule || typeof rule !== "object") return false;
  if (rule.kind !== "interval" && rule.kind !== "daily" && rule.kind !== "weekly") return false;
  return true;
}

// ── Timezone-aware next-HH:MM ───────────────────────────────────────────────
// Uses Intl.DateTimeFormat to bridge UTC <-> wall-clock in arbitrary IANA tz
// without adding a date library. All computations go via the `getTzParts` +
// `zonedTimeToUtc` pair which is the standard DST-correct shape.

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0=sun..6=sat, aligned with Date.getDay()
}

const WEEKDAY_TO_NUM: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  // Intl may return full names in some locales; accept both.
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6,
};

function getTzParts(utc: Date, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utc)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_TO_NUM[parts.weekday] ?? 0,
  };
}

function getTzOffsetMinutes(utc: Date, tz: string): number {
  const p = getTzParts(utc, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - utc.getTime()) / 60000);
}

/**
 * Given wall-clock (Y,M,D,h,m) in `tz`, returns the UTC Date that renders
 * to exactly that wall-clock. Handles DST by recomputing offset at the
 * candidate UTC and adjusting once — sufficient for non-pathological zones.
 */
function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offset1 = getTzOffsetMinutes(new Date(naive), tz);
  const guess = naive - offset1 * 60000;
  const offset2 = getTzOffsetMinutes(new Date(guess), tz);
  if (offset1 === offset2) return new Date(guess);
  return new Date(naive - offset2 * 60000);
}

function addDaysZoned(p: ZonedParts, days: number): { year: number; month: number; day: number } {
  // Use a UTC date math trick — add days in UTC space then re-derive Y/M/D.
  // This is safe because we only care about the calendar date rollover,
  // not the time component.
  const base = Date.UTC(p.year, p.month - 1, p.day);
  const shifted = new Date(base + days * 86400000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function weekdayIndexOf(d: Weekday): number {
  return WEEKDAY_ORDER.indexOf(d);
}

function nextHM(from: Date, hour: number, minute: number, tz: string, weekdays: Weekday[] | null): Date {
  const fromParts = getTzParts(from, tz);
  // Walk up to 8 days forward so weekly is guaranteed to hit at least one match.
  for (let offset = 0; offset < 8; offset++) {
    const dmy = addDaysZoned(fromParts, offset);
    const candidate = zonedTimeToUtc(dmy.year, dmy.month, dmy.day, hour, minute, tz);
    if (candidate.getTime() <= from.getTime()) continue;
    if (weekdays) {
      const cParts = getTzParts(candidate, tz);
      const cDowIndex = cParts.weekday; // 0=sun..6=sat
      const allowed = weekdays.some((d) => weekdayIndexOf(d) === cDowIndex);
      if (!allowed) continue;
    }
    return candidate;
  }
  throw new Error(`nextHM: no candidate found within 8 days for hour=${hour} minute=${minute} tz=${tz}`);
}
