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

/**
 * Documents shown in windows of their own that the main page's code renders
 * into (features/objectWindows): while one of them is visible the page is not
 * hidden, even with the main window hidden or minimized behind it (Raft
 * Desktop on macOS hides the main window on close), since what they show is
 * the main page's live data.
 */
const companionDocuments = new Map<Document, (event: Event) => void>();
/** Listeners of onPageVisibilityChange, which also hear the companion documents' visibilitychange. */
const visibilityListeners = new Set<(event: Event) => void>();

export function isPageHidden(): boolean {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return false;
  for (const companion of companionDocuments.keys()) {
    if (companion.visibilityState === "visible") return false;
  }
  return true;
}

/** The page is visible: the main document is, or a companion document (an object window's) is. */
export function isPageVisible(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "visible") return true;
  for (const companion of companionDocuments.keys()) {
    if (companion.visibilityState === "visible") return true;
  }
  return false;
}

function notifyPageVisibility(event: Event): void {
  for (const listener of [...visibilityListeners]) listener(event);
}

/** Runs `change` and tells the visibility listeners when it showed or hid the page (a companion came or went). */
function changeCompanions(change: () => void): void {
  const hiddenBefore = isPageHidden();
  change();
  if (isPageHidden() !== hiddenBefore) notifyPageVisibility(new Event("visibilitychange"));
}

/**
 * Count `doc` (an object window's document) as part of the page while it is
 * open: isPageHidden is false while it is visible, and its visibilitychange
 * reaches onPageVisibilityChange's listeners. Returns the removal.
 */
export function addPageCompanionDocument(doc: Document): () => void {
  if (companionDocuments.has(doc)) return () => removePageCompanionDocument(doc);
  const relay = (event: Event) => notifyPageVisibility(event);
  changeCompanions(() => {
    companionDocuments.set(doc, relay);
    doc.addEventListener("visibilitychange", relay);
  });
  return () => removePageCompanionDocument(doc);
}

function removePageCompanionDocument(doc: Document): void {
  const relay = companionDocuments.get(doc);
  if (!relay) return;
  changeCompanions(() => {
    companionDocuments.delete(doc);
    doc.removeEventListener("visibilitychange", relay);
  });
}

/**
 * The page's visibilitychange: the main document's, a companion document's
 * (an object window's), and a companion opening or closing that shows or
 * hides the page. Read the state with isPageHidden. Returns the unsubscribe.
 */
export function onPageVisibilityChange(listener: (event: Event) => void): () => void {
  document.addEventListener("visibilitychange", listener);
  visibilityListeners.add(listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    visibilityListeners.delete(listener);
  };
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
  const stopVisibility = onPageVisibilityChange(onVisibilityChange);
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
      stopVisibility();
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
  // Set while something is owed: the unsubscribe from the page's visibility.
  let stopListening: (() => void) | null = null;
  const onVisibilityChange = () => {
    if (isPageHidden() || !stopListening) return;
    stopListening();
    stopListening = null;
    const due = [...owed];
    owed.clear();
    for (const [key, value] of due) run(key, value);
  };
  return {
    owe(key: string, value: T): void {
      const earlier = owed.get(key);
      owed.set(key, earlier === undefined ? value : merge(earlier, value));
      stopListening ??= onPageVisibilityChange(onVisibilityChange);
    },
    /** Run the owed reads now if the page is visible (a show that fired no visibilitychange). */
    flush: onVisibilityChange,
    /** Drop every owed read (a Server switch, logout, teardown). */
    clear(): void {
      owed.clear();
      stopListening?.();
      stopListening = null;
    },
  };
}
