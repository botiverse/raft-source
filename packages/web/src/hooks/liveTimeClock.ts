import { createTickingClock } from "./tickingClock";

// The clock of every live time on screen (ActivityRowTime). A row reads it inside
// useSyncExternalStore and compares what it would say, so a tick re-renders only
// the rows whose words changed. Every 15 seconds, since each row's minutes turn
// at their own second: a minute-long tick could leave "now" on screen for most of
// two minutes.
const TICK_MS = 15_000;

export const subscribeLiveTime = createTickingClock(() => TICK_MS);
