import { currentTimeMs } from "@botiverse/raft-shared";
import { reportShellKeepFailed } from "./shellKeepFailedTrace";
import {
  checkReleaseAfterChunkFailure,
  isDynamicImportFailure,
  isLocallyHandledImportPending,
  registerChunkFailureShownInPlace,
  registerStaleReleaseReload,
} from "./dynamicImportRecovery";
import {
  reportUpdateGateDecision,
  reportUpdateGateDecisionBeforeUnload,
} from "./updateGateTrace";
import type { UpdateGateTriggerSource } from "./updateGateTrace";
import { cleanBrowserStateForRecovery } from "./serviceWorkerRecovery";

// This page may have opened from the HTML the service worker keeps (sw.js),
// and the worker says what the network's HTML turned out to be:
// - a release that must take effect at once: a page still in its first
//   seconds reloads onto it; a later one runs on, the next open takes it;
// - a newer release, now kept: this page's files loaded on demand may be gone
//   from the server, so a failed one reloads onto the kept release instead of
//   asking (vite:preloadError below).
const SHELL_URGENT_RELOAD_WINDOW_MS = 10_000;
// Past this the page may hold work in progress: a failed chunk asks first, as before.
const SHELL_SUPERSEDED_RELOAD_WINDOW_MS = 120_000;
let shellSuperseded = false;
let reloading = false;
let reloadPage = () => window.location.reload();
function reloadOntoKeptRelease(): boolean {
  if (reloading) return true;
  if (!shellSuperseded || performance.now() >= SHELL_SUPERSEDED_RELOAD_WINDOW_MS) return false;
  reloading = true;
  reloadPage();
  return true;
}

export const APP_REFRESH_REQUIRED_EVENT = "raft:app-refresh-required";
export const APP_UPDATE_AVAILABLE_EVENT = "raft:app-update-available";
/** What this page learned so far; RootErrorBoundary reads it when it mounts and as it reports. */
export const appUpdateState: {
  refreshRequired: boolean;
  updateAvailable: boolean;
  /** A chunk failed (set at once, before the release check answers): a later superseded message reloads. */
  chunkFailed: boolean;
  /** The strip was put away: later failures don't ask the server again. */
  stripDismissed: boolean;
  triggerSource: UpdateGateTriggerSource;
} = { refreshRequired: false, updateAvailable: false, chunkFailed: false, stripDismissed: false, triggerSource: "error_boundary" };

/**
 * A chunk failed while the app runs (`vite:preloadError`): nothing on screen
 * broke yet (whatever imported it gets the rejection and shows its own
 * failure, or RootErrorBoundary catches it). Only when the server confirms
 * this page's release is gone, or can't be asked, does the app say so, and
 * then with the dismissible strip over the running app: the page may hold
 * unsent text (a comment typed by voice on a phone that suspended the request).
 */
function noteChunkFailure(error: unknown): void {
  if (!isDynamicImportFailure(error)) return;
  appUpdateState.chunkFailed = true;
  if (reloadOntoKeptRelease()) return;
  if (appUpdateState.stripDismissed) return;
  void checkReleaseAfterChunkFailure(error).then((release) => {
    // The server still has this release: a blip, nothing to refresh onto.
    if (release === "current") return;
    // The worker said a newer release is kept while the check waited.
    if (reloadOntoKeptRelease()) return;
    reportUpdateGateDecision({
      action: "detected",
      reason: "dynamic_import_failure",
      triggerSource: "vite_preload_error",
    });
    if (!appUpdateState.refreshRequired) appUpdateState.triggerSource = "vite_preload_error";
    appUpdateState.updateAvailable = true;
    window.dispatchEvent(new window.CustomEvent(APP_UPDATE_AVAILABLE_EVENT));
  }).catch((checkError: unknown) => {
    console.warn("[appUpdateGate] release check failed", checkError);
  });
}

/** main.tsx, before the first render: the service worker's release messages and the chunk-failure handler. */
export function installAppUpdateGate(): void {
  // A deferred dialog or panel's own Try again takes the same way out (boot/lazyChunk).
  registerStaleReleaseReload(reloadOntoKeptRelease);
  // ...and a failure it shows in place still asks whether this release is gone.
  registerChunkFailureShownInPlace(noteChunkFailure);
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === "raft:shell-superseded") {
        shellSuperseded = true;
        // A chunk already failed before the worker could say so.
        if (appUpdateState.refreshRequired || appUpdateState.chunkFailed) reloadOntoKeptRelease();
      }
      if (type === "raft:shell-urgent" && performance.now() < SHELL_URGENT_RELOAD_WINDOW_MS) window.location.reload();
      // The worker couldn't keep the network's release (and dropped its older copy if it served this page from it).
      if (type === "raft:shell-keep-failed") reportShellKeepFailed(event.data);
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("vite:preloadError", (event) => {
      // An import whose caller shows its own failure (importHandledLocally):
      // no app-wide notice; the import still rejects into that caller.
      if (isLocallyHandledImportPending()) return;
      noteChunkFailure((event as Event & { payload?: unknown }).payload ?? event);
      // Do not cancel this event. Vite treats a canceled preload error as
      // handled and resolves the failed import to undefined. React.lazy then
      // masks the useful chunk error with "reading 'default'" instead of
      // letting the root boundary show the refresh recovery screen.
    });
  }
}

/** Tests: forget what an earlier test's page learned. */
export function __resetAppUpdateGateForTest(reload: () => void = () => window.location.reload()): void {
  shellSuperseded = false;
  reloading = false;
  reloadPage = reload;
  appUpdateState.refreshRequired = false;
  appUpdateState.updateAvailable = false;
  appUpdateState.chunkFailed = false;
  appUpdateState.stripDismissed = false;
  appUpdateState.triggerSource = "error_boundary";
}

export async function clearAssetCacheAndReload() {
  reportUpdateGateDecision({
    action: "recovery_started",
    reason: "user_recover",
    triggerSource: appUpdateState.triggerSource,
  });
  let cleanupFailureCount = 0;
  let serviceWorkerCount = 0;
  let assetCacheCount = 0;
  try {
    // Does nothing when the page was loaded from an offline bundle; see cleanBrowserStateForRecovery.
    const result = await cleanBrowserStateForRecovery();
    serviceWorkerCount = result.serviceWorkerCount;
    assetCacheCount = result.assetCacheCount;
    cleanupFailureCount += result.failureCount;
  } catch (error) {
    cleanupFailureCount += 1;
    console.warn("[RootErrorBoundary] app refresh cache cleanup failed", error);
  } finally {
    await reportUpdateGateDecisionBeforeUnload({
      action: "recovery_finished",
      reason: cleanupFailureCount === 0 ? "cleanup_completed" : "cleanup_partial_failure",
      triggerSource: appUpdateState.triggerSource,
      cleanupFailureCount,
      serviceWorkerCount,
      assetCacheCount,
    });
    const url = new URL(window.location.href);
    url.searchParams.set("raft_recover", String(currentTimeMs()));
    window.location.replace(url.toString());
  }
}

/** A render crash from a chunk that didn't load: the app can't render, so the full refresh screen. */
export function requestAppRefreshPrompt(error: unknown, triggerSource: UpdateGateTriggerSource): boolean {
  try {
    if (typeof window !== "undefined" && isDynamicImportFailure(error)) {
      if (reloadOntoKeptRelease()) return true;
      reportUpdateGateDecision({
        action: "detected",
        reason: "dynamic_import_failure",
        triggerSource,
      });
      appUpdateState.triggerSource = triggerSource;
      appUpdateState.refreshRequired = true;
      window.dispatchEvent(new window.CustomEvent(APP_REFRESH_REQUIRED_EVENT));
      return true;
    }
  } catch (promptError) {
    console.warn("[RootErrorBoundary] app refresh prompt guard failed", promptError);
  }
  return false;
}
