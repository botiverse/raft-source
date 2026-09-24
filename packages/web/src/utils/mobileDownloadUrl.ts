import { RUNTIME_API_BASE } from "../desktopRuntimeEnvironment";

/**
 * Absolute URL for the mobile download entry point.
 *
 * **The API is not on the web app's origin in any deployed environment.** The
 * client composes every request as `${apiOrigin}/api/...`; only local dev has a
 * Vite proxy that makes a bare `/api/...` work. Hardcoding the relative path
 * shipped a link that resolved against the WEB origin, found no API there, fell
 * through to the SPA catch-all, and bounced the person back to the settings page
 * they started on — reported by @wenyi on staging, and no error appeared
 * anywhere.
 *
 * `apiBase` is injectable **so that tests drive this exact function** rather
 * than a lookalike. An earlier version of this file kept a second `compose…`
 * helper for tests to call; @Aiden pointed out that mutating the production path
 * back to a relative string would then leave the suite green, because the tests
 * were exercising the copy. One implementation, parameterised — the default is
 * the only thing production supplies.
 */
export function mobileDownloadUrl(
  platform?: "android" | "ios",
  apiBase: string = RUNTIME_API_BASE,
): string {
  const base = `${apiBase.replace(/\/$/, "")}/mobile-download`;
  return platform ? `${base}?platform=${platform}` : base;
}

/**
 * Public chooser path on the WEB origin.
 *
 * This is what the QR encodes. It must be a web-origin URL: App Links and
 * Universal Links only fire for hosts that publish the association files, which
 * are served from this origin — an API-origin QR can never open the app.
 */
export const MOBILE_DOWNLOAD_CHOOSER_PATH = "/download";
