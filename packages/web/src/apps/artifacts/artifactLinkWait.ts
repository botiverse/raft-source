import { currentTimeMs } from "@botiverse/raft-shared";

/**
 * When the wait on a canonical Artifact link began, so the page that follows its loading screen
 * (ArtifactLinkLoading) continues the same loading splash instead of starting it again
 * (#proj-workspace:#145): the link's screen is that splash already, so a page that took longer than
 * a second shows the icon at once, mid-cycle, and nothing is swapped for another placeholder.
 *
 * - The first link screen of a page load that the boot shell prerendered (`html.boot-artifact`)
 *   began with the navigation: the prerendered cover's own 1-second wait counts from there too.
 * - A later one (the app's own navigation to a link) begins when it first renders.
 * - Every link screen of the same wait (the app's boot, the page's chunk, its `open`, the public
 *   view's read) and the page after it take the same start, as long as one is on screen or the last
 *   one went within ARTIFACT_LINK_WAIT_HANDOVER_MS (the page replaces it in the same commit); after
 *   that the wait is over and the next one starts afresh.
 */

/** How long after the last link screen went a page still continues its wait. */
export const ARTIFACT_LINK_WAIT_HANDOVER_MS = 1000;

let startedAt: number | null = null;
let shown = 0;
let lastGoneAt = Number.NEGATIVE_INFINITY;
/**
 * The navigation's start while the page load's first wait lasts (a prerendered link, else null);
 * undefined until a link screen first asks. Kept apart from `startedAt` because a link screen's
 * first render may never commit (StrictMode renders it twice; a render can be thrown away): every
 * render of the first wait must count from the navigation, not only the first one.
 */
let bootWait: number | null | undefined;

function ongoing(now: number): boolean {
  return startedAt !== null && (shown > 0 || now - lastGoneAt < ARTIFACT_LINK_WAIT_HANDOVER_MS);
}

function prerenderedAtBoot(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("boot-artifact");
}

/** The navigation's start on the clock currentTimeMs reads. */
function navigationStart(now: number): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? now - performance.now() : now;
}

/** For a link screen as it first renders: the wait it is part of, begun now (or at the navigation) if none is. */
export function artifactLinkWaitStart(): number {
  const now = currentTimeMs();
  if (ongoing(now)) return startedAt!;
  if (bootWait === undefined) bootWait = prerenderedAtBoot() ? Math.min(now, navigationStart(now)) : null;
  startedAt = bootWait ?? now;
  return startedAt;
}

/** For a link screen's effect: it is on screen until the returned cleanup runs. */
export function noteArtifactLinkWaitShown(): () => void {
  shown += 1;
  return () => {
    shown -= 1;
    lastGoneAt = currentTimeMs();
    // The first wait goes on through the handover (ongoing); a wait after it is the app's own navigation.
    bootWait = null;
  };
}

/** For the page after a link screen (ArtifactSplashScope `initialStart`): the wait's start, or null when none is going on. */
export function artifactLinkWaitStarted(): number | null {
  return ongoing(currentTimeMs()) ? startedAt : null;
}

export function resetArtifactLinkWaitForTests(): void {
  startedAt = null;
  shown = 0;
  lastGoneAt = Number.NEGATIVE_INFINITY;
  bootWait = undefined;
}
