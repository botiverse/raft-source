import { useIntl } from "react-intl";
import RootFallbackScroller from "./RootFallbackScroller";

export function AppRefreshRequiredScreen({
  onContinueAnyway,
  onRecoverAndRefresh,
}: {
  onContinueAnyway: () => void;
  onRecoverAndRefresh: () => void;
}) {
  const { formatMessage } = useIntl();

  return (
    <RootFallbackScroller
      style={{
        background: "rgba(17, 17, 17, 0.12)",
        color: "#111",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: 24,
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <main
        role="alert"
        aria-live="assertive"
        style={{
          width: "min(100%, 448px)",
          border: "2px solid #111",
          background: "#fff",
          boxShadow: "6px 6px 0 #111",
          padding: 24,
          flexShrink: 0,
          margin: "auto 0",
        }}
      >
        <h1 style={{ margin: "0 0 12px", fontSize: 28, lineHeight: 1.1, fontWeight: 900 }}>
          {formatMessage({ id: "app.update.refreshToContinue" })}
        </h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: "#333" }}>
          {formatMessage({ id: "app.update.staleBuildBody" })}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 20 }}>
          <button
            type="button"
            onClick={onRecoverAndRefresh}
            style={{
              border: "2px solid #111",
              background: "#ff5ca8",
              color: "#111",
              boxShadow: "3px 3px 0 #111",
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 900,
              cursor: "pointer",
            }}
          >
            {formatMessage({ id: "app.update.refreshNow" })}
          </button>
          <button
            type="button"
            onClick={onContinueAnyway}
            style={{
              border: 0,
              background: "transparent",
              color: "#111",
              padding: "6px 0",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            {formatMessage({ id: "app.update.continueAnyway" })}
          </button>
        </div>
      </main>
    </RootFallbackScroller>
  );
}

export function AppRefreshWarningBanner({ onRefresh }: { onRefresh: () => void }) {
  const { formatMessage } = useIntl();

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 40,
        width: "min(calc(100% - 24px), 560px)",
        border: "2px solid #111",
        background: "#fff",
        boxShadow: "4px 4px 0 #111",
        color: "#111",
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 13,
        lineHeight: 1.35,
      }}
    >
      <span>{formatMessage({ id: "app.update.newerVersionAvailable" })}</span>
      <button
        type="button"
        onClick={onRefresh}
        style={{
          border: "2px solid #111",
          background: "#fff",
          color: "#111",
          boxShadow: "2px 2px 0 #111",
          padding: "6px 10px",
          fontSize: 12,
          fontWeight: 900,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {formatMessage({ id: "app.update.refresh" })}
      </button>
    </div>
  );
}
