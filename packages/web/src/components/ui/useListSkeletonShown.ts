import { useEffect, useState } from "react";

/** raft-design Feedback: a list skeleton shows only once the wait passes 1 second. */
const LIST_SKELETON_DELAY_MS = 1000;

/**
 * Whether a list's skeleton shows yet: false until the load has taken
 * `delay` (1 second by default, raft-design Feedback), so a fast load goes
 * straight to the rows. For a list whose rows are its own, not ListRowSkeleton.
 */
export function useListSkeletonShown(delay = LIST_SKELETON_DELAY_MS): boolean {
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return;
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return shown;
}
