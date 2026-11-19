// A click on a link that gets the Raft app (cindyz, 2026-11-13, user source
// work, #proj-analytics:72b5e0e2): Raft Desktop's installer, a mobile app's
// store listing or the Android APK, from Settings › About, the "open in Raft
// Desktop" banner, a phone's "app not installed" sheet and /download.
// Called from the link's own click handler and never awaited: the event is
// queued (analytics/track.ts) and the link goes on as it would without it.
//
// Each call site says how its link opens (AppDownloadLinkOpens), because that
// decides when the event may be sent:
//   new_tab   a store listing, the phone sheet's button (`target="_blank"`).
//             The new tab hides this one, and the sender's flush on hide
//             empties the queue without asking a server it has not asked yet
//             whether the person shares usage data: a click made before the
//             tab's first batch (the phone sheet shows right after the page
//             loads) would be dropped. So the click starts a flush of its
//             own, which asks first. This page is not navigated, so its
//             requests are not cut off.
//   same_tab  an installer or the APK: a file download that starts a
//             navigation of this page. Nothing is sent at the click: a
//             browser may abort requests in flight when a navigation starts,
//             and a failed sharing check is taken as "does not share" for the
//             rest of the page's life (track.ts: askAllowed answers false,
//             and the flush keeps that), which would drop every later
//             product event of the tab. The page stays, so the event goes
//             with the ordinary delayed batch.
//
// Who is counted: trackEvent sends for the server the tab is in, after that
// server's sharing check. Signed out there is none, so nothing is sent. On
// /download (a public page that loads no server) normally nothing is sent
// either; the one exception is a document that had a workspace loaded and
// came to /download without a reload (Back / Forward), whose server is still
// the tab's. A scan of the QR code is not a click and is not counted.
import type { ProductEventProperties } from "@botiverse/raft-shared";
import type { DesktopTarget } from "../utils/desktopDownload";
import { desktopTargetOs } from "../utils/desktopDownload";
import { flushProductEvents, trackEvent } from "./track";

type AppDownloadClicked = ProductEventProperties<"app_download_clicked">;
export type AppDownloadSurface = AppDownloadClicked["surface"];
/** The links that are not a desktop installer. */
export type AppDownloadMobileTarget = Exclude<AppDownloadClicked["target"], "mac" | "windows" | "linux">;
/** How the clicked link opens: beside this page (`target="_blank"`), or as a download that navigates this page. See the header. */
export type AppDownloadLinkOpens = "new_tab" | "same_tab";

const DESKTOP_BUILD: Record<DesktopTarget, NonNullable<AppDownloadClicked["desktop_build"]>> = {
  "mac": "mac",
  "mac-arm64": "mac_arm64",
  "mac-x64": "mac_x64",
  "windows": "windows",
  "linux-appimage": "linux_appimage",
  "linux-deb": "linux_deb",
};

function send(properties: AppDownloadClicked, opens: AppDownloadLinkOpens): void {
  try {
    trackEvent("app_download_clicked", properties);
    // Only where this page is about to be hidden, never where it is about to navigate (the header).
    if (opens === "new_tab") void flushProductEvents();
  } catch {
    // Not counted; the link still opens.
  }
}

/** A Raft Desktop installer link (/api/desktop-download?target=) was clicked. */
export function trackDesktopDownloadClicked(surface: AppDownloadSurface, target: DesktopTarget, opens: AppDownloadLinkOpens): void {
  send({ surface, target: desktopTargetOs(target), desktop_build: DESKTOP_BUILD[target] }, opens);
}

/** A mobile app link was clicked: the App Store, Google Play, the APK, or the /download page. */
export function trackMobileDownloadClicked(surface: AppDownloadSurface, target: AppDownloadMobileTarget, opens: AppDownloadLinkOpens): void {
  send({ surface, target }, opens);
}
