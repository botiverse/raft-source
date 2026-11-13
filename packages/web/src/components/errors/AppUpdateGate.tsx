import { useIntl } from "react-intl";
import { Banner, BannerAction, BannerDescription, Button } from "@botiverse/raft-ui";
import RootFallbackScroller from "./RootFallbackScroller";
import { FALLBACK_STYLE } from "./RootErrorFallback";

/** A stale build can mean the stylesheet itself is gone, so these screens use
 *  the same token-with-literal-fallback styling as the crash screen. */
export function AppRefreshRequiredScreen({
  onContinueAnyway,
  onRecoverAndRefresh,
}: {
  onContinueAnyway: () => void;
  onRecoverAndRefresh: () => void;
}) {
  const { formatMessage } = useIntl();

  return (
    <RootFallbackScroller className="safe-top safe-bottom" style={FALLBACK_STYLE.page}>
      <div
        role="alert"
        aria-live="assertive"
        style={{ ...FALLBACK_STYLE.card, maxWidth: 448 }}
      >
        <h1 style={FALLBACK_STYLE.title}>
          {formatMessage({ id: "app.update.refreshToContinue" })}
        </h1>
        <p style={FALLBACK_STYLE.body}>
          {formatMessage({ id: "app.update.staleBuildBody" })}
        </p>
        <div style={FALLBACK_STYLE.actions}>
          <button
            type="button"
            onClick={onContinueAnyway}
            style={FALLBACK_STYLE.ghostButton}
          >
            {formatMessage({ id: "app.update.continueAnyway" })}
          </button>
          <button
            type="button"
            onClick={onRecoverAndRefresh}
            style={FALLBACK_STYLE.primaryButton}
          >
            {formatMessage({ id: "app.update.refreshNow" })}
          </button>
        </div>
      </div>
    </RootFallbackScroller>
  );
}

// Raft Design System › Banner (warning) over the running app: the app stays
// mounted under it (unsent text survives) until the person chooses Refresh;
// Dismiss puts it away. Only shown while the app renders, so its stylesheet
// (and raft-ui's) is there, unlike the screen above.
export function AppRefreshWarningBanner({ onRefresh, onDismiss }: { onRefresh: () => void; onDismiss?: () => void }) {
  const { formatMessage } = useIntl();

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 z-app w-[min(calc(100%-24px),560px)] -translate-x-1/2"
    >
      <Banner status="warning" className="shadow-float" data-testid="app-update-banner">
        <BannerDescription>{formatMessage({ id: "app.update.newerVersionAvailable" })}</BannerDescription>
        <BannerAction>
          {onDismiss ? (
            <Button variant="ghost" size="md" onClick={onDismiss}>
              {formatMessage({ id: "app.update.dismiss" })}
            </Button>
          ) : null}
          <Button variant="default" size="md" onClick={onRefresh}>
            {formatMessage({ id: "app.update.refresh" })}
          </Button>
        </BannerAction>
      </Banner>
    </div>
  );
}
