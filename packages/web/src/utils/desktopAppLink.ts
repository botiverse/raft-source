import { isDesktopDeepLinkPathname } from "@botiverse/raft-shared";
import { isHostShell } from "../embed";
import { detectDesktopOs } from "./desktopDownload";
import { isElectronDesktopShell } from "./desktopShell";
import { isEmbeddedBrowserUserAgent } from "./embeddedBrowser";

/**
 * "Open in Raft Desktop" from a desktop browser (deep links v1, the banner in
 * DesktopAppLinkBanner).
 *
 * Raft Desktop registers the raft:// scheme and routes `raft://<app path>` into
 * its own router, the same routes the web app has (the shell accepts "/" and
 * the shared DESKTOP_DEEP_LINK_ROUTE_PREFIXES, "/servers", "/s/…" and
 * "/artifacts/…"; its notifications open the same routes). So the link for
 * this page is this page's path and query behind `raft://`: a channel, a DM,
 * a thread, a message link or an Artifact opens at the same place. A path the desktop app would refuse
 * (a sign-in or utility page) opens the app at its start instead.
 *
 * Nothing is detected: if no app handles the scheme, the person stays where
 * they are. Chrome and Edge do nothing; Safari says the address is invalid,
 * which is why the page never launches it on its own, only on a click.
 */
export function desktopAppDeepLink(location: { pathname: string; search: string }): string {
  const { pathname, search } = location;
  return isDesktopDeepLinkPathname(pathname) ? `raft://${pathname}${search}` : "raft:///";
}

type NavigatorLike = Parameters<typeof detectDesktopOs>[0];

/** A browser on a computer: not a phone or tablet, not Raft Desktop itself, not a native or chat app's WebView. */
export function canOpenInDesktopApp(
  nav: NavigatorLike = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (isElectronDesktopShell() || isHostShell()) return false;
  // The desktop builds of WeChat, Feishu and DingTalk block custom schemes.
  if (isEmbeddedBrowserUserAgent(nav?.userAgent)) return false;
  return detectDesktopOs(nav) !== null;
}

/** Hands the link to the OS. A top-level navigation, not an iframe: Chrome and Edge ask once, then open the app. */
export function openInDesktopApp(url: string): void {
  window.location.href = url;
}

/**
 * How long the banner says "Opening Raft Desktop…" after the click when
 * nothing else ends it. The page cannot tell what the click did: with no app
 * nothing happens, and a browser window merely behind the app still counts as
 * visible. 30 s covers answering the browser's own "Open Raft Desktop?"
 * prompt and a cold start of the app, and gives someone without it time to
 * see that nothing came and read the download line; after that "Opening…" is
 * no longer true either way.
 */
export const DESKTOP_APP_OPENING_MS = 30_000;
