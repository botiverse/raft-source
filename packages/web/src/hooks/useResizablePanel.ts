import { useState, useRef, useCallback, useEffect } from "react";

interface ResizablePanelOptions {
  /** localStorage key for persistence */
  storageKey: string;
  /** Minimum allowed width in px */
  min: number;
  /** Maximum allowed width in px */
  max: number;
  /** Default width when no stored value */
  defaultWidth: number;
  /** Direction of resize drag: "right" means dragging right increases width (sidebar), "left" means dragging left increases width (thread panel) */
  direction?: "right" | "left";
  /** Optional live measurement for CSS-clamped panels whose visible width can differ from persisted width. */
  getDragStartWidth?: (event: React.PointerEvent) => number | null | undefined;
}

export function useResizablePanel({
  storageKey,
  min,
  max,
  defaultWidth,
  direction = "right",
  getDragStartWidth,
}: ResizablePanelOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v) { const n = Number(v); if (n >= min && n <= max) return n; }
    } catch {}
    return defaultWidth;
  });

  const widthRef = useRef(width);
  widthRef.current = width;

  // Clamp width when min/max bounds change (e.g., window resize). Functional
  // updater reads previous `width` and constrains it to the new bounds — NOT
  // a mirror-prop pattern (width is user-controlled via the drag handle, and
  // the localStorage initializer seeds it on mount). Same stale-cleanup
  // family as MachineDetailPanel's selectedAgentIds reconcile.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-derived-state
    setWidth((w) => Math.max(min, Math.min(max, w)));
  }, [min, max]);

  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    startXRef.current = e.clientX;
    const measuredStartWidth = getDragStartWidth?.(e);
    const startWidth = typeof measuredStartWidth === "number" && Number.isFinite(measuredStartWidth)
      ? measuredStartWidth
      : widthRef.current;
    startWidthRef.current = Math.max(min, Math.min(max, startWidth));
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [getDragStartWidth, min, max]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const delta = direction === "right"
      ? e.clientX - startXRef.current
      : startXRef.current - e.clientX;
    setWidth(Math.max(min, Math.min(max, startWidthRef.current + delta)));
  }, [min, max, direction]);

  const handleResizeEnd = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    try { localStorage.setItem(storageKey, String(widthRef.current)); } catch {}
  }, [storageKey]);

  return {
    width,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
  };
}
