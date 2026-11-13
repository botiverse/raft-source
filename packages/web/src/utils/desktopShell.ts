// True only inside the Raft Desktop (electron) shell, which the desktop preload
// marks with a `raftDesktop` global. Used for desktop-aware defaults in shared
// web code (kept free of app imports so stores can use it without cycles).

import { getDesktopBridge } from "./desktopBridge";

export function isElectronDesktopShell(): boolean {
  return typeof window !== "undefined" && getDesktopBridge()?.isDesktop === true;
}

// The frontend origin compiled into the desktop build. The Electron frontend
// vite config injects VITE_FRONTEND_URL (e.g. https://app.raft.build) the same
// way it already injects VITE_API_URL for the API origin. Empty on the Web
// build (which never needs it — see below).
const compiledFrontendOrigin =
  typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_FRONTEND_URL === "string"
    ? import.meta.env.VITE_FRONTEND_URL.replace(/\/+$/, "")
    : "";

/**
 * Origin for building human-shareable links (invite / join links, public share
 * URLs, QR codes).
 *
 * In the desktop shell the page origin is the `app://raft` custom protocol,
 * which cannot be opened in a browser — a join link built from
 * `window.location.origin` there is unusable (this was the actual bug). So on
 * desktop we use the frontend origin compiled into the build (VITE_FRONTEND_URL),
 * mirroring how the API origin comes from VITE_API_URL. On the Web app there is
 * no desktop shell, so the page origin IS the shareable origin and is returned
 * unchanged.
 *
 * Params are injectable for tests (host shape -> caller output); defaults wire
 * the real host: the Electron `raftDesktop` global, the page origin, and the
 * build-time frontend origin.
 */
export function shareableWebOrigin(
  desktop: boolean = isElectronDesktopShell(),
  pageOrigin: string = (typeof window !== "undefined" && window.location?.origin) || "",
  compiledOrigin: string = compiledFrontendOrigin,
): string {
  if (desktop && compiledOrigin) return compiledOrigin;
  return pageOrigin;
}

/**
 * The current page as a browser-openable URL: shareableWebOrigin() plus this
 * page's path, query and hash. For URLs handed to the server or a third party
 * that a browser will later open (Stripe checkout success/cancel and portal
 * return URLs, copy-this-page links). On desktop the page URL is app://raft/...,
 * which no browser can open and the server's redirect check rejects
 * ("Invalid redirect URL" on Upgrade to Pro); the same path on the frontend
 * origin is the web page the user lands on. On the Web it is the page URL.
 */
export function shareableWebUrl(
  desktop: boolean = isElectronDesktopShell(),
  pageHref: string = (typeof window !== "undefined" && window.location?.href) || "",
  compiledOrigin: string = compiledFrontendOrigin,
): string {
  if (!pageHref) return pageHref;
  const page = new URL(pageHref);
  const origin = shareableWebOrigin(desktop, page.origin, compiledOrigin);
  return origin === page.origin ? pageHref : `${origin}${page.pathname}${page.search}${page.hash}`;
}
