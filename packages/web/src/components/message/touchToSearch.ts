import { getPwaInstallPlatform } from "../../utils/pwaInstall";

export interface TouchToSearchNavigator {
  userAgent?: string;
  maxTouchPoints?: number;
}

/**
 * Whether this browser can raise Chrome's Touch to Search (Contextual Search)
 * bar for a text selection: Chrome on Android. Other Chromium browsers on
 * Android (Samsung Internet, Edge) count too, on purpose: a stray no-op Paste
 * costs less than the bar covering the sheet's footer. Android System WebView
 * (`; wv)`, the Raft app) has no Touch to Search. Every iOS browser is WebKit
 * (Chrome on iPhone and iPad included) and has none; neither do desktop
 * browsers.
 *
 * Android Chrome's "Desktop site" sends a Linux desktop UA (`X11; Linux`)
 * with no "Android"; a touch screen tells it apart. A Linux touchscreen
 * laptop's Chrome matches too (accepted: it only gains a no-op Paste).
 *
 * The Android / Chromium / iOS split is getPwaInstallPlatform's; its tests
 * pin it, and this one's (messageSelectTextSheet) pin what this needs of it.
 */
export function hasTouchToSearch(nav: TouchToSearchNavigator | undefined): boolean {
  const userAgent = nav?.userAgent ?? "";
  const platform = getPwaInstallPlatform(userAgent);
  if (platform === "android_chromium") return !/; wv\)/.test(userAgent);
  return platform === "desktop_chromium" && /x11; linux/i.test(userAgent) && (nav?.maxTouchPoints ?? 0) > 0;
}
