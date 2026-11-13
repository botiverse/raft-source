/**
 * Keeps one direction of a timeline from asking for the same page twice.
 *
 * A guard kept in React state lags a render: a scroll event that lands after
 * a page arrives but before the re-render still sees the old messages and
 * asks for that page again (task #5: a thread paged up asked for 4 pages of 4
 * twice). The guard answers at once. A page is named by its cursor ("thread:seq").
 */
export type TimelinePageGuard = {
  /** Whether `key` may be fetched now; if so it is marked in flight. */
  start(key: string): boolean;
  /** The fetch of `key` ended; `loaded` when its page was applied. */
  finish(key: string, loaded: boolean): void;
  /** The timeline starts over: any page may be fetched again. */
  reset(): void;
};

export function createTimelinePageGuard(): TimelinePageGuard {
  let inFlight: string | null = null;
  let loaded: string | null = null;
  return {
    start(key) {
      if (inFlight !== null || loaded === key) return false;
      inFlight = key;
      return true;
    },
    finish(key, ok) {
      if (inFlight === key) inFlight = null;
      if (ok) loaded = key;
    },
    reset() {
      inFlight = null;
      loaded = null;
    },
  };
}
