import { isHostShell } from "../embed";
import { isInstalledWebApp } from "./clientPlatformHint";
import { isElectronDesktopShell } from "./desktopShell";
import { detectDesktopOs } from "./desktopDownload";
import { isEmbeddedBrowserUserAgent } from "./embeddedBrowser";

/**
 * Deep links v1, frame b: a phone browser hands a message link to the Raft
 * app through a second host, because iOS never opens an app for a link to the
 * site the person is already on (a Universal Link has to cross domains), and
 * Android's App Links treat a tap the same way. Both apps claim the same paths
 * on both hosts (mobile #3680), so the open link is this page's address with
 * only the host changed.
 *
 * When no app takes the link, the open host answers with a 302 back to the
 * same path here, with `app=missing` added (a Cloudflare redirect rule on the
 * open host, docs/frontend/message-deep-links.md); the page then offers the
 * download. Only hosts listed here have an open host: anywhere else (staging,
 * local) the bar doesn't show.
 */
const OPEN_IN_APP_HOSTS: Readonly<Record<string, string>> = {
  "app.raft.build": "open.raft.build",
};

export const APP_MISSING_PARAM = "app";
export const APP_MISSING_VALUE = "missing";

export function openInAppHost(webHost: string): string | null {
  return OPEN_IN_APP_HOSTS[webHost] ?? null;
}

/** This address with `app=missing` taken out; the rest of the query keeps its order. */
export function withoutAppMissingMarker(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get(APP_MISSING_PARAM) !== APP_MISSING_VALUE) return search;
  params.delete(APP_MISSING_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function hasAppMissingMarker(search: string): boolean {
  return new URLSearchParams(search).get(APP_MISSING_PARAM) === APP_MISSING_VALUE;
}

/** The same path and query on the open host, or null where there is none. */
export function openInAppUrl(pathname: string, search: string, webHost: string): string | null {
  const host = openInAppHost(webHost);
  if (!host) return null;
  return `https://${host}${pathname}${withoutAppMissingMarker(search)}`;
}

type NavigatorLike = { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined;

/**
 * A phone's own browser (Safari, Chrome, ...): not a computer, not a chat
 * app's in-app browser (frame a covers those), not Raft's host shell, Raft
 * Desktop or the web installed as an app.
 */
export function isPhoneBrowser(
  nav: NavigatorLike = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (typeof window === "undefined" || !nav) return false;
  if (isHostShell() || isElectronDesktopShell() || isInstalledWebApp()) return false;
  if (detectDesktopOs(nav as Parameters<typeof detectDesktopOs>[0]) !== null) return false;
  const userAgent = nav.userAgent ?? "";
  if (isEmbeddedBrowserUserAgent(userAgent)) return false;
  return /iPhone|iPod|Android/i.test(userAgent);
}

export function isIosUserAgent(userAgent: string): boolean {
  return /iPhone|iPad|iPod/i.test(userAgent);
}
