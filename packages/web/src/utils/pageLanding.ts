/**
 * Deep links v1: the address this page was first loaded on, when that load was
 * a *landing*: opened from a link or typed, not a reload, not Back/Forward
 * into the page, not Raft Desktop reopening it after an update restart. The
 * open-in-app offers (DesktopAppLinkBanner, OpenInAppOffer) are about this
 * address, whatever kind of page it is; messageLinkLanding.ts keeps its own,
 * narrower record for the message-link states on top of the same first load.
 *
 * A landing counts once. It lasts while the app shows that page, and is spent
 * when the app moves on from it, so coming back to the same address later
 * (History, the sidebar) is an address the app wrote itself. The one move
 * that keeps it is the app's own redirect of the landed address
 * (`/s/<slug>` to its first channel): the person went nowhere.
 */
import { getDesktopBridge } from "./desktopBridge";

export interface PageLanding {
  pathname: string;
  search: string;
  /** Opened from outside Raft: no referrer, or one from another origin. */
  fromOutside: boolean;
}

interface LiveLanding {
  landing: PageLanding;
  /** Where it is on screen: its own pathname, or the page the app redirected it to. */
  at: string;
  /** The landed pathname while that redirect is on its way. */
  movedFrom: string | null;
  /** The app has shown it. Detours before that (a sign-in page that draws no offer, joining a public server) don't spend it. */
  shown: boolean;
  /**
   * The person answered the offer about it (used it or put it away). The
   * sign-in page and the workspace behind it each draw the offer for the
   * same landing; answered on the first, it isn't made again on the second.
   */
  offerAnswered: boolean;
}

let live: LiveLanding | null = null;
let captured = false;
const listeners = new Set<() => void>();

function setLive(next: LiveLanding | null): void {
  live = next;
  for (const listener of listeners) listener();
}

function navigationType(): string | null {
  try {
    const [entry] = globalThis.performance?.getEntriesByType?.("navigation") ?? [];
    return (entry as PerformanceNavigationTiming | undefined)?.type ?? null;
  } catch {
    return null;
  }
}

/** No referrer, or one from another origin. */
export function isReferrerOutside(referrer: string, origin: string): boolean {
  if (!referrer) return true;
  try {
    return new URL(referrer).origin !== origin;
  } catch {
    return true;
  }
}

/** This load's address and where it came from; null for a reload or Back/Forward (the person is already here). */
export function readFirstLoad(): PageLanding | null {
  const type = navigationType();
  if (type === "reload" || type === "back_forward") return null;
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    fromOutside: isReferrerOutside(globalThis.document?.referrer ?? "", window.location.origin),
  };
}

/** The page Raft Desktop reopened after an update restart (resumeRouteArg.ts), or null. */
export function desktopResumedLocation(): URL | null {
  const route = getDesktopBridge()?.launch?.resumedRoute;
  if (!route) return null;
  try {
    return new URL(route, window.location.origin);
  } catch {
    return null;
  }
}

/** Called once at boot with the first load (captureMessageLinkLanding, main.tsx), before the router can touch the URL. */
export function capturePageLanding(first: PageLanding | null): void {
  if (captured || typeof window === "undefined") return;
  captured = true;
  if (!first || desktopResumedLocation()?.pathname === first.pathname) return;
  setLive({ landing: first, at: first.pathname, movedFrom: null, shown: false, offerAnswered: false });
}

/**
 * The app is showing this pathname (the offers' strip, on every location
 * change). A landing shown earlier that this is not is spent.
 */
export function notePageLocation(pathname: string): void {
  if (!live) return;
  if (pathname === live.at) {
    live.shown = true;
    live.movedFrom = null;
    return;
  }
  if (pathname === live.movedFrom || !live.shown) return;
  setLive(null);
}

/** The app redirects the landed address itself (`/s/<slug>` to its first channel): the landing goes with it, once. */
export function movePageLanding(from: string, to: string): void {
  if (!live || live.landing.pathname !== from || live.at !== from) return;
  live.at = to;
  live.movedFrom = from;
}

/** The landed address turned out to show nothing (a message link that can't be shown): no offer about it. */
export function spendPageLanding(): void {
  if (live) setLive(null);
}

/**
 * The landing, while `pathname` is where the app shows it; else null. While a
 * redirect is on its way both ends are that place, so the offer doesn't blink.
 */
export function pageLandingAt(pathname: string): PageLanding | null {
  return live && (pathname === live.at || pathname === live.movedFrom) ? live.landing : null;
}

/** The person used or put away the open-in-app offer about the landing. */
export function answerPageLandingOffer(): void {
  if (live) live.offerAnswered = true;
}

/** Read when an offer mounts: one already answered for this landing (on the sign-in page) isn't made again. */
export function isPageLandingOfferAnswered(): boolean {
  return live?.offerAnswered === true;
}

export function subscribePageLanding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPageLandingForTests(landing?: { pathname: string; search: string; referrer?: string; origin?: string }): void {
  captured = landing !== undefined;
  setLive(landing ? {
    landing: {
      pathname: landing.pathname,
      search: landing.search,
      fromOutside: isReferrerOutside(landing.referrer ?? "", landing.origin ?? window.location.origin),
    },
    at: landing.pathname,
    movedFrom: null,
    shown: false,
    offerAnswered: false,
  } : null);
}
