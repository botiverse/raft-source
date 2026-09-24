import { ImageOff, X } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { registerDomCaptureSnapshot } from "../../../utils/domCaptureSnapshot";
import {
  PROGRAMMATIC_ZOOM_ANIMATION_MS,
  useImageZoom,
} from "../../ImageZoom";
import { MessageTimelinePreserveViewportContext } from "../../message/MessageTimeline";
import Button from "../../ui/Button";
import Lightbox from "../../ui/Lightbox";
import Spinner from "../../ui/Spinner";
import CodeBlock from "../CodeBlock";
import { MermaidDiagramViewer } from "./MermaidDiagramViewer";
import { MermaidToolbar } from "./MermaidToolbar";
import type { MermaidView } from "./MermaidToolbar";
import {
  renderMermaidDiagram,
} from "./mermaidRenderer";
import { svgToPngBlob } from "./mermaidDownload";
import type {
  MermaidRenderResult,
} from "./mermaidRenderer";

type MermaidRenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "valid"; result: MermaidRenderResult }
  | { key: string; status: "error" };

const MERMAID_MIN_SCALE = 0.05;

function MermaidSource({ code }: { code: string }) {
  return (
    // Natural content height: the code view is exactly as tall as the code
    // (Artea, acceptance 07-30). The host card keeps the page still on tab
    // switches with a scroll-anchor, not by forcing equal heights.
    <div className="r-mermaid-source">
      <CodeBlock
        className="r-mermaid-source__code"
        code={code}
        language="mermaid"
        wrapperClassName="group relative"
        showCopyButton={false}
      >
        <code>{code}</code>
      </CodeBlock>
    </div>
  );
}

function MermaidRenderError() {
  const { formatMessage } = useIntl();
  return (
    <div
      className="r-mermaid-render-error"
      role="alert"
      data-testid="mermaid-render-error"
    >
      <ImageOff size={32} strokeWidth={1.75} aria-hidden="true" />
      <span>{formatMessage({ id: "message.mermaid.renderErrorTitle" })}</span>
    </div>
  );
}

/**
 * Renders attacker-controlled Mermaid source with the existing reviewed
 * security boundary: generated SVG stays inside an empty-sandbox iframe with
 * a CSP-locked srcDoc. Zoom layout-resizes that iframe so the browser redraws
 * its SVG at vector resolution; pan only translates the wrapper. No SVG ever
 * needs to enter Raft's main DOM.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { formatMessage } = useIntl();
  const rootRef = useRef<HTMLDivElement>(null);
  // Raft's current web shell is light-only. The renderer cache already keys
  // by theme, but wiring a dark mode here before the app exposes a real theme
  // signal would invent state that no user can change.
  const theme = "light" as const;
  const renderKey = `${theme}\u0000${code}`;
  const renderCounterRef = useRef(0);
  const [settledState, setSettledState] = useState<MermaidRenderState>({
    key: renderKey,
    status: "loading",
  });
  const [view, setView] = useState<MermaidView>("diagram");
  // The Diagram and Code views have different heights by design, and the
  // message timeline re-anchors (or bottom-sticks) on any layout change — a
  // raw scrollTop compensation loses that race. Arm the timeline's own
  // preserve-viewport intent instead (the same mechanism the message
  // expand/collapse uses), so its ResizeObserver keeps the reading position
  // pinned in the same paint. Outside a timeline the context is null and the
  // scroller's natural behavior already keeps the card top still.
  const preserveTimelineViewport = useContext(MessageTimelinePreserveViewportContext);
  const changeView = useCallback((next: MermaidView) => {
    preserveTimelineViewport?.();
    setView(next);
  }, [preserveTimelineViewport]);
  const [fullscreen, setFullscreen] = useState(false);
  const [exportErrorState, setExportErrorState] = useState<{ key: string; message: string } | null>(null);

  // A source change reads as loading immediately without an effect-driven
  // state reset. Only the async terminal result is stored.
  const state: MermaidRenderState = settledState.key === renderKey
    ? settledState
    : { key: renderKey, status: "loading" };
  const exportError = exportErrorState?.key === renderKey ? exportErrorState.message : null;
  const setExportError = useCallback((message: string | null) => {
    setExportErrorState(message ? { key: renderKey, message } : null);
  }, [renderKey]);

  useEffect(() => {
    const renderId = ++renderCounterRef.current;
    renderMermaidDiagram(code, theme).then(
      (result) => {
        if (renderCounterRef.current === renderId) {
          setSettledState({ key: renderKey, status: "valid", result });
        }
      },
      (error) => {
        if (renderCounterRef.current === renderId) {
          console.error("[Mermaid] render failed", error);
          setSettledState({
            key: renderKey,
            status: "error",
          });
        }
      },
    );
    return () => {
      if (renderCounterRef.current === renderId) renderCounterRef.current += 1;
    };
  }, [code, renderKey, theme]);

  const result = state.status === "valid" ? state.result : null;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !result) return;

    return registerDomCaptureSnapshot(root, async () => {
      const blob = await svgToPngBlob(result, {
        imageLoadError: formatMessage({ id: "message.mermaid.pngImageLoadError" }),
        canvasUnavailable: formatMessage({ id: "message.mermaid.pngCanvasUnavailable" }),
        createError: formatMessage({ id: "message.mermaid.pngCreateError" }),
      });
      const imageUrl = URL.createObjectURL(blob);
      const snapshot = document.createElement("div");
      snapshot.className = "r-mermaid-diagram r-mermaid-capture-snapshot";
      snapshot.setAttribute("data-mermaid-status", "valid");

      const viewport = document.createElement("div");
      viewport.className = "r-mermaid-capture-snapshot__viewport";
      const image = document.createElement("img");
      image.className = "r-mermaid-capture-snapshot__image";
      image.src = imageUrl;
      image.alt = "";
      image.width = result.width;
      image.height = result.height;
      image.draggable = false;
      viewport.appendChild(image);
      snapshot.appendChild(viewport);

      return {
        element: snapshot,
        dispose: () => URL.revokeObjectURL(imageUrl),
      };
    });
  }, [formatMessage, result]);
  // The shared controller is lifted above the viewport so the zoom actions
  // can live in the same single-row sticky action bar as every other action.
  const inlineZoom = useImageZoom({
    resetKey: result?.svg,
    wheelRequiresModifier: true,
    minScale: MERMAID_MIN_SCALE,
    scaleMode: "layout",
    programmaticZoomAnimationMs: PROGRAMMATIC_ZOOM_ANIMATION_MS,
  });
  const fullscreenZoom = useImageZoom({
    resetKey: result?.svg,
    wheelRequiresModifier: false,
    minScale: MERMAID_MIN_SCALE,
    scaleMode: "layout",
  });

  return (
    <div ref={rootRef} className="r-mermaid-diagram" data-mermaid-status={state.status}>
      <MermaidToolbar
        code={code}
        view={view}
        onViewChange={changeView}
        result={result}
        zoom={inlineZoom}
        onFullscreen={() => setFullscreen(true)}
        onExportError={setExportError}
      />
      {view === "code" ? (
        <MermaidSource code={code} />
      ) : state.status === "loading" ? (
        // The placeholder reserves the SAME uniform viewport height as the
        // rendered card, so the settle is layout-stable — zero jump.
        <div className="r-mermaid-diagram__loading" role="status">
          <Spinner size="sm" />
          {formatMessage({ id: "message.mermaid.rendering" })}
        </div>
      ) : state.status === "valid" ? (
        <MermaidDiagramViewer result={state.result} zoom={inlineZoom} />
      ) : (
        <MermaidRenderError />
      )}
      {/* Copy/export failures live in one banner that survives view switches.
          Parser diagnostics are developer-only and never enter this UI. */}
      {exportError ? (
        <p className="r-mermaid-diagram__alert" role="alert">
          {exportError}
        </p>
      ) : null}
      {fullscreen && result ? (
        <Lightbox
          onClose={() => setFullscreen(false)}
          className="r-mermaid-fullscreen"
          backdropClass="r-mermaid-fullscreen__backdrop"
          data-testid="mermaid-fullscreen"
        >
          <div className="r-mermaid-fullscreen__panel">
            <div className="r-mermaid-fullscreen__close">
              <Button
                size="xs"
                shape="icon"
                onClick={() => setFullscreen(false)}
                aria-label={formatMessage({ id: "message.mermaid.closeFullscreenAria" })}
              >
                <X size={14} />
              </Button>
            </div>
            <MermaidDiagramViewer result={result} zoom={fullscreenZoom} fullscreen />
          </div>
        </Lightbox>
      ) : null}
    </div>
  );
}
