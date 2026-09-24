import { useIntl } from "react-intl";
import { mobileDownloadUrl } from "../utils/mobileDownloadUrl";

/**
 * Public "pick your platform" page for the mobile download entry.
 *
 * **Why this page exists at all.** The server classifies devices by User-Agent,
 * and modern iPadOS Safari sends a string byte-identical to macOS — so an iPad
 * scanning our QR was indistinguishable from a desktop and got a 400. iPad is a
 * supported target (@huxijin, after @Aiden established the app runs on iPadOS),
 * so the entry point cannot answer "unsupported" from the UA alone. Anything
 * the server cannot classify lands here and the person chooses.
 *
 * **No session required.** Whoever scanned the QR has not signed in on that
 * device — mounting this behind auth would put a login wall in front of the
 * download, which is the failure this whole entry point exists to avoid. It is
 * registered on the public router, outside the authenticated shell.
 *
 * **Both links go back through `/api/mobile-download` with an explicit
 * platform**, never to a vendor URL: Hands hands out signed URLs that expire,
 * and TestFlight is an Apple-side surface that may be re-created. Explicit
 * platforms also mean this page cannot bounce back to itself.
 */

/**
 * Whether this browser is an iPad reporting itself as a Mac.
 *
 * `maxTouchPoints` is the documented discriminator: desktop Safari on real
 * macOS reports 0, iPadOS reports 5 while claiming `Macintosh`. Read at render
 * rather than module scope so tests can drive it, and guarded because a
 * non-browser render (SSR, jsdom without the field) must not throw.
 */
export function isTouchCapableMac(nav: { userAgent?: string; maxTouchPoints?: number } | undefined): boolean {
  if (!nav) return false;
  const ua = nav.userAgent ?? "";
  return /Macintosh|Mac OS X/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

export default function MobileDownloadChooserPage() {
  const { formatMessage } = useIntl();
  const likelyIPad = typeof navigator === "undefined" ? false : isTouchCapableMac(navigator);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-brutal-cream px-6 py-10 font-display">
      <div className="card-brutal w-full max-w-sm space-y-4 p-6" data-testid="mobile-download-chooser">
        <h1 className="text-lg font-bold text-black">
          {formatMessage({ id: "mobileDownload.chooser.title" })}
        </h1>
        <p className="text-sm text-black/60">
          {formatMessage({ id: "mobileDownload.chooser.description" })}
        </p>
        {/* An iPad cannot be identified server-side, so when the browser tells us
            what the UA could not, say so — otherwise the reader has to know that
            "iPad counts as iOS here", which is our implementation detail. */}
        {likelyIPad ? (
          <p className="text-xs text-black/50" data-testid="mobile-download-chooser-ipad-hint">
            {formatMessage({ id: "mobileDownload.chooser.ipadHint" })}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          {/* Leaves Raft (302 → testflight.apple.com), so new tab; Android is a
              download and stays put. Same asymmetry as the Settings section. */}
          <a
            className="btn-brutal-sm bg-white px-3 py-2 text-center text-sm font-bold"
            href={mobileDownloadUrl("ios")}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="mobile-download-chooser-ios"
          >
            {formatMessage({ id: "settings.mobileApp.ios" })}
          </a>
          <a
            className="btn-brutal-sm bg-white px-3 py-2 text-center text-sm font-bold"
            href={mobileDownloadUrl("android")}
            data-testid="mobile-download-chooser-android"
          >
            {formatMessage({ id: "settings.mobileApp.android" })}
          </a>
        </div>
      </div>
    </div>
  );
}
