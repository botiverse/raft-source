// A question card's answer can be taken back for a moment (question-card spec
// §5.10): a submit first waits QUESTION_SUBMIT_UNDO_MS on this device while
// the card says "Submitted · Undo", and only then executes. Undo within it
// returns to answering with every choice kept; nothing was sent, so neither
// the server nor the agent ever sees a corrected answer. Leaving the page or
// the tab going to the background sends it at once, `leaving` (a keepalive
// request that outlives the page: actionCardKeepaliveExecute.ts); closing the
// sheet or the card going away (unmounted: another channel, a closed thread)
// sends it at once as usual. So an answer is never lost to the wait. A card
// that can no longer be answered meanwhile (withdrawn, expired, answered by
// someone else, frozen: `open` false) shows no Undo; whether the answer is
// still sent is the card frame's check as it sends (ActionCardSpecCard's
// submitForm reads the card's state then: not prepared, nothing is sent and
// the form says so). The answer is taken before it is sent, so it goes once whichever
// comes first. Only question cards wait: every other form submits at once.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How long a question card's answer waits for an Undo before it is sent. */
export const QUESTION_SUBMIT_UNDO_MS = 1500;

export interface UndoableSubmit<T> {
  /** Whether a submit is waiting (the card shows "Submitted · Undo"). */
  waiting: boolean;
  /** Submits `payload`: after the wait when `enabled`, else at once. */
  start: (payload: T) => void;
  /** Takes the waiting submit back: nothing is sent. */
  undo: () => void;
  /** Sends the waiting submit now (none waiting: nothing). */
  flush: () => void;
}

/**
 * `send(payload, leaving)`: `leaving` when the page is going away or hidden.
 * `open`: whether the card can still be answered; while false a waiting
 * submit shows no Undo.
 */
export function useUndoableSubmit<T>(send: (payload: T, leaving: boolean) => void, enabled: boolean, open: boolean): UndoableSubmit<T> {
  const sendRef = useRef(send);
  sendRef.current = send;
  const waitingRef = useRef<{ payload: T; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [waiting, setWaiting] = useState(false);

  /** Takes the waiting submit, if any: from here on nothing else can send it. */
  const take = useCallback((): T | null => {
    const current = waitingRef.current;
    if (!current) return null;
    clearTimeout(current.timer);
    waitingRef.current = null;
    setWaiting(false);
    return current.payload;
  }, []);
  const sendTaken = useCallback((leaving: boolean) => {
    const payload = take();
    if (payload !== null) sendRef.current(payload, leaving);
  }, [take]);
  const flush = useCallback(() => sendTaken(false), [sendTaken]);
  const start = useCallback((payload: T) => {
    if (!enabled) {
      sendRef.current(payload, false);
      return;
    }
    if (waitingRef.current) return;
    waitingRef.current = { payload, timer: setTimeout(flush, QUESTION_SUBMIT_UNDO_MS) };
    setWaiting(true);
  }, [enabled, flush]);
  const undo = useCallback(() => {
    take();
  }, [take]);

  // Leaving or hiding the page sends at once, as a request that outlives it; so does going away (unmount).
  useEffect(() => {
    const onLeave = () => sendTaken(true);
    const onHidden = () => {
      if (document.visibilityState === "hidden") onLeave();
    };
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onHidden);
      flush();
    };
  }, [flush, sendTaken]);

  // A card that can't be answered shows no Undo (the frame drops its answer as it would send).
  const shown = waiting && open;
  return useMemo(() => ({ waiting: shown, start, undo, flush }), [flush, shown, start, undo]);
}
