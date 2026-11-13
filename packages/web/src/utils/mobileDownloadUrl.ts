import { RUNTIME_API_BASE } from "../runtimeEndpoints";
import { isIosUserAgent } from "./openInAppLink";
import { shareableWebOrigin } from "./desktopShell";

/**
 * What the entry point can resolve: `ios` is the App Store listing, `ios-beta`
 * the TestFlight beta. The UI no longer links `ios-beta`; it stays because old
 * QR codes and links still use it. Both are Apple-side URLs the server owns,
 * so they can change without a web deploy.
 */
export type MobileDownloadPlatform = "android" | "ios" | "ios-beta";

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
  platform?: MobileDownloadPlatform,
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

/**
 * What the QR code encodes: the absolute /download on the WEB origin.
 *
 * Absolute, because the phone scanning it is not on our origin: a relative
 * path encodes to something the camera app cannot open. The WEB origin, not
 * the API base the download links use (the API is on another host in every
 * deployed environment), so the two are deliberately different and neither
 * should be "made consistent" with the other: App Links and Universal Links
 * only fire for hosts that serve the association files, and those live on the
 * web origin, so a QR pointing at the API origin could never open the app
 * (@Mahua). /download is public and does the platform split, so nothing is
 * lost for someone without the app. No `platform` in it: the phone scanning
 * it is not this device, so one code serves both platforms.
 */
export function mobileDownloadQrUrl(): string {
  return `${typeof window === "undefined" ? "" : shareableWebOrigin()}${MOBILE_DOWNLOAD_CHOOSER_PATH}`;
}

/**
 * The Android app's Google Play listing (artin, #triage:#96). The APK download
 * stays next to it for phones without Google Play (Huawei, most phones sold
 * in China).
 */
export const GOOGLE_PLAY_URL = "https://play.google.com/store/apps/details?id=build.raft.app";

type PhoneNavigator = {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string };
};

/**
 * Whether this browser is an iPad reporting itself as a Mac.
 *
 * `maxTouchPoints` is the documented discriminator: desktop Safari on real
 * macOS reports 0, iPadOS reports 5 while claiming `Macintosh`. Read at render
 * rather than module scope so tests can drive it, and guarded because a
 * non-browser render (SSR, jsdom without the field) must not throw.
 */
export function isTouchCapableMac(nav: PhoneNavigator | undefined): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? "";
  // `Macintosh`, not `Mac OS X`: an iPhone's UA says "like Mac OS X" and has
  // touch points too, so every iPhone was taken for an iPad.
  return /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** The phone or tablet this browser runs on, if it is one Raft has an app for. */
export type PhoneDevice = "iphone" | "ipad" | "android";

/**
 * Which phone app THIS device takes, or null for a computer or a device the
 * page can't tell (a Chromebook). An iPad says Macintosh and has a touch
 * screen; an iPhone never says Macintosh. Chrome on a large Android tablet can
 * send a desktop Linux UA, but its client hints still say Android.
 */
export function detectPhoneDevice(nav: PhoneNavigator | undefined): PhoneDevice | null {
  if (!nav) return null;
  const ua = nav.userAgent ?? "";
  if (isTouchCapableMac(nav) || /iPad/i.test(ua)) return "ipad";
  if (isIosUserAgent(ua)) return "iphone";
  if (/Android/i.test(ua) || /^android$/i.test(nav.userAgentData?.platform ?? "")) return "android";
  return null;
}
