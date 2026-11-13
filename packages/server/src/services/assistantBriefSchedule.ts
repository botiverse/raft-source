/**
 * RFC 077 step 2c: owner-local wall-clock arithmetic for the morning brief
 * (08:00 owner-local, once a day, claimable until noon), zone-aware without a
 * date library.
 */

export const BRIEF_HOUR = 8;
export const BRIEF_LATEST_HOUR = 12;

type Wall = { y: number; m: number; d: number; h: number; min: number };

function wallClock(at: number, zone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute") };
}

/** The owner-local day (YYYY-MM-DD) at `at`. */
export function localDay(at: number, zone: string): string {
  const w = wallClock(at, zone);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

export function localHour(at: number, zone: string): number {
  return wallClock(at, zone).h;
}

/** The instant a wall-clock time in `zone` happens (the first one, across a DST gap). */
function instantOf(y: number, m: number, d: number, h: number, zone: string): number {
  let guess = Date.UTC(y, m - 1, d, h, 0);
  for (let i = 0; i < 3; i++) {
    const w = wallClock(guess, zone);
    const diff = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Date.UTC(y, m - 1, d, h, 0);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** The next 08:00 owner-local strictly after `at` (today's if it is still before 08:00 there). */
export function nextBriefAt(at: number, zone: string): Date {
  const w = wallClock(at, zone);
  const today = instantOf(w.y, w.m, w.d, BRIEF_HOUR, zone);
  if (today > at) return new Date(today);
  const tomorrow = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
  return new Date(instantOf(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), BRIEF_HOUR, zone));
}
