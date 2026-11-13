import { useEffect, useState } from "react";

// Paper under ink in both themes (a sticker: it never inverts), so the code
// reads the same in dark mode; the placeholder is the same box, so nothing
// jumps when the code arrives.
const FRAME = "mx-auto size-48 rounded-sticker border border-line-hairline bg-sticker-paper p-1 text-sticker-ink";

/**
 * The QR code WeChat scans, from the start's `qrContent` (iLink's, shown as
 * is); null while it is being made. Same encoder and drawing as the two-step
 * QR (TotpQrCode) and MobileDownloadQr: the module matrix as one <path>, the
 * encoder loaded only when a code is shown. Two modules of quiet zone inside
 * the frame's padding, so the code stands clear of a dark page around it.
 */
export function WeChatQrCode({ content, label }: { content: string | null; label: string }) {
  const [code, setCode] = useState<{ content: string; size: number; path: string } | null>(null);
  useEffect(() => {
    if (content === null) return undefined;
    let cancelled = false;
    void import("uqr").then(({ encode }) => {
      const result = encode(content, { border: 2 });
      const path = result.data
        .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x},${y}h1v1h-1z` : "")))
        .join("");
      if (!cancelled) setCode({ content, size: result.size, path });
    }, () => {
      // Stays an empty frame; the status line under it still says what to do.
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (content === null || !code || code.content !== content) return <div className={FRAME} aria-hidden="true" data-testid="wechat-qr-placeholder" />;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${code.size} ${code.size}`}
      className={FRAME}
      shapeRendering="crispEdges"
      data-testid="wechat-qr"
    >
      <path d={code.path} fill="currentColor" />
    </svg>
  );
}
