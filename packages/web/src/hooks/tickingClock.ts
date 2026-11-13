import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";

/**
 * One clock for all its readers (a module singleton), not a timer per reader:
 * while anyone listens it ticks after `nextDelayMs()`, and when the page becomes
 * visible again (timers stall while a device sleeps). Returns its `subscribe`,
 * for useSyncExternalStore: a reader re-reads on each tick, and React re-renders
 * only the readers whose value changed.
 */
export function createTickingClock(nextDelayMs: () => number): (listener: () => void) => () => void {
  const listeners = new Set<() => void>();
  let timer: unknown = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const schedule = () => {
    if (timer !== null || listeners.size === 0) return;
    timer = setClockTimeout(() => {
      timer = null;
      schedule();
      notify();
    }, nextDelayMs());
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") notify();
  };

  return (listener) => {
    listeners.add(listener);
    if (listeners.size === 1 && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    schedule();
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      if (timer !== null) clearClockTimeout(timer);
      timer = null;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  };
}
