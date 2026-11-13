import { useEffect, useState } from "react";

/**
 * The value after it has stopped changing for `delayMs`. A search that asks the server
 * (the Marketplace, the Artifacts page's All tab) waits for a pause in typing
 * rather than sending a request per key.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    // A timer is the debounce itself: the request goes once typing pauses.
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return settled;
}
