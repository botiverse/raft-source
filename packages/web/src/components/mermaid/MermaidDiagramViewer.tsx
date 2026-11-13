import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type {
  ImageZoomController,
  ImageZoomLayoutSettleRequest,
} from "../ImageZoom";
import type { MermaidRenderResult } from "./mermaidRenderer";
import { MermaidFrameLayer } from "./MermaidFrameLayer";

type MermaidFrameTransition = {
  id: number;
  ratio: number;
  request: ImageZoomLayoutSettleRequest;
};

type MermaidRetiringFrame = {
  id: number;
  ratio: number;
};

const MERMAID_RETIRE_PAINT_FRAMES = 6;

/**
 * A sandboxed iframe repaints its document asynchronously after the iframe
 * element is resized. Switching Mermaid's live compositor scale straight to
 * the new layout size therefore exposes blank or stale intermediate frames.
 *
 * Keep the sharp frame that was already on screen, prepare one duplicate at
 * the target CSS-pixel geometry behind it, then swap and normalize both layer
 * transforms in the same animation frame. The duplicate exists only during a
 * settle; idle timelines still pay for exactly one empty-sandbox iframe.
 */
function BufferedMermaidFrame({
  result,
  zoom,
  title,
}: {
  result: MermaidRenderResult;
  zoom: ImageZoomController;
  title: string;
}) {
  const [activeFrameId, setActiveFrameId] = useState(0);
  const [transition, setTransition] = useState<MermaidFrameTransition | null>(null);
  const [retiringFrame, setRetiringFrame] = useState<MermaidRetiringFrame | null>(null);
  const activeFrameIdRef = useRef(activeFrameId);
  const transitionRef = useRef(transition);
  const nextFrameIdRef = useRef(0);
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const settleFramesRef = useRef<number[]>([]);
  const mountedRef = useRef(false);
  const { layoutSettleRef } = zoom;
  activeFrameIdRef.current = activeFrameId;
  transitionRef.current = transition;

  const cancelSettleFrames = useCallback(() => {
    for (const frame of settleFramesRef.current) window.cancelAnimationFrame(frame);
    settleFramesRef.current = [];
  }, []);

  const retireFrameAfterPaints = useCallback((id: number) => {
    let remaining = MERMAID_RETIRE_PAINT_FRAMES;
    const tick = () => {
      remaining -= 1;
      if (remaining > 0) {
        const frame = window.requestAnimationFrame(tick);
        settleFramesRef.current = [frame];
        return;
      }
      settleFramesRef.current = [];
      if (mountedRef.current) {
        setRetiringFrame((current) => current?.id === id ? null : current);
      }
    };
    const frame = window.requestAnimationFrame(tick);
    settleFramesRef.current = [frame];
  }, []);

  const prepareLayoutSettle = useCallback((request: ImageZoomLayoutSettleRequest) => {
    const ratio = request.toScale / request.fromScale;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      request.complete();
      return;
    }
    cancelSettleFrames();
    setRetiringFrame(null);
    const id = nextFrameIdRef.current + 1;
    nextFrameIdRef.current = id;
    setTransition({ id, ratio, request });
    return () => {
      cancelSettleFrames();
      if (mountedRef.current) {
        setTransition((current) => current?.id === id ? null : current);
      }
    };
  }, [cancelSettleFrames]);

  useEffect(() => {
    mountedRef.current = true;
    layoutSettleRef(prepareLayoutSettle);
    return () => {
      mountedRef.current = false;
      cancelSettleFrames();
      // The cancellation callback registered in ImageZoom may point back into
      // this component. Clear it only after marking the closure unmounted.
      layoutSettleRef(null);
    };
  }, [cancelSettleFrames, layoutSettleRef, prepareLayoutSettle]);

  const finishPreparedFrame = useCallback((id: number) => {
    const current = transitionRef.current;
    if (!current || current.id !== id) return;
    cancelSettleFrames();
    const first = window.requestAnimationFrame(() => {
      const second = window.requestAnimationFrame(() => {
        const latest = transitionRef.current;
        const nextFrame = frameRefs.current.get(id);
        const previousId = activeFrameIdRef.current;
        const previousFrame = frameRefs.current.get(previousId);
        if (!latest || latest.id !== id || !nextFrame || !previousFrame) return;
        if (!latest.request.complete()) return;

        // `nextFrame` currently has target layout pixels but an inverse visual
        // scale under the old media geometry. The accepted `complete()` above
        // normalizes the outer geometry; these writes normalize the inner one
        // and preserve the same final pixels. The browser cannot paint between
        // them, so no stale iframe document becomes visible.
        nextFrame.style.left = "0px";
        nextFrame.style.top = "0px";
        nextFrame.style.width = "100%";
        nextFrame.style.height = "100%";
        nextFrame.style.transform = "none";
        nextFrame.style.opacity = "1";
        // raft-ui: z-index crossfade buffer, three frames (prepared 0 < active 1 < retiring 2) inside the viewer's own stack
        nextFrame.style.zIndex = "1";
        nextFrame.removeAttribute("aria-hidden");
        nextFrame.removeAttribute("tabindex");

        // Do not drop the already-painted raster in the same callback that
        // normalizes the outer media geometry. Chromium can invalidate the
        // accepted iframe's sandbox raster for a later compositor frame; a
        // gesture landing in that gap used to reveal an all-white document.
        // Preserve the old iframe's document-pixel size while expressing the
        // accepted ratio purely on its compositor layer, then retire it only
        // after the normalized replacement has crossed several paints.
        previousFrame.style.left = "50%";
        previousFrame.style.top = "50%";
        previousFrame.style.width = `${100 / latest.ratio}%`;
        previousFrame.style.height = `${100 / latest.ratio}%`;
        previousFrame.style.transform = `translate(-50%, -50%) scale(${latest.ratio})`;
        previousFrame.style.transformOrigin = "center center";
        previousFrame.style.opacity = "1";
        // raft-ui: z-index crossfade buffer, three frames (prepared 0 < active 1 < retiring 2) inside the viewer's own stack
        previousFrame.style.zIndex = "2";
        previousFrame.setAttribute("aria-hidden", "true");
        previousFrame.tabIndex = -1;
        activeFrameIdRef.current = id;
        transitionRef.current = null;
        setActiveFrameId(id);
        setTransition((pending) => pending?.id === id ? null : pending);
        setRetiringFrame({ id: previousId, ratio: latest.ratio });
        retireFrameAfterPaints(previousId);
      });
      settleFramesRef.current = [second];
    });
    settleFramesRef.current = [first];
  }, [cancelSettleFrames, retireFrameAfterPaints]);

  const layers = transition
    ? [
        { id: activeFrameId, kind: "active" as const, ratio: 1 },
        { id: transition.id, kind: "prepared" as const, ratio: transition.ratio },
      ]
    : retiringFrame
      ? [
          { id: activeFrameId, kind: "active" as const, ratio: 1 },
          { id: retiringFrame.id, kind: "retiring" as const, ratio: retiringFrame.ratio },
        ]
      : [{ id: activeFrameId, kind: "active" as const, ratio: 1 }];

  return layers.map((layer) => (
    <MermaidFrameLayer
      key={layer.id}
      layer={layer}
      srcDoc={result.srcDoc}
      title={title}
      frameRefs={frameRefs}
      onPreparedLoad={finishPreparedFrame}
    />
  ));
}

export function MermaidDiagramViewer({
  result,
  zoom,
  fullscreen = false,
}: {
  result: MermaidRenderResult;
  zoom: ImageZoomController;
  fullscreen?: boolean;
}) {
  const { formatMessage } = useIntl();

  return (
    <div className={fullscreen ? "r-mermaid-viewer r-mermaid-viewer--fullscreen" : "r-mermaid-viewer"}>
      <div
        ref={zoom.wheelTargetRef}
        className={`r-mermaid-viewport ${fullscreen ? "r-mermaid-viewport--fullscreen" : "r-mermaid-viewport--inline"}`}
        style={fullscreen
          ? {
              cursor: zoom.style.stageCursor,
              // React 19 binds touchstart/touchmove passively. Claim the
              // fullscreen surface before the FIRST pinch; waiting until the
              // diagram is zoomed lets Android/iOS zoom the whole page first.
            }
          : {
              // UNIFORM responsive viewport: every inline diagram card is the
              // same height on a given screen — the box never tracks content
              // length in either direction, so a row of mixed diagrams keeps one
              // visual rhythm (Artea, acceptance 07-30). Short diagrams center
              // with whitespace; consistency beats per-card compactness.
              cursor: zoom.style.stageCursor,
            }}
        onDoubleClick={zoom.onDoubleClick}
        onPointerDown={zoom.onPointerDown}
        onPointerMove={zoom.onPointerMove}
        onPointerUp={zoom.onPointerUp}
        onPointerCancel={zoom.onPointerUp}
        onTouchStart={zoom.onTouchStart}
        onTouchMove={zoom.onTouchMove}
        onTouchEnd={zoom.onTouchEnd}
        onTouchCancel={zoom.onTouchEnd}
        data-testid="mermaid-pan-zoom-viewport"
      >
        <div
          className={`r-mermaid-zoom-anchor ${fullscreen ? "r-mermaid-zoom-anchor--fullscreen" : "r-mermaid-zoom-anchor--inline"}`}
          data-testid="mermaid-zoom-anchor"
          style={{
            aspectRatio: `${result.width} / ${result.height}`,
            // Option A (Artea, acceptance 07-30): every diagram opens with
            // its COMPLETE contents contain-fitted, including pathological
            // tall/wide ratios. Inline additionally avoids upscaling above
            // natural size; fullscreen may magnify to use the available box.
            width: fullscreen
              ? `min(100cqw, calc(100cqh * ${result.width / result.height}))`
              : `min(100cqw, calc(100cqh * ${result.width / result.height}), ${result.width}px)`,
            height: fullscreen
              ? `min(100cqh, calc(100cqw * ${result.height / result.width}))`
              : undefined,
          }}
        >
          <div
            ref={zoom.imageRef}
            className="r-mermaid-zoom-media"
            data-testid="mermaid-zoom-media"
            style={{
              width: zoom.style.width,
              height: zoom.style.height,
              transform: zoom.style.transform,
              transformOrigin: "center center",
              cursor: zoom.style.cursor,
              touchAction: fullscreen ? "none" : "pan-y",
            }}
            onTransitionEnd={zoom.onTransitionEnd}
          >
            <BufferedMermaidFrame
              key={result.svg}
              result={result}
              zoom={zoom}
              title={formatMessage({ id: "message.mermaid.diagramFrameTitle" })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
