/**
 * A server poll that stops while the page is hidden.
 *
 * Server requests are billed per request, a 304 included, and a background
 * tab used to keep every minute-poll going. Here:
 * - the interval runs only while the page is visible (it is cleared when the
 *   page hides and restarts when it shows);
 * - showing the page again runs one refresh;
 * - with `refreshOnFocus`, a window focus runs one while the page is visible
 *   (never while hidden). A focus and a show that come together (switching
 *   back to the tab fires both) run one refresh, not two.
 *
 * The mount read stays the caller's. Returns the stop function
 * (`createVisiblePoll` also returns `request`, a read asked for now).
 */
export const VISIBLE_POLL_COALESCE_MS = 1_000;

/**
 * The safety poll of a list the server pings when it changes (shared
 * listChangedEvents.ts: permission updates, joint invites, seat notices).
 * The ping, the mount read and a reconnect's read carry every change the
 * server writes; this only bounds what no write announces (an invite
 * expiring, an agent taking a seat) to 5 minutes while the page is visible.
 */
export const PINGED_LIST_SAFETY_POLL_MS = 5 * 60_000;

export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** A visible poll that also takes reads asked for outside it (a ping, a reconnect, the mount). */
export type VisiblePoll = {
  /**
   * Read now while the page is visible. While hidden nothing is read: the
   * read is owed and the read on show (which runs anyway) pays it, even
   * inside the focus/show coalescing window; so does a visible focus or
   * pageshow that came without a visibilitychange.
   */
  request: () => void;
  stop: () => void;
};

export function startVisiblePoll(
  run: () => void,
  options: { intervalMs: number; refreshOnFocus?: boolean },
): () => void {
  return createVisiblePoll(run, options).stop;
}

export function createVisiblePoll(
  run: () => void,
  { intervalMs, refreshOnFocus = false }: { intervalMs: number; refreshOnFocus?: boolean },
): VisiblePoll {
  if (typeof window === "undefined") return { request: run, stop: () => undefined };
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastEventRunAt = Number.NEGATIVE_INFINITY;
  let owed = false;

  const startTimer = () => {
    if (timer === null) timer = setInterval(() => { if (!isPageHidden()) run(); }, intervalMs);
  };
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const runForEvent = () => {
    if (isPageHidden()) return;
    const now = Date.now();
    if (!owed && now - lastEventRunAt < VISIBLE_POLL_COALESCE_MS) return;
    owed = false;
    lastEventRunAt = now;
    run();
  };
  const onVisibilityChange = () => {
    if (isPageHidden()) {
      stopTimer();
      return;
    }
    runForEvent();
    // The next tick is a full interval after this refresh.
    stopTimer();
    startTimer();
  };

  // A page back on screen without a visibilitychange (a PWA restored from
  // the background, bfcache) still pays an owed read on its focus or pageshow.
  const payOwed = () => {
    if (!owed || isPageHidden()) return;
    runForEvent();
    startTimer();
  };

  if (!isPageHidden()) startTimer();
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (refreshOnFocus) window.addEventListener("focus", runForEvent);
  window.addEventListener("focus", payOwed);
  window.addEventListener("pageshow", payOwed);
  return {
    request: () => {
      if (isPageHidden()) {
        owed = true;
        return;
      }
      run();
    },
    stop: () => {
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (refreshOnFocus) window.removeEventListener("focus", runForEvent);
      window.removeEventListener("focus", payOwed);
      window.removeEventListener("pageshow", payOwed);
    },
  };
}

/**
 * Reads asked for while the page is hidden, run when it shows again: one per
 * key (a later ask for a key merges into the owed one), each once. A read
 * asked for while visible is the caller's to run.
 */
export function createOwedReads<T>(run: (key: string, owed: T) => void, merge: (owed: T, next: T) => T) {
  const owed = new Map<string, T>();
  let listening = false;
  // listening: something is owed.
  const onVisibilityChange = () => {
    if (isPageHidden() || !listening) return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    listening = false;
    const due = [...owed];
    owed.clear();
    for (const [key, value] of due) run(key, value);
  };
  return {
    owe(key: string, value: T): void {
      const earlier = owed.get(key);
      owed.set(key, earlier === undefined ? value : merge(earlier, value));
      if (!listening) {
        document.addEventListener("visibilitychange", onVisibilityChange);
        listening = true;
      }
    },
    /** Run the owed reads now if the page is visible (a show that fired no visibilitychange). */
    flush: onVisibilityChange,
    /** Drop every owed read (a Server switch, logout, teardown). */
    clear(): void {
      owed.clear();
      if (listening) document.removeEventListener("visibilitychange", onVisibilityChange);
      listening = false;
    },
  };
}
