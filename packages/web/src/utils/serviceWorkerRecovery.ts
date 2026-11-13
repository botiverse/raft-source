import { mayUseServiceWorker } from "./offlineBundleHost";

export interface ServiceWorkerRecoveryResult {
  /** Registrations found on this browser profile before the refresh. */
  serviceWorkerCount: number;
  failureCount: number;
}

/**
 * The service-worker step of "clear cache and reload": refresh this origin's
 * existing registrations and make sure `/sw.js` is registered.
 *
 * A page loaded from an offline bundle (or one whose bundle start failed) does
 * nothing here: the host owns its files, so recovery must not put a worker
 * back over the bundle.
 */
export async function refreshServiceWorkerForRecovery(): Promise<ServiceWorkerRecoveryResult> {
  if (!("serviceWorker" in navigator) || !mayUseServiceWorker()) {
    return { serviceWorkerCount: 0, failureCount: 0 };
  }
  let failureCount = 0;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all([
    ...registrations
      .filter((registration) => {
        try {
          return new URL(registration.scope).origin === window.location.origin;
        } catch {
          return false;
        }
      })
      .map((registration) => registration.update().catch(() => { failureCount += 1; })),
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => { failureCount += 1; }),
  ]);
  return { serviceWorkerCount: registrations.length, failureCount };
}

export interface BrowserRecoveryCleanupResult extends ServiceWorkerRecoveryResult {
  assetCacheCount: number;
}

/**
 * Everything "clear cache and reload" removes or refreshes in this browser
 * profile: the service worker step above, the `slock-assets-*` caches and the
 * kept HTML (`slock-shell-*`).
 *
 * Outside ordinary-page mode it does nothing at all. An offline-bundle page may
 * share this origin's storage with the ordinary web app, so its recovery must
 * not delete that app's caches either; restoring bundle files is the host's job.
 */
export async function cleanBrowserStateForRecovery(): Promise<BrowserRecoveryCleanupResult> {
  if (!mayUseServiceWorker()) return { serviceWorkerCount: 0, assetCacheCount: 0, failureCount: 0 };
  let failureCount = 0;
  let assetCacheCount = 0;
  const cleanup: Array<Promise<unknown>> = [];
  let serviceWorkerCount = 0;
  cleanup.push(
    refreshServiceWorkerForRecovery().then((result) => {
      serviceWorkerCount = result.serviceWorkerCount;
      failureCount += result.failureCount;
    }),
  );
  if ("caches" in window) {
    // The kept HTML (slock-shell-*) goes too: it names the assets being cleared.
    const assetCacheKeys = (await window.caches.keys()).filter((key) => key.startsWith("slock-assets-") || key.startsWith("slock-shell-"));
    assetCacheCount = assetCacheKeys.length;
    cleanup.push(
      ...assetCacheKeys.map((key) => window.caches.delete(key).catch(() => { failureCount += 1; return false; })),
    );
  }
  await Promise.all(cleanup);
  return { serviceWorkerCount, assetCacheCount, failureCount };
}

/**
 * Forgets the HTML the service worker keeps (`/` in `slock-shell-*`, sw.js), as
 * an urgent release does, so the next open is answered by the network: a
 * reload onto a newer release would otherwise open the kept, older one again
 * (docs/frontend/boot-shell.md, "One open behind"). The asset cache and the
 * kept display locale stay. Nothing outside ordinary-page mode.
 */
export async function dropKeptShell(): Promise<void> {
  if (!mayUseServiceWorker() || !("caches" in window)) return;
  const keys = (await window.caches.keys()).filter((key) => key.startsWith("slock-shell-"));
  await Promise.all(keys.map(async (key) => (await window.caches.open(key)).delete("/")));
}
