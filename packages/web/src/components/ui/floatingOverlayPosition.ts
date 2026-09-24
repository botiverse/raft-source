export const FLOATING_OVERLAY_VIEWPORT_PADDING = 8;

export interface FloatingOverlayPoint {
  x: number;
  y: number;
}

export interface FloatingOverlayViewport {
  width: number;
  height: number;
  offsetLeft?: number;
  offsetTop?: number;
}

export interface FloatingOverlaySize {
  width: number;
  height: number;
}

export interface FloatingOverlayPositionInput {
  anchor: FloatingOverlayPoint;
  floatingSize: FloatingOverlaySize;
  viewport: FloatingOverlayViewport;
  padding?: number;
}

export interface FloatingOverlayPosition {
  x: number;
  y: number;
  maxWidth: number;
  maxHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function placeAxis({
  anchor,
  size,
  viewportStart,
  viewportSize,
  padding,
}: {
  anchor: number;
  size: number;
  viewportStart: number;
  viewportSize: number;
  padding: number;
}): number {
  const min = viewportStart + padding;
  const max = viewportStart + viewportSize - size - padding;
  const viewportEnd = viewportStart + viewportSize;

  if (anchor + size <= viewportEnd - padding) {
    return clamp(anchor, min, max);
  }

  if (anchor - size >= min) {
    return anchor - size;
  }

  return clamp(anchor, min, max);
}

export function placeFloatingOverlay({
  anchor,
  floatingSize,
  viewport,
  padding = FLOATING_OVERLAY_VIEWPORT_PADDING,
}: FloatingOverlayPositionInput): FloatingOverlayPosition {
  const offsetLeft = viewport.offsetLeft ?? 0;
  const offsetTop = viewport.offsetTop ?? 0;
  const maxWidth = Math.max(0, viewport.width - padding * 2);
  const maxHeight = Math.max(0, viewport.height - padding * 2);
  const measuredWidth = Math.min(floatingSize.width, maxWidth);
  const measuredHeight = Math.min(floatingSize.height, maxHeight);

  return {
    x: placeAxis({
      anchor: anchor.x,
      size: measuredWidth,
      viewportStart: offsetLeft,
      viewportSize: viewport.width,
      padding,
    }),
    y: placeAxis({
      anchor: anchor.y,
      size: measuredHeight,
      viewportStart: offsetTop,
      viewportSize: viewport.height,
      padding,
    }),
    maxWidth,
    maxHeight,
  };
}

export function getFloatingOverlayViewport(): FloatingOverlayViewport {
  if (typeof window === "undefined") return { width: 0, height: 0 };

  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return {
      width: visualViewport.width,
      height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
    };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}
