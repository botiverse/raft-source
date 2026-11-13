import type { IntlShape } from "react-intl";
import { formatRelativeTimeParts } from "../../../utils/relativeTime";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long until a used-up allowance resets, as the rack's cell counts it:
 * minutes under an hour, hours under 48 hours, then days. Counted down
 * (floor, at least 1): 3h 59m left reads "3h", the last minute "1m", 71h "2d".
 */
export interface RackReset {
  unit: "minute" | "hour" | "day";
  count: number;
}

/** The reset, or null when it isn't known or has already passed (the cell then says "Used up"). */
export function rackReset(resetsAt: string | null | undefined, nowMs: number): RackReset | null {
  if (!resetsAt) return null;
  const left = Date.parse(resetsAt) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  if (left < HOUR_MS) return { unit: "minute", count: Math.max(1, Math.floor(left / MINUTE_MS)) };
  if (left < 48 * HOUR_MS) return { unit: "hour", count: Math.floor(left / HOUR_MS) };
  return { unit: "day", count: Math.floor(left / DAY_MS) };
}

const SHORT_IDS = {
  minute: "machine.rack.resetsInMinutes",
  hour: "machine.rack.resetsInHours",
  day: "machine.rack.resetsInDays",
} as const;

/**
 * A used-up cell's words when its reset is known: `short` in the cell
 * ("Back in 3h"), `full` for its name ("Used up · back in 3 hours"), the
 * same count. Null when the reset isn't known or has passed. The usage
 * column (RACK_USAGE_CELL_PX) is as wide as the widest of them with a
 * two-digit count and the attention pixel, so none is cut off.
 */
/** When a reset comes, relative, as the usage card and cell count it ("in 6 days"); null when unknown or past. */
export function resetWhen(resetsAt: string | null | undefined, locale: string, nowMs: number): string | null {
  const reset = rackReset(resetsAt, nowMs);
  return reset ? formatRelativeTimeParts(reset.count, reset.unit, locale, { numeric: "always" }) : null;
}

export function rackResetText(
  resetsAt: string | null | undefined,
  { formatMessage, locale }: Pick<IntlShape, "formatMessage" | "locale">,
  nowMs: number,
): { short: string; full: string } | null {
  const reset = rackReset(resetsAt, nowMs);
  if (!reset) return null;
  const when = formatRelativeTimeParts(reset.count, reset.unit, locale, { numeric: "always" });
  return {
    short: formatMessage({ id: SHORT_IDS[reset.unit] }, { count: reset.count }),
    full: formatMessage({ id: "machine.rack.usedUpResets" }, { when }),
  };
}
