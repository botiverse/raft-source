import { useEffect, useState } from "react";

/**
 * Whether the setup's approving button is locked. It takes no press for
 * `afterMs` after it could first be pressed (`ready`: the button is there
 * and nothing else disables it), and again for `afterMs` each time the
 * window regains the focus. So a click or a key press that was on its way to
 * something else (a page of the built-in browser, another window) when the
 * button appeared under it approves nothing: the person has had the button
 * in front of them, in a focused window, for that long.
 *
 * The interval starts when the button becomes pressable, not when its host
 * mounts: the lookups before it can take longer than the interval, which
 * would then be spent before there was a button.
 *
 * The caller renders the lock as the button's `disabled` (native on a
 * raft-ui Button that is not `loading`: no click, Enter or Space activates
 * it). The window's focus locks it in React's next render, which runs
 * before the browser's next input event: a click that brought the focus
 * with it (its mousedown did) finds the button disabled by its mouseup.
 *
 * `afterMs` undefined (the page in a browser): never locked.
 */
export function useApproveLock(afterMs: number | undefined, ready: boolean): boolean {
  const [unlocked, setUnlocked] = useState(false);
  /** Bumped when the window regains the focus: the interval starts over. */
  const [focusRound, setFocusRound] = useState(0);

  useEffect(() => {
    if (afterMs === undefined) return;
    const relock = () => {
      setUnlocked(false);
      setFocusRound((round) => round + 1);
    };
    window.addEventListener("focus", relock);
    return () => window.removeEventListener("focus", relock);
  }, [afterMs]);

  useEffect(() => {
    if (afterMs === undefined || !ready) return;
    const timer = window.setTimeout(() => setUnlocked(true), afterMs);
    return () => {
      window.clearTimeout(timer);
      setUnlocked(false);
    };
  }, [afterMs, ready, focusRound]);

  return afterMs !== undefined && !(ready && unlocked);
}
