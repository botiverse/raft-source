import { useEffect, useRef } from "react";
import { LOCATED_MS } from "@botiverse/raft-ui";

/**
 * Slack after LOCATED_MS. The row starts its highlight when it renders, which
 * can be a moment after the request (the list scrolls to it first); retiring
 * the request then would cut the fade short.
 */
const RETIRE_SLACK_MS = 1000;

/**
 * Retires a jump once its located highlight has run
 * (design/foundations/states.md#located). raft-ui's `useLocated(request)`
 * shows and ends the highlight; the app still holds the request that started
 * it (a store's focused id, a list's focused key), and drops it here so a
 * later render, a remount or a re-sorted list can't light it again.
 *
 * `request` names one jump, as a string that changes on every jump (an id and
 * a counter), or null. Pass the same request useLocated gets, once the item
 * is on screen. Re-renders with the same request don't restart the count, so
 * new messages in a busy channel can't hold the highlight on.
 */
export function useRetireJump(request: string | null | undefined, retire: () => void): void {
  const retireRef = useRef(retire);
  retireRef.current = retire;
  useEffect(() => {
    if (request == null) return;
    // The count starts when useLocated lights the highlight, two frames after
    // the request, not at the request: on a busy main thread (a long thread
    // opening on a slow machine) those frames can come seconds later, and a
    // count started at the request retired the jump before it ever lit.
    let timer: number | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        timer = window.setTimeout(() => retireRef.current(), LOCATED_MS + RETIRE_SLACK_MS);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [request]);
}
