export type DevOverlayEdge = "top" | "right" | "bottom" | "left";

export interface DevOverlayPlacement {
  edge: DevOverlayEdge;
  ratio: number;
  collapsed: boolean;
}

export interface DevOverlayInsets { top: number; right: number; bottom: number; left: number; }
export interface DevOverlaySize { width: number; height: number; }
export interface DevOverlayRect extends DevOverlaySize { left: number; top: number; }
export interface DevOverlayPosition { left: number; top: number; }

export const DEFAULT_DEV_OVERLAY_PLACEMENT: DevOverlayPlacement = {
  edge: "right",
  ratio: 0.68,
  collapsed: false,
};
export const DEV_OVERLAY_EDGE_GUTTER = 8;
const EDGES: ReadonlyArray<DevOverlayEdge> = ["top", "right", "bottom", "left"];

function clampRatio(value: number): number { return Math.min(1, Math.max(0, value)); }
function axisRatio(value: number, minimum: number, maximum: number): number {
  const travel = maximum - minimum;
  return travel <= 0 ? 0.5 : clampRatio((value - minimum) / travel);
}
function getPositionBounds({ viewport, overlay, insets, gutter }: {
  viewport: DevOverlaySize;
  overlay: DevOverlaySize;
  insets: DevOverlayInsets;
  gutter: number;
}) {
  const minLeft = insets.left + gutter;
  const minTop = insets.top + gutter;
  return {
    minLeft,
    maxLeft: Math.max(minLeft, viewport.width - insets.right - gutter - overlay.width),
    minTop,
    maxTop: Math.max(minTop, viewport.height - insets.bottom - gutter - overlay.height),
  };
}

export function devOverlayPlacementToPosition({ placement, viewport, overlay, insets, gutter = DEV_OVERLAY_EDGE_GUTTER }: {
  placement: DevOverlayPlacement;
  viewport: DevOverlaySize;
  overlay: DevOverlaySize;
  insets: DevOverlayInsets;
  gutter?: number;
}): DevOverlayPosition {
  const bounds = getPositionBounds({ viewport, overlay, insets, gutter });
  const ratio = clampRatio(placement.ratio);
  const horizontalPosition = bounds.minLeft + (bounds.maxLeft - bounds.minLeft) * ratio;
  const verticalPosition = bounds.minTop + (bounds.maxTop - bounds.minTop) * ratio;
  switch (placement.edge) {
    case "top": return { left: horizontalPosition, top: bounds.minTop };
    case "right": return { left: bounds.maxLeft, top: verticalPosition };
    case "bottom": return { left: horizontalPosition, top: bounds.maxTop };
    case "left": return { left: bounds.minLeft, top: verticalPosition };
  }
}

export function snapDevOverlayToEdge({ rect, viewport, insets, gutter = DEV_OVERLAY_EDGE_GUTTER }: {
  rect: DevOverlayRect;
  viewport: DevOverlaySize;
  insets: DevOverlayInsets;
  gutter?: number;
}): DevOverlayPlacement {
  const bounds = getPositionBounds({ viewport, overlay: rect, insets, gutter });
  const distances: Record<DevOverlayEdge, number> = {
    top: Math.abs(rect.top - bounds.minTop),
    right: Math.abs(rect.left - bounds.maxLeft),
    bottom: Math.abs(rect.top - bounds.maxTop),
    left: Math.abs(rect.left - bounds.minLeft),
  };
  const edge = EDGES.reduce((nearest, candidate) => distances[candidate] < distances[nearest] ? candidate : nearest);
  const ratio = edge === "top" || edge === "bottom"
    ? axisRatio(rect.left, bounds.minLeft, bounds.maxLeft)
    : axisRatio(rect.top, bounds.minTop, bounds.maxTop);
  return { edge, ratio, collapsed: true };
}

export function parseDevOverlayPlacement(value: string | null): DevOverlayPlacement | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const edge = Reflect.get(parsed, "edge");
    const ratio = Reflect.get(parsed, "ratio");
    const collapsed = Reflect.get(parsed, "collapsed");
    if (!EDGES.includes(edge as DevOverlayEdge) || typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
    return {
      edge: edge as DevOverlayEdge,
      ratio: clampRatio(ratio),
      collapsed: typeof collapsed === "boolean" ? collapsed : false,
    };
  } catch { return null; }
}
