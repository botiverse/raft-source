// The handles that resize the assistant's popover (assistantPanelSize.ts):
// its top edge, its left edge and its top-left corner, the sides away from
// the corner it is pinned to. The DS Resizable look (nothing at rest, a 1px
// foreground-muted line on hover and drag, 2px foreground on keyboard focus),
// each a focusable separator: arrow keys move it 16px (Shift: 64px), Home/End
// go to the minimum/maximum, a double click restores the default size.

import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useIntl } from "react-intl";
import { PANEL_MIN, clampPanelSize, panelMax, setPanelSize } from "./assistantPanelSize";
import type { PanelSize } from "./assistantPanelSize";

type Edge = "top" | "left" | "corner";

/** Each handle named for its side, so a screen reader tells them apart (Jasper). */
const LABEL_ID = { top: "assistant.otter.resize.top", left: "assistant.otter.resize.left", corner: "assistant.otter.resize.corner" } as const satisfies Record<Edge, string>;

const STEP = 16;
const BIG_STEP = 64;

function viewport() {
  return {
    width: typeof document === "undefined" ? 0 : document.documentElement.clientWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  };
}

const EDGE_CLASS: Record<Edge, string> = {
  top: "inset-x-3 top-0 h-2 cursor-ns-resize before:inset-x-0 before:top-0 before:h-px focus-visible:keyboard:before:h-0.5",
  left: "inset-y-3 left-0 w-2 cursor-ew-resize before:inset-y-0 before:left-0 before:w-px focus-visible:keyboard:before:w-0.5",
  corner: "left-0 top-0 size-3 cursor-nwse-resize before:left-0 before:top-0 before:size-1.5 before:rounded-[1px]",
};

const LINE_CLASS = "before:pointer-events-none before:absolute before:bg-transparent before:transition-colors before:content-[''] hover:before:bg-foreground-muted data-[dragging=true]:before:bg-foreground-muted focus-visible:keyboard:before:bg-foreground";

export function AssistantPanelResize({ size }: { size: PanelSize }) {
  const { formatMessage } = useIntl();
  const drag = useRef<{ id: number; edge: Edge; x: number; y: number; start: PanelSize } | null>(null);
  const [dragging, setDragging] = useState<Edge | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  /** The popover's own box: its bottom-right is where it is pinned, which sets how big it may get there. */
  const anchorRect = () => rootRef.current?.parentElement?.getBoundingClientRect() ?? null;
  const maxHere = () => {
    const rect = anchorRect();
    return rect && rect.width > 0 ? clampPanelSize({ width: Infinity, height: Infinity }, viewport(), rect) : panelMax(viewport());
  };
  const apply = useCallback((next: PanelSize) => {
    const rect = rootRef.current?.parentElement?.getBoundingClientRect() ?? null;
    setPanelSize(clampPanelSize(next, viewport(), rect && rect.width > 0 ? rect : null));
  }, []);

  const onPointerDown = (edge: Edge) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id: event.pointerId, edge, x: event.clientX, y: event.clientY, start: size };
    setDragging(edge);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    // Pinned at the bottom-right: up and to the left make it bigger.
    const dx = d.edge === "top" ? 0 : d.x - event.clientX;
    const dy = d.edge === "left" ? 0 : d.y - event.clientY;
    apply({ width: d.start.width + dx, height: d.start.height + dy });
  };
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current && event.pointerId === drag.current.id) {
      drag.current = null;
      setDragging(null);
    }
  };
  const onKeyDown = (edge: Edge) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const max = maxHere();
    const horizontal = edge !== "top";
    const vertical = edge !== "left";
    let next: PanelSize | null = null;
    if (horizontal && event.key === "ArrowLeft") next = { ...size, width: size.width + step };
    if (horizontal && event.key === "ArrowRight") next = { ...size, width: size.width - step };
    if (vertical && event.key === "ArrowUp") next = { ...size, height: size.height + step };
    if (vertical && event.key === "ArrowDown") next = { ...size, height: size.height - step };
    if (event.key === "Home") next = { width: horizontal ? PANEL_MIN.width : size.width, height: vertical ? PANEL_MIN.height : size.height };
    if (event.key === "End") next = { width: horizontal ? max.width : size.width, height: vertical ? max.height : size.height };
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    apply(next);
  };
  const reset = () => setPanelSize(null);

  const handle = (edge: Edge) => {
    const max = maxHere();
    const vertical = edge === "top";
    return (
      <div
        key={edge}
        role="separator"
        aria-label={formatMessage({ id: LABEL_ID[edge] })}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuenow={vertical ? size.height : size.width}
        aria-valuemin={vertical ? PANEL_MIN.height : PANEL_MIN.width}
        aria-valuemax={vertical ? max.height : max.width}
        tabIndex={0}
        data-testid={`assistant-panel-resize-${edge}`}
        data-dragging={dragging === edge ? "true" : undefined}
        className={`absolute z-sticky touch-none select-none outline-none ${LINE_CLASS} ${EDGE_CLASS[edge]}`}
        onPointerDown={onPointerDown(edge)}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onKeyDown={onKeyDown(edge)}
        onDoubleClick={reset}
      />
    );
  };
  // A zero-size marker: its parent is the popover, whose box the bounds are read from.
  return <><div ref={rootRef} hidden />{handle("top")}{handle("left")}{handle("corner")}</>;
}

