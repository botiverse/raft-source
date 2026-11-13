/**
 * slock.web.shell_keep_failed — the service worker could not keep the HTML of
 * the release the network sent (public/sw.js keepShell; #triage:#165). While
 * that failed silently, a browser kept opening the release it had kept before,
 * for up to a week. The worker now drops that copy and tells the page, which
 * reports it here.
 *
 * Fields (closed sets, no URL or file name):
 *   step            asset_fetch | asset_response | asset_store | catalogs | shell_store | unknown
 *   served_kept     the page itself was opened from the kept copy (which the worker then dropped)
 *   browser_family  coarse UA bucket (shared with the auth boot trace)
 *   harmonyos       a HarmonyOS or Huawei browser (its UA also reads as Chrome)
 */
import { authBootBrowserBucketFromUserAgent, emitWebEvent } from "./webAuthTrace";

const SHELL_KEEP_FAILED = "slock.web.shell_keep_failed" as const;
const STEPS: ReadonlySet<string> = new Set(["asset_fetch", "asset_response", "asset_store", "catalogs", "shell_store"]);

type Emitter = typeof emitWebEvent;
let emitter: Emitter = emitWebEvent;

/** Test seam. */
export function __setShellKeepFailedEmitterForTest(next: Emitter | null): void {
  emitter = next ?? emitWebEvent;
}

/** The worker's "raft:shell-keep-failed" message. Never throws. */
export function reportShellKeepFailed(message: unknown, userAgent: string | null = typeof navigator === "undefined" ? null : navigator.userAgent): void {
  try {
    const data = (message ?? {}) as { step?: unknown; servedKept?: unknown };
    emitter(SHELL_KEEP_FAILED, {
      step: typeof data.step === "string" && STEPS.has(data.step) ? data.step : "unknown",
      served_kept: data.servedKept === true,
      browser_family: authBootBrowserBucketFromUserAgent(userAgent),
      harmonyos: /\b(openharmony|harmonyos|arkweb|huaweibrowser)\b/i.test(userAgent ?? ""),
    });
  } catch {
    // Reporting must never affect the page.
  }
}
