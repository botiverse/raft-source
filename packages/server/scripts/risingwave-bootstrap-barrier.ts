/**
 * The bootstrap shortens RisingWave's barrier interval while it builds the
 * materialized views (each foreground CREATE MATERIALIZED VIEW waits for
 * checkpoint barriers). Local and CI RisingWave only: the bootstrap refuses
 * non-loopback URLs before it gets here.
 */
export const BOOTSTRAP_BARRIER_INTERVAL_MS = 100;
/** RisingWave's default barrier interval. */
export const DEFAULT_BARRIER_INTERVAL_MS = 1000;

/** The interval to restore after the build. A value at or below the
 *  bootstrap's is a leftover from a bootstrap that was killed before it could
 *  restore (Ctrl-C or SIGKILL skip `finally`; ALTER SYSTEM persists in meta),
 *  so it goes back to the default rather than staying there. */
export function barrierIntervalToRestore(current: number | null): number {
  return current !== null && current > BOOTSTRAP_BARRIER_INTERVAL_MS ? current : DEFAULT_BARRIER_INTERVAL_MS;
}
