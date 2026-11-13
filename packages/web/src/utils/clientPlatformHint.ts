// What this web client says about itself to the server (xxchan, 2026-10-22,
// task #13): the desktop app, the web installed as an app, or a browser tab.
// Sent as X-Raft-Client-Platform on API requests, so a signup's
// account_created records where the account came from; the server tells a
// phone's browser from a computer's by the User-Agent. With it goes this web
// build's version, which the server records on each request's trace (task #15
// in #proj-analytics). The desktop app bundles its own build, stamped with the
// desktop release's version, so there it is the desktop app's version.

import { RAFT_CLIENT_VERSION_HEADER } from "@botiverse/raft-shared";
import { isElectronDesktopShell } from "./desktopShell";
import { WEB_APP_VERSION } from "./webAppVersion";

export type ClientPlatformHint = "desktop_app" | "pwa" | "browser";

export function isInstalledWebApp(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as (Navigator & { standalone?: boolean }) | undefined;
  if (nav?.standalone === true) return true;
  // An installed window under the Window Controls Overlay (manifest display_override)
  // reports that display mode instead of standalone.
  return window.matchMedia?.("(display-mode: standalone)").matches === true
    || window.matchMedia?.("(display-mode: window-controls-overlay)").matches === true;
}

export function clientPlatformHint(): ClientPlatformHint {
  if (isElectronDesktopShell()) return "desktop_app";
  return isInstalledWebApp() ? "pwa" : "browser";
}

/** The headers naming this client on an API request: its platform and this web build's version. */
export function clientRequestHeaders(): Record<string, string> {
  return { "X-Raft-Client-Platform": clientPlatformHint(), [RAFT_CLIENT_VERSION_HEADER]: WEB_APP_VERSION };
}
