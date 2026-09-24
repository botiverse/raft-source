import {
  FLOATING_OVERLAY_VIEWPORT_PADDING,
  getFloatingOverlayViewport,
  placeFloatingOverlay,
} from "./floatingOverlayPosition";
import type {
  FloatingOverlayViewport,
} from "./floatingOverlayPosition";

export const CONTEXT_MENU_VIEWPORT_MARGIN = FLOATING_OVERLAY_VIEWPORT_PADDING;

export type ContextMenuViewport = FloatingOverlayViewport;

export interface ContextMenuPlacement {
  x: number;
  y: number;
  maxWidth: number;
  maxHeight: number;
}

export function placeContextMenu({
  x,
  y,
  width,
  height,
  viewport = getFloatingOverlayViewport(),
  margin = CONTEXT_MENU_VIEWPORT_MARGIN,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport?: ContextMenuViewport;
  margin?: number;
}): ContextMenuPlacement {
  return placeFloatingOverlay({
    anchor: { x, y },
    floatingSize: { width, height },
    viewport,
    padding: margin,
  });
}
