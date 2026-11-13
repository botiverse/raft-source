import type { ArtifactId } from "@botiverse/raft-shared";

import { isInstalledWebApp } from "../../utils/clientPlatformHint";
import { isElectronDesktopShell } from "../../utils/desktopShell";

/**
 * Open in new page from Raft installed on a computer (#proj-workspace:#253,
 * xxchan; Remy, Jasper): an installed app has no tabs, so a plain new page is
 * a second app window as large as the screen, over the conversation. There it
 * is a document-sized window beside the app instead: at most 1100 wide (60% of
 * the screen), 85% of the screen tall, to the right of the app's window where
 * it fits, else against the screen's right edge (Jasper: never centred, so the
 * sidebar and the start of the conversation stay in view), its top at the app
 * window's top, always on the screen.
 *
 * Only Raft installed on a computer (display-mode standalone or
 * window-controls-overlay, clientPlatformHint). A browser tab still opens a
 * new tab, Raft Desktop keeps its own window handling, and a phone or an iPad
 * is unchanged (an iOS home-screen app can't open windows).
 *
 * The window is named per Artifact (`raft-artifact-<id>`, whatever the
 * version): asking again for the same Artifact targets the window that already
 * shows it, rather than piling up copies, and another Artifact gets its own
 * window beside it. Reuse wins over `noopener` here (coordinator's decision):
 * browsers keep a noopener window out of name lookup (another browsing context
 * group), and the page is Raft's own, same-origin, so noopener protects nothing
 * that matters. The features carry neither noopener nor noreferrer; instead the
 * window that comes back has its `opener` cleared, so it can't reach the app's
 * window either.
 *
 * Reopening must not reload (Jasper): the windows opened here are kept by name,
 * and one still open on the same address is only focused. Another address (a
 * pinned version), a closed window or none known (the app reloaded) goes
 * through window.open, which navigates the named window.
 */

export type ArtifactWindowScreen = { availLeft: number; availTop: number; availWidth: number; availHeight: number };
export type ArtifactWindowRect = { left: number; top: number; width: number; height: number };

export const ARTIFACT_WINDOW_MAX_WIDTH = 1100;
const WIDTH_SHARE = 0.6;
const HEIGHT_SHARE = 0.85;
/** Between the app's window and the Artifact's, so their edges don't touch. */
const GAP = 8;

/** The Artifact windows this app opened, by name (artifactWindowName). */
const openWindows = new Map<string, Window>();

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** Where the Artifact's window goes on `screen`, given the app's window (`app`). Pure: the unit tests drive it. */
export function artifactWindowRect(screen: ArtifactWindowScreen, app: ArtifactWindowRect): ArtifactWindowRect {
  const width = Math.round(Math.min(ARTIFACT_WINDOW_MAX_WIDTH, screen.availWidth * WIDTH_SHARE));
  const height = Math.round(screen.availHeight * HEIGHT_SHARE);
  const right = screen.availLeft + screen.availWidth;
  const bottom = screen.availTop + screen.availHeight;
  const beside = app.left + app.width + GAP;
  const fitsBeside = beside >= screen.availLeft && beside + width <= right;
  return {
    width,
    height,
    left: clamp(fitsBeside ? beside : right - width, screen.availLeft, right - width),
    top: clamp(app.top, screen.availTop, bottom - height),
  };
}

/** The window.open features for `rect`: a popup (its own window, not a tab); no noopener, so the name finds it again. */
export function artifactWindowFeatures(rect: ArtifactWindowRect): string {
  return `popup,width=${rect.width},height=${rect.height},left=${rect.left},top=${rect.top}`;
}

export function artifactWindowName(id: ArtifactId | string): string {
  return `raft-artifact-${id}`;
}

type NavigatorLike = { userAgent?: string; maxTouchPoints?: number; userAgentData?: { mobile?: boolean } };

/**
 * Raft installed on a computer (not Raft Desktop): where Open in new page is a
 * window of its own. A phone or a tablet installed (iOS, iPadOS reporting a
 * Mac with touch, Android) is not: it keeps the plain new page.
 */
export function opensArtifactWindows(): boolean {
  if (typeof window === "undefined" || isElectronDesktopShell() || !isInstalledWebApp()) return false;
  const nav = window.navigator as NavigatorLike | undefined;
  if (!nav || nav.userAgentData?.mobile === true) return false;
  const userAgent = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android/i.test(userAgent)) return false;
  return !(/Macintosh|Mac OS X/i.test(userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

/** The label of an Open in new page action: "Open in new window" where it is one, else the surface's own (`inBrowser`). */
export function artifactOpenLabelId<T extends string>(inBrowser: T): T | "artifacts.card.openInNewWindow" {
  return opensArtifactWindows() ? "artifacts.card.openInNewWindow" : inBrowser;
}

function screenNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Opens Artifact `id`'s page (`url`, built from the id): its own window installed on a computer, else a new tab. */
export function openArtifactWindow(url: string, id: ArtifactId | string): void {
  if (!opensArtifactWindows()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const shown = shownWindow(artifactWindowName(id), url);
  if (shown) {
    shown.focus();
    return;
  }
  // availLeft/availTop: not in every browser's Screen type, there in Chromium and Firefox; on a second screen left of or above the main one they are negative.
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  const rect = artifactWindowRect(
    {
      availLeft: screenNumber(screen.availLeft, 0),
      availTop: screenNumber(screen.availTop, 0),
      availWidth: screenNumber(screen.availWidth, window.innerWidth),
      availHeight: screenNumber(screen.availHeight, window.innerHeight),
    },
    {
      left: screenNumber(window.screenX, 0),
      top: screenNumber(window.screenY, 0),
      width: screenNumber(window.outerWidth, window.innerWidth),
      height: screenNumber(window.outerHeight, window.innerHeight),
    },
  );
  const name = artifactWindowName(id);
  const opened = window.open(url, name, artifactWindowFeatures(rect));
  if (!opened) return;
  openWindows.set(name, opened);
  try {
    // The page can't reach back into the app's window: what noopener did, without losing the name.
    opened.opener = null;
  } catch {
    // A window the browser won't let us touch keeps whatever opener it has.
  }
}

/** The window named `name` if it is still open on `url`: then reopening only focuses it (no reload). */
function shownWindow(name: string, url: string): Window | null {
  for (const [key, shown] of openWindows) {
    if (shown.closed) openWindows.delete(key);
  }
  const shown = openWindows.get(name);
  if (!shown) return null;
  try {
    // Same origin, so its address is readable; a window that navigated elsewhere throws or differs.
    return shown.location.href === url ? shown : null;
  } catch {
    return null;
  }
}

export function resetArtifactWindowsForTests(): void {
  openWindows.clear();
}
