import { useSyncExternalStore } from "react";
import { currentTimeMs } from "@botiverse/raft-shared";
import { calendarDayKey } from "../utils/timeFormatting";
import { createTickingClock } from "./tickingClock";

// Today's date in a time zone, as "YYYY-MM-DD", re-rendering its readers when
// that day ends. Rows of the virtual timeline stay mounted for as long as the
// channel is open, so a "Today" divider read once at render would still say
// "Today" the morning after.
//
// It ticks on every quarter hour (UTC), since every time zone's midnight falls
// on one. A tick re-reads the day; React re-renders only the readers whose day
// changed.

const QUARTER_HOUR_MS = 15 * 60 * 1000;

// A beat past the boundary, so the day has turned when it fires.
const subscribe = createTickingClock(() => QUARTER_HOUR_MS - (currentTimeMs() % QUARTER_HOUR_MS) + 50);

/** Today in `timeZone` (the browser's when undefined), "YYYY-MM-DD"; updates when the day ends. */
export function useCurrentDay(timeZone?: string): string {
  const read = () => calendarDayKey(new Date(currentTimeMs()), { timeZone });
  return useSyncExternalStore(subscribe, read, read);
}
