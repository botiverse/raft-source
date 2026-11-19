/**
 * Foreground DDL waits for checkpoint barriers. The two-generation graph
 * stalls awaiting checkpoint completion at the old 100ms interval even with
 * empty tables; keep the normal interval while building it. Local and CI
 * RisingWave only: the bootstrap refuses non-loopback URLs first.
 */
/** RisingWave's default barrier interval. */
export const DEFAULT_BARRIER_INTERVAL_MS = 1000;
export const BOOTSTRAP_BARRIER_INTERVAL_MS = DEFAULT_BARRIER_INTERVAL_MS;
const LEGACY_FAST_BOOTSTRAP_INTERVAL_MS = 100;

/** The interval to restore after the build. A value at or below the
 *  old 100ms bootstrap interval is a leftover from a run killed before it could
 *  restore (Ctrl-C or SIGKILL skip `finally`; ALTER SYSTEM persists in meta),
 *  so it goes back to the default rather than staying there. */
export function barrierIntervalToRestore(current: number | null): number {
  return current !== null && current > LEGACY_FAST_BOOTSTRAP_INTERVAL_MS ? current : DEFAULT_BARRIER_INTERVAL_MS;
}
