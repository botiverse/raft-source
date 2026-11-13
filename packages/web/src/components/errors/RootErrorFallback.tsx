import type { CSSProperties } from "react";
import { useIntl } from "react-intl";
import RootFallbackScroller from "./RootFallbackScroller";
import { TraceIdNote } from "./TraceIdNote";
import { forgetRememberedPlaces } from "../../hooks/tabRouteMemoryKeys";

function reloadApp() {
  window.location.reload();
}

/** Raft's start page, with no remembered conversation to go back to (#triage:#351: Reload reopened the one that crashed). */
function openRaftHome() {
  forgetRememberedPlaces();
  window.location.assign("/");
}

/**
 * Crash-screen styling. These screens render when the app has already thrown —
 * possibly because styling itself failed — so they must not depend on the
 * design system to draw an error about the design system. Every value reads
 * the Raft Design System token first (so light/dark follow the app when the
 * tokens are there) and falls back to the DS light literal when they are not.
 * Inline literals are intentional here (scripts/check-color-tokens.ts
 * INLINE_STYLE_EXEMPT).
 */
export const FALLBACK_STYLE = {
  page: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "var(--layer-canvas, #ffffff)",
    color: "var(--foreground, #141111)",
    fontFamily: 'var(--font-sans, "Space Grotesk", system-ui, sans-serif)',
  },
  // Raft Design System › Dialog: the popover layer, 16px radius, 20px padding,
  // a seam edge plus the float shadow.
  card: {
    width: "100%",
    padding: 20,
    borderRadius: 16,
    background: "var(--layer-popover, #ffffff)",
    color: "var(--foreground, #141111)",
    boxShadow: "0 0 0 1px var(--line-seam, #14111173), var(--elevation-float, 0 1px 0 #1411110a, 0 12px 32px -12px #14111152)",
  },
  title: { margin: 0, fontSize: 17, lineHeight: "22px", fontWeight: 700 },
  body: { margin: "6px 0 0", fontSize: 15, lineHeight: "20px", color: "var(--foreground-muted, #141111ad)" },
  // Raft Design System › Code: the code surface with a hairline, Space Mono 13/20.
  code: {
    marginTop: 16,
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid var(--line-hairline, #14111126)",
    background: "var(--layer-code, #ffffff)",
    color: "var(--foreground, #141111)",
    fontFamily: 'var(--font-mono, "Space Mono", ui-monospace, monospace)',
    fontSize: 13,
    lineHeight: "20px",
  },
  summary: { fontFamily: 'var(--font-sans, "Space Grotesk", system-ui, sans-serif)', fontSize: 13, lineHeight: "18px", fontWeight: 600, cursor: "pointer" },
  pre: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" },
  detailPre: { margin: "8px 0 0", maxHeight: 192, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", color: "var(--foreground-muted, #141111ad)" },
  actions: { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 20 },
  // Raft Design System › Button: 44 tall, 8px radius, 15/20 700, never a shadow.
  // The one pink primary per screen…
  primaryButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    padding: "0 16px",
    borderRadius: 8,
    border: "1.5px solid var(--sticker-ink, #141111)",
    background: "var(--attention-400, #ff99c3)",
    color: "var(--sticker-ink, #141111)",
    font: "inherit",
    fontSize: 15,
    lineHeight: "20px",
    fontWeight: 700,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  // …and the quiet ghost button for the way out.
  ghostButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    padding: "0 16px",
    borderRadius: 8,
    border: "1.5px solid transparent",
    background: "transparent",
    color: "var(--foreground, #141111)",
    font: "inherit",
    fontSize: 15,
    lineHeight: "20px",
    fontWeight: 700,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
} satisfies Record<string, CSSProperties>;

/**
 * The window's title strip on the crash screen of a shell whose top row is the
 * window's title bar (the desktop app): the crash took the app's top bar and
 * stand-in strip with it, so without this the frameless window could not be
 * moved and nothing would keep content out from under the window controls.
 * `data-raft-titlebar` gives it the shared drag region and insets (titleBar.css).
 * The bar's height (44, the desktop title bar's) and frame colour (--layer-frame, the colour the
 * caption buttons were last painted in), in plain inline styles like the rest
 * of this screen.
 */
function FallbackTitleBar() {
  return (
    <div
      data-raft-titlebar
      data-testid="root-error-title-bar"
      aria-hidden="true"
      style={{ height: 44, flexShrink: 0, background: "var(--layer-frame, #ffd440)" }}
    />
  );
}

export default function RootErrorFallback({
  error,
  componentStack,
  traceId,
  titleBar = false,
}: {
  error: Error;
  componentStack?: string | null;
  /** The crash report's trace id (clientErrorTrace.ts), shown with a copy button. */
  traceId?: string | null;
  /** The top row is the window's title bar (a title-bar host shell): draw the draggable strip. */
  titleBar?: boolean;
}) {
  const { formatMessage } = useIntl();

  const page = (
    <RootFallbackScroller className="safe-top safe-bottom" style={FALLBACK_STYLE.page}>
      <div
        role="alert"
        aria-live="assertive"
        style={{ ...FALLBACK_STYLE.card, maxWidth: 672 }}
      >
        <h1 style={FALLBACK_STYLE.title}>
          {formatMessage({ id: "errorBoundary.title" })}
        </h1>

        <div style={FALLBACK_STYLE.code}>
          <pre style={FALLBACK_STYLE.pre}>{error.message}</pre>
        </div>

        {traceId ? <TraceIdNote traceId={traceId} /> : null}

        {error.stack ? (
          <details style={FALLBACK_STYLE.code}>
            <summary style={FALLBACK_STYLE.summary}>
              {formatMessage({ id: "errorBoundary.stack" })}
            </summary>
            <pre style={FALLBACK_STYLE.detailPre}>
              {error.stack}
            </pre>
          </details>
        ) : null}

        {componentStack ? (
          <details open style={FALLBACK_STYLE.code}>
            <summary style={FALLBACK_STYLE.summary}>
              {formatMessage({ id: "errorBoundary.componentStack" })}
            </summary>
            <pre style={FALLBACK_STYLE.detailPre}>
              {componentStack}
            </pre>
          </details>
        ) : null}

        <div style={FALLBACK_STYLE.actions}>
          <button type="button" onClick={openRaftHome} style={FALLBACK_STYLE.ghostButton} data-testid="root-error-open-home">
            {formatMessage({ id: "errorBoundary.openHome" })}
          </button>
          <button type="button" onClick={reloadApp} style={FALLBACK_STYLE.primaryButton}>
            {formatMessage({ id: "errorBoundary.reloadApp" })}
          </button>
        </div>
      </div>
    </RootFallbackScroller>
  );
  if (!titleBar) return page;
  return (
    <>
      <FallbackTitleBar />
      {page}
    </>
  );
}
