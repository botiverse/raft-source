import { useCallback, useMemo } from "react";
import type { CSSProperties, RefObject } from "react";
import SandboxedPreviewFrame from "../ui/SandboxedPreviewFrame";

type MermaidFrameLayerState = {
  id: number;
  kind: "active" | "prepared" | "retiring";
  ratio: number;
};

function frameLayerStyle(kind: MermaidFrameLayerState["kind"], ratio: number): CSSProperties {
  return kind === "active"
    ? {
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        opacity: 1,
        // raft-ui: z-index crossfade buffer, three frames (prepared 0 < active 1 < retiring 2) inside the viewer's own stack
        zIndex: 1,
      }
    : kind === "prepared"
      ? {
          left: "50%",
          top: "50%",
          width: `${ratio * 100}%`,
          height: `${ratio * 100}%`,
          transform: `translate(-50%, -50%) scale(${1 / ratio})`,
          transformOrigin: "center center",
          // Keep the prepared document paintable. `opacity: 0` lets the
          // browser defer its iframe raster until reveal, recreating the
          // exact stale-frame flash this buffer exists to prevent. The old
          // frame is above it and covers the same visual pixels.
          opacity: 1,
          // raft-ui: z-index crossfade buffer, three frames (prepared 0 < active 1 < retiring 2) inside the viewer's own stack
          zIndex: 0,
        }
      : {
          left: "50%",
          top: "50%",
          width: `${100 / ratio}%`,
          height: `${100 / ratio}%`,
          transform: `translate(-50%, -50%) scale(${ratio})`,
          transformOrigin: "center center",
          opacity: 1,
          // raft-ui: z-index crossfade buffer, three frames (prepared 0 < active 1 < retiring 2) inside the viewer's own stack
          zIndex: 2,
        };
}

export function MermaidFrameLayer({
  layer,
  srcDoc,
  title,
  frameRefs,
  onPreparedLoad,
}: {
  layer: MermaidFrameLayerState;
  srcDoc: string;
  title: string;
  frameRefs: RefObject<Map<number, HTMLIFrameElement>>;
  onPreparedLoad: (id: number) => void;
}) {
  const { id, kind, ratio } = layer;
  const frameRef = useCallback((frame: HTMLIFrameElement | null) => {
    if (frame) frameRefs.current.set(id, frame);
    else frameRefs.current.delete(id);
  }, [frameRefs, id]);
  const handleLoad = useCallback(() => onPreparedLoad(id), [id, onPreparedLoad]);
  const style = useMemo(() => frameLayerStyle(kind, ratio), [kind, ratio]);

  return (
    <SandboxedPreviewFrame
      srcDoc={srcDoc}
      sandbox=""
      referrerPolicy="no-referrer"
      title={title}
      ariaHidden={kind === "active" ? undefined : true}
      tabIndex={kind === "active" ? undefined : -1}
      frameRef={frameRef}
      onLoad={kind === "prepared" ? handleLoad : undefined}
      className="r-mermaid-frame"
      style={style}
    />
  );
}
