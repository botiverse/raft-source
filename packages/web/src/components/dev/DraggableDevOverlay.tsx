import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { Popover, PopoverContent, PopoverTrigger } from "raft-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, SyntheticEvent } from "react";
import {
  DEFAULT_DEV_OVERLAY_PLACEMENT,
  devOverlayPlacementToPosition,
  parseDevOverlayPlacement,
  snapDevOverlayToEdge,
} from "./devOverlayPosition";
import type { DevOverlayInsets, DevOverlayPlacement, DevOverlaySize } from "./devOverlayPosition";

const MOBILE_TAB_BAR_CLEARANCE = 56;

interface DraggableDevOverlayProps {
  children: ReactNode;
  className?: string;
  containerIsHandle?: boolean;
  defaultPlacement?: DevOverlayPlacement;
  handleSelector?: string;
  id: string;
  panel?: ReactNode;
  collapsedChildren?: ReactNode;
  collapsible?: boolean;
  testId?: string;
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ViewportGeometry {
  insets: DevOverlayInsets;
  viewport: DevOverlaySize;
}

export function getDevOverlayStorageKey(id: string): string {
  return `raft:dev-overlay:${id}:placement-v1`;
}

function readPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readViewportGeometry(): ViewportGeometry {
  const visualViewport = window.visualViewport;
  const viewport = {
    width: visualViewport?.width ?? window.innerWidth,
    height: visualViewport?.height ?? window.innerHeight,
  };
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    paddingTop: "env(safe-area-inset-top, 0px)",
    paddingRight: "env(safe-area-inset-right, 0px)",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    paddingLeft: "env(safe-area-inset-left, 0px)",
  });
  document.body.appendChild(probe);
  const style = window.getComputedStyle(probe);
  const mobileClearance = (window.matchMedia?.("(max-width: 767px)").matches
    ?? viewport.width <= 767)
    ? MOBILE_TAB_BAR_CLEARANCE
    : 0;
  const insets = {
    top: readPixelValue(style.paddingTop),
    right: readPixelValue(style.paddingRight),
    bottom: readPixelValue(style.paddingBottom) + mobileClearance,
    left: readPixelValue(style.paddingLeft),
  };
  probe.remove();
  return { insets, viewport };
}

function readStoredPlacement(id: string): DevOverlayPlacement | null {
  try {
    return parseDevOverlayPlacement(localStorage.getItem(getDevOverlayStorageKey(id)));
  } catch {
    return null;
  }
}

function DraggableDevOverlayNode({
  children,
  collapsedChildren,
  className,
  collapsible,
  containerIsHandle,
  handleSelector,
  id,
  onOpenChange,
  open: controlledOpen,
  panel,
  placement,
  onPlacementChange,
  testId,
  title,
}: DraggableDevOverlayProps & {
  placement: DevOverlayPlacement;
  onPlacementChange: (placement: DevOverlayPlacement) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<ViewportGeometry | null>(null);
  const [overlaySize, setOverlaySize] = useState<DevOverlaySize | null>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const { attributes, isDragging, listeners, setNodeRef, transform } = useDraggable({ id });
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);

  const setContainerRef = useCallback((element: HTMLDivElement | null) => {
    containerRef.current = element;
    setNodeRef(element);
  }, [setNodeRef]);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setOverlaySize({ width: rect.width, height: rect.height });
    setGeometry(readViewportGeometry());
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const onViewportChange = () => measure();
    window.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("resize", onViewportChange);
    window.visualViewport?.addEventListener("scroll", onViewportChange, { passive: true });
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("resize", onViewportChange);
      window.visualViewport?.removeEventListener("scroll", onViewportChange);
    };
  }, [measure]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const handleListeners = handleSelector
    ? Object.fromEntries(
        Object.entries(listeners ?? {}).map(([eventName, listener]) => [
          eventName,
          (event: SyntheticEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest(handleSelector)) listener(event);
          },
        ]),
      )
    : listeners;
  const position = geometry && overlaySize
    ? devOverlayPlacementToPosition({ placement, viewport: geometry.viewport, overlay: overlaySize, insets: geometry.insets })
    : null;
  const style: CSSProperties = {
    left: (position?.left ?? 0) + (transform?.x ?? 0),
    top: (position?.top ?? 0) + (transform?.y ?? 0),
    transition: isDragging ? undefined : "left 160ms ease-out, top 160ms ease-out",
    visibility: position ? "visible" : "hidden",
    willChange: isDragging ? "left, top" : undefined,
  };
  const popoverSide = placement.edge === "left" ? "right" : placement.edge === "right" ? "left" : placement.edge === "top" ? "bottom" : "top";
  const trigger = (
    <div
      ref={setContainerRef}
      style={style}
      {...(containerIsHandle ? attributes : {})}
      {...(containerIsHandle || handleSelector ? handleListeners : {})}
      className={className}
      data-dragging={isDragging ? "true" : "false"}
      data-dev-overlay-edge={placement.edge}
      data-dev-overlay-collapsed={placement.collapsed ? "true" : "false"}
      data-testid={testId}
      title={title}
      tabIndex={collapsible && placement.collapsed ? 0 : undefined}
      role={collapsible && placement.collapsed ? "button" : undefined}
      aria-label={collapsible && placement.collapsed ? title : undefined}
      onClickCapture={(event) => {
        if (!collapsible || !placement.collapsed) return;
        event.preventDefault();
        event.stopPropagation();
        const expanded = { ...placement, collapsed: false };
        onPlacementChange(expanded);
        setPlacementPersisted(id, expanded);
        setOpen(true);
      }}
      onKeyDown={(event) => {
        if (!collapsible || !placement.collapsed || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        const expanded = { ...placement, collapsed: false };
        onPlacementChange(expanded);
        setPlacementPersisted(id, expanded);
        setOpen(true);
      }}
    >
      {collapsible && placement.collapsed ? (collapsedChildren ?? children) : children}
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger nativeButton={false} render={trigger} />
      {panel ? (
        <PopoverContent
          side={popoverSide}
          align="center"
          sideOffset={8}
          disableAnchorTracking={false}
          className="z-40 max-h-[min(80vh,40rem)] max-w-[calc(100vw-1rem)] overflow-y-auto p-0"
          data-testid={`${testId ?? id}-popover`}
        >
          {panel}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

function setPlacementPersisted(id: string, placement: DevOverlayPlacement): void {
  try {
    localStorage.setItem(getDevOverlayStorageKey(id), JSON.stringify(placement));
  } catch {
    // Keep the in-memory interaction available when storage is unavailable.
  }
}

export default function DraggableDevOverlay({
  defaultPlacement = DEFAULT_DEV_OVERLAY_PLACEMENT,
  ...props
}: DraggableDevOverlayProps) {
  const { id, onOpenChange, collapsible } = props;
  const [placement, setPlacement] = useState<DevOverlayPlacement>(() => readStoredPlacement(props.id) ?? defaultPlacement);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const finishDrag = useCallback((event: DragEndEvent) => {
    const initialRect = event.active.rect.current.initial;
    const translatedRect = event.active.rect.current.translated;
    const rect = translatedRect ?? (initialRect
      ? { ...initialRect, left: initialRect.left + event.delta.x, top: initialRect.top + event.delta.y }
      : null);
    if (!rect) return;
    const geometry = readViewportGeometry();
    const nextPlacement = {
      ...snapDevOverlayToEdge({
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport: geometry.viewport,
        insets: geometry.insets,
      }),
      collapsed: Boolean(collapsible),
    };
    setPlacement(nextPlacement);
    setPlacementPersisted(id, nextPlacement);
    onOpenChange?.(false);
  }, [collapsible, id, onOpenChange]);

  return (
    <DndContext sensors={sensors} onDragEnd={finishDrag}>
      <DraggableDevOverlayNode
        {...props}
        placement={placement}
        onPlacementChange={setPlacement}
      />
    </DndContext>
  );
}
