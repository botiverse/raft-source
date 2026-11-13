// Page <-> service worker messages about notifications (public/sw.js), kept
// free of stores so tests and the worker's own test harness can load them.

import { getPwaInstallDisplayMode } from "../utils/pwaInstall";

export const PUSH_NOTIFICATION_NAVIGATE_MESSAGE = "RAFT_PUSH_NOTIFICATION_NAVIGATE";
export const CLIENT_DISPLAY_MODE_MESSAGE = "RAFT_CLIENT_DISPLAY_MODE";

export function serviceWorkerNavigationPath(input: unknown, origin = window.location.origin): string | null {
  if (!input || typeof input !== "object") return null;
  const data = input as { type?: unknown; url?: unknown };
  if (data.type !== PUSH_NOTIFICATION_NAVIGATE_MESSAGE || typeof data.url !== "string") return null;

  try {
    const url = new URL(data.url, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** What this window tells the service worker about how it is displayed. */
export function clientDisplayModeMessage(win: Window): { type: string; standalone: boolean } {
  return { type: CLIENT_DISPLAY_MODE_MESSAGE, standalone: getPwaInstallDisplayMode(win) === "standalone" };
}
