import { useLayoutEffect, useMemo } from "react";
import type { CSSProperties } from "react";
import { useIntl } from "react-intl";
import { Banner, BannerAction, BannerDescription, Button } from "@botiverse/raft-ui";
import { toastViewportNoticeMoved, useToastViewportBottom, useToastViewportNotice } from "../toastViewportBottom";

// The floating update banner: the web's new-version prompt (NewWebVersionBanner)
// and Raft Desktop's 24-hour "Restart to Update" banner (apps/desktop
// appUpdate.tsx). Its own module, so the desktop uses it without the web's
// version check. It has a button, so it closes with Dismiss beside it, never
// a × (raft-ui Banner: BannerClose only on a banner without a button).
// It sits where a toast does (Raft DS › Toast › Where it appears): bottom
// centre, 16px above `--toast-viewport-bottom`: the composer (or the bar in
// its place) at every width, the tab bar or the keyboard on a phone, the
// window's bottom on a page without any of them; never under the home
// indicator. A phone's open-in-app row is part of the bottom of the page
// (raft-design #1218), so wherever it shows the banner sits above its top
// edge, never over it. It registers as a notice there, so a toast shown with
// it stacks above it rather than over its action (toastViewportBottom.ts).
const BANNER_PLACE =
  "fixed left-1/2 z-app w-[min(calc(100%-24px),560px)] -translate-x-1/2 bottom-[calc(max(var(--toast-viewport-bottom,0px),env(safe-area-inset-bottom))+1rem)]";

export function FloatingUpdateBanner({ message, actionLabel, onAction, onDismiss, testId = "new-web-version-banner" }: {
  message: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const noticeRef = useToastViewportNotice();
  // Its own place, from the floors and what sits in the page's flow on them (the open-in-app row); a toast's place counts this banner.
  const viewportBottom = useToastViewportBottom(false, false);
  const placeStyle = useMemo(
    () => (viewportBottom === null ? undefined : ({ "--toast-viewport-bottom": `${viewportBottom}px` } as CSSProperties)),
    [viewportBottom],
  );
  // Moved without resizing: a toast stacked above it moves along.
  useLayoutEffect(() => toastViewportNoticeMoved(), [viewportBottom]);

  return (
    // raft-ui Banner is the status region itself (role="status").
    <div ref={noticeRef} className={BANNER_PLACE} style={placeStyle} data-testid={`${testId}-place`}>
      <Banner status="info" className="shadow-float" data-testid={testId}>
        <BannerDescription>{message}</BannerDescription>
        <BannerAction>
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            {formatMessage({ id: "app.update.dismiss" })}
          </Button>
          <Button variant="default" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </BannerAction>
      </Banner>
    </div>
  );
}
