import { useEffect, useState } from "react";

/**
 * QR code for the mobile download entry: on a computer, the phones' way in,
 * on /download and in Settings → About, with the sentence that says what it
 * does (raft-design getting-the-app.md). The caller sets the sentence beside it.
 *
 * **It encodes the route with NO `platform` parameter, deliberately.** At scan
 * time we cannot know what the scanning device is — the person is looking at a
 * desktop screen, and the phone is the thing that will open the URL. The route
 * already falls back to User-Agent detection when no platform is given, so one
 * QR serves an Android phone and an iPhone correctly. Encoding a platform here
 * would mean printing two codes and making the reader classify their own device,
 * which is the job we just automated.
 *
 * **Computers only.** A phone reading this can't scan its own screen, so the
 * callers show it when the device isn't a phone (`detectPhoneDevice`).
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
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${code.size} ${code.size}`}
      className="size-28 shrink-0 rounded-sticker border border-line-hairline bg-sticker-paper p-1 text-sticker-ink"
      shapeRendering="crispEdges"
      data-testid="mobile-download-qr"
    >
      <path d={code.path} fill="currentColor" />
    </svg>
  );
}
