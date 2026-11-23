/**
 * #triage:#244: a page back from hidden or frozen re-reads Activity once.
 *
 * A frozen page (an iOS installed web app in the background, a browser tab
 * the browser froze: Page Lifecycle `freeze`) runs no code, so it receives no
 * socket events and owes no read (hiddenOwedReads): on its return the
 * Activity list stayed as it was before it went away, with no read to correct
 * it until the next live event. So the recovery (socketBridge
 * recoverLiveSession) asks for one Activity read when the page shows again
 * after it was:
 * - frozen (`freeze` seen; it shows with `resume`, then visibilitychange),
 * - restored from the back/forward cache (pageshow persisted),
 * - woken from system sleep (Raft Desktop's system resume: a wake may bring
 *   no focus or visibilitychange, so a visible page re-reads at the wake), or
 * - hidden at least RESUME_REREAD_HIDDEN_MS for its platform.
 *
 * All platforms, at different floors: the read is one throttled list read
 * (skipped when a reset read started in the last throttle window, e.g. an
 * owed read the same show paid), and any background tab can be frozen or
 * have its socket silently parked; the floor keeps a quick tab or app switch
 * free. An installed web app (clientPlatformHint `pwa`) is the one iOS freezes
 * within seconds, so its floor is short.
 */
import { hasChatSurfaces } from "../embed";
import { clientPlatformHint } from "../utils/clientPlatformHint";
import type { ClientPlatformHint } from "../utils/clientPlatformHint";
import { isPageVisible } from "../utils/visiblePoll";
import { traceLiveSession } from "./hiddenOwedReads";
import { requestInboxResumeRefresh } from "./inboxStore";

export const RESUME_REREAD_HIDDEN_MS: Readonly<Record<ClientPlatformHint, number>> = {
  pwa: 5_000,
  browser: 60_000,
  desktop_app: 60_000,
};

export type ResumeRereadCause = "frozen" | "wake" | "bfcache" | "hidden";

export type ResumeActivityReread = {
  /** The page went hidden (visibilitychange to hidden, pagehide). */
  noteHidden(now: number): void;
  /** Page Lifecycle `freeze`: the page will run nothing until `resume`. */
  noteFrozen(now: number): void;
  /** A system wake (Raft Desktop): the page ran nothing while the machine slept. */
  noteWoke(now: number): void;
  /** A back/forward cache restore (pageshow with persisted). */
  noteRestored(): void;
  /**
   * The page is visible again: the cause of a due re-read (and the re-read
   * asked for), or null. Ends the hidden spell either way.
   */
  noteVisible(now: number): ResumeRereadCause | null;
};

export function createResumeActivityReread(platform: () => ClientPlatformHint, reread: (cause: ResumeRereadCause) => void): ResumeActivityReread {
  let hiddenAt: number | null = null;
  let frozen = false;
  let woke = false;
  let restored = false;
  return {
    noteHidden(now) {
      hiddenAt ??= now;
    },
    noteFrozen(now) {
      hiddenAt ??= now;
      frozen = true;
    },
    noteWoke(now) {
      hiddenAt ??= now;
      woke = true;
    },
    noteRestored() {
      restored = true;
    },
    noteVisible(now) {
      const cause: ResumeRereadCause | null = frozen
        ? "frozen"
        : woke
          ? "wake"
          : restored
            ? "bfcache"
            : hiddenAt !== null && now - hiddenAt >= RESUME_REREAD_HIDDEN_MS[platform()]
              ? "hidden"
              : null;
      hiddenAt = null;
      frozen = false;
      woke = false;
      restored = false;
      if (cause !== null) reread(cause);
      return cause;
    },
  };
}

/**
 * Wired to the page by socketBridge: `recovered(event)` ends each live-session
 * recovery (after the owed reads it paid), and a Page Lifecycle `resume`
 * runs `recover`; `woke()` is Raft Desktop's system resume (socketBridge
 * installSystemResumeRecovery): visible, it re-reads now; hidden, at the
 * next show. The re-read is traced as live_session `recover`,
 * `resume_<cause>`, `activity_reread`.
 */
export function installResumeActivityReread(recover: (event: Event) => void): { recovered(event?: Event): void; woke(): void; dispose(): void } {
  const tracker = createResumeActivityReread(clientPlatformHint, (cause) => {
    if (hasChatSurfaces() && requestInboxResumeRefresh()) traceLiveSession("recover", `resume_${cause}`, "activity_reread");
  });
  const onFreeze = () => tracker.noteFrozen(Date.now());
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", recover);
  return {
    recovered(event) {
      if (!isPageVisible()) return tracker.noteHidden(Date.now());
      if (event?.type === "pageshow" && (event as PageTransitionEvent).persisted) tracker.noteRestored();
      tracker.noteVisible(Date.now());
    },
    woke() {
      tracker.noteWoke(Date.now());
      if (isPageVisible()) tracker.noteVisible(Date.now());
    },
    dispose() {
      document.removeEventListener("freeze", onFreeze);
      document.removeEventListener("resume", recover);
    },
  };
}
