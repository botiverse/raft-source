import { useEffect, useState } from "react";

/**
 * A skeleton waits before it shows, so a fast load doesn't flash it (Feedback, "Empty, loading and failed"): raft-ui's
 * InboxItemSkeletonList waits 1 second by default, and the grid's and the table's placeholders wait the same.
 */
export const ARTIFACT_SKELETON_DELAY_MS = 1000;

/** Whether the skeleton's wait is over. */
export function useSkeletonShown(delay = ARTIFACT_SKELETON_DELAY_MS): boolean {
  const [shown, setShown] = useState(delay <= 0);
  useEffect(() => {
    if (delay <= 0) return;
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return shown;
}
