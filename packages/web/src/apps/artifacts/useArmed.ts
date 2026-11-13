import { useEffect, useEffectEvent, useState } from "react";
// oxlint-disable-next-line react-doctor/no-flush-sync -- `onDisarmed` (focus into the view) must reach the view with its `inert` already gone, in the timer's own task; a transition would leave it inert, and focus can't land in an inert subtree.
import { flushSync } from "react-dom";

import { PAGE_COMMENT_ARM_MS } from "./artifactPageComments";

/**
 * True for PAGE_COMMENT_ARM_MS after `key` changes (a view the page's report brought), from its
 * first render: while armed the view is inert, so it takes no press, no click and no key
 * (Porthole THREAT_MODEL §6, as the page's comment box is armed, ArtifactCommentBox). Null: not armed.
 * `onDisarmed`, if given, runs once the view is no longer inert (committed), for that key.
 */
export function useArmed(key: number | string | null, onDisarmed?: () => void): boolean {
  const [disarmed, setDisarmed] = useState<number | string | null>(null);
  const disarm = useEffectEvent((done: number | string) => {
    if (!onDisarmed) {
      setDisarmed(done);
      return;
    }
    // Committed first, so what `onDisarmed` does (focus) reaches a view no longer inert.
    flushSync(() => setDisarmed(done));
    onDisarmed();
  });
  useEffect(() => {
    if (key === null) return;
    // A timer, not an event: the guard is a fixed time from when the view appeared.
    const timer = window.setTimeout(() => disarm(key), PAGE_COMMENT_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [key]);
  return key !== null && disarmed !== key;
}
