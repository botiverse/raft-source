import type { Locale } from "./locale";

/**
 * Tell the service worker the display locale (public/sw.js
 * raft:display-locale): it keeps that locale's catalog chunks with the HTML it
 * keeps for offline opens, and en under a partial locale. Every catalog is a
 * lazy chunk the HTML does not name, so the worker cannot tell on its own.
 * At boot and after a language switch; nothing without a worker.
 */
export function tellServiceWorkerLocale(locale: Locale): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: "raft:display-locale", locale }))
    .catch(() => {});
}
