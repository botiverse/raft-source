import { useEffect, useState } from "react";
import { useIntl } from "react-intl";

/**
 * QR code for the mobile download entry, shown beside the download buttons.
 *
 * **It encodes the route with NO `platform` parameter, deliberately.** At scan
 * time we cannot know what the scanning device is — the person is looking at a
 * desktop screen, and the phone is the thing that will open the URL. The route
 * already falls back to User-Agent detection when no platform is given, so one
 * QR serves an Android phone and an iPhone correctly. Encoding a platform here
 * would mean printing two codes and making the reader classify their own device,
 * which is the job we just automated.
 *
 * **Desktop-only, and that is a viewport question rather than a device one.**
 * Someone reading this on a phone should tap a button; a QR they would have to
 * scan with a second device is useless to them. That is the opposite axis from
 * *which artifact to serve*, which is decided by User-Agent in the route — width
 * decides layout, UA decides the installable.
 *
 * **Built from the module matrix, not from the library's SVG string.** `uqr`
 * also offers `renderSVG`, but painting that requires `dangerouslySetInnerHTML`,
 * which this repo's lint forbids outright. Rather than suppress the rule for a
 * string we happen to trust today, the matrix goes into one `<path>` we build
 * ourselves: same output, no raw-HTML sink, and the ban stays absolute — a rule
 * with one exemption is a rule someone will cite the next time.
 *
 * The encoder is imported lazily so it never enters the initial bundle: this is
 * one section of one settings tab.
 */
export default function MobileDownloadQr({ url }: { url: string }) {
  const { formatMessage } = useIntl();
  const [code, setCode] = useState<{ size: number; path: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { encode } = await import("uqr");
        const result = encode(url, { border: 1 });
        // One path command per dark module. A single element keeps the DOM flat
        // — a rect per module is ~1000 nodes for a URL this long.
        const path = result.data
          .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x},${y}h1v1h-1z` : "")))
          .join("");
        // Guard against unmount and against a second render racing the first:
        // applying a stale result would paint a QR for a URL we no longer show.
        if (!cancelled) setCode({ size: result.size, path });
      } catch {
        // A failed chunk load must not take out the settings panel. The buttons
        // above are the primary path and still work; the QR is an accelerator,
        // so its absence is a smaller loss than a blank tab.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!code) return null;

  return (
    <div className="hidden shrink-0 sm:block" data-testid="mobile-download-qr">
      {/* Above the code, and never wrapped: it introduces the QR rather than
          captioning it, so it has to be read first. `w-28` (the code's width)
          broke "Or, Scan with your phone" across two lines, which made a
          one-line aside look like a heading (@wenyi). */}
      <div className="mb-1 whitespace-nowrap text-[11px] leading-tight text-black/50">
        {formatMessage({ id: "settings.mobileApp.qrCaption" })}
      </div>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${code.size} ${code.size}`}
        className="h-28 w-28 border-2 border-black bg-white p-1"
        shapeRendering="crispEdges"
      >
        <path d={code.path} fill="currentColor" />
      </svg>
    </div>
  );
}
