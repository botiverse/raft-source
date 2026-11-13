// RAFT_PRIVACY_MODE holding for web telemetry (store/privacyMode.ts): until the
// client config answers, sends are held in memory and nothing leaves the page;
// "off" releases them, "on" drops them. Used by webAuthTrace.ts (its queue and
// its urgent sends) and analytics/publicVisits.ts; analytics/track.ts holds its
// own queue the same way.
//
// Like webAuthTrace.ts, no app imports: only the dependency-free store.
import { isPrivacyModeOn, isPrivacyModeUnknown, subscribePrivacyMode } from "../store/privacyMode";

/** Records a queue may hold while unanswered; past it new ones are dropped. */
const MAX_HELD_RECORDS = 500;

/** Whether a send may go now: false while unanswered (hold) and when on (drop). */
export function privacyAllowsSend(): boolean {
  return !isPrivacyModeOn() && !isPrivacyModeUnknown();
}

/** Whether a queue of `length` may take one more record: never when on; capped while unanswered. */
export function privacyAllowsQueue(length: number): boolean {
  return !isPrivacyModeOn() && !(isPrivacyModeUnknown() && length >= MAX_HELD_RECORDS);
}

/**
 * Sends that wait for the answer: `send(item)` runs `run(item)` now when off,
 * holds it (up to `max`) while unanswered, drops it when on. `onAnswered`
 * runs once the answer releases or drops what was held.
 */
export function createPrivacyHold<T>(
  max: number,
  run: (item: T) => Promise<void> | void,
  onAnswered?: (on: boolean) => void,
): { send(item: T): Promise<void> } {
  let held: T[] = [];
  subscribePrivacyMode((state) => {
    const items = held;
    held = [];
    if (state === "off") for (const item of items) void run(item);
    onAnswered?.(state === "on");
  });
  return {
    send(item) {
      if (isPrivacyModeOn()) return Promise.resolve();
      if (isPrivacyModeUnknown()) {
        if (held.length < max) held.push(item);
        return Promise.resolve();
      }
      return Promise.resolve(run(item));
    },
  };
}

/** Wait for an urgent send, at most `timeoutMs` (0: no bound). Never rejects past the send's own rejection. */
export async function waitForUrgentTraceSend(promise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    await promise;
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}
