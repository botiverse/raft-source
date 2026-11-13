import { useState } from "react";

/**
 * A value that only changes once it is settled: while `settled` is false (a list reloading for a new filter), it
 * stays what it last was when settled, instead of dropping to the store's "not known yet" default and coming back
 * a moment later (Raft DS › Responsive layout, "The first frame is the settled one").
 *
 * `initial` is the value before anything has settled, a hint the caller already has (a cached count, say); without
 * it, the first value passed is used.
 */
export function useSettledValue<T>(value: T, settled: boolean, initial?: T): T {
  const [held, setHeld] = useState<T>(() => (settled || initial === undefined ? value : initial));
  // Adjusting state while rendering (React: "storing information from previous renders"), so the held value is
  // right in the same frame, not one effect later.
  if (settled && !Object.is(held, value)) setHeld(value);
  return settled ? value : held;
}
