import { useCallback, useState } from "react";
import type { Ref } from "react";
import { Popover, PopoverContent } from "@botiverse/raft-ui";
import type { PopoverContentProps } from "@botiverse/raft-ui";
import {
  POINT_MENU_COLLISION_AVOIDANCE,
  cancelUnmanagedPopoverDismiss,
  useAnchorHiddenClose,
} from "./useAnchorHiddenClose";

const ANCHORED_MENU_BASE_CLASS =
  "flex min-w-60 flex-col gap-0 p-1 select-none [[data-anchor-hidden]_&]:invisible [[data-anchor-hidden]_&]:pointer-events-none";

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

export interface AnchoredMenuPopoverProps extends Omit<PopoverContentProps, "initialFocus" | "finalFocus"> {
  open: boolean;
  /** Called when the anchor detaches or scrolls out of its clipping container. */
  onAnchorHidden?: () => void;
  initialFocus?: PopoverContentProps["initialFocus"];
  finalFocus?: PopoverContentProps["finalFocus"];
}

/**
 * Shared floating menu surface built on raft-ui `Popover` + `PopoverContent`
 * with context-menu layout tokens (`role="menu"` and `8px` viewport collision
 * padding by default). Replaces hand-rolled `createPortal` menus so every
 * context menu and submenu gets live scroll/resize tracking, viewport and
 * frame-inset collision handling, and anchor-hidden cleanup.
 */
export function AnchoredMenuPopover({
  open,
  anchor,
  side = "right",
  align = "start",
  sideOffset = 0,
  collisionAvoidance = POINT_MENU_COLLISION_AVOIDANCE,
  collisionPadding = 8,
  role = "menu",
  initialFocus = false,
  finalFocus = false,
  onAnchorHidden,
  className,
  ref,
  children,
  ...rest
}: AnchoredMenuPopoverProps) {
  const [popupNode, setPopupNode] = useState<HTMLDivElement | null>(null);
  const mergedRef = useCallback((node: HTMLDivElement | null) => {
    setPopupNode(node);
    assignRef(ref, node);
  }, [ref]);

  useAnchorHiddenClose(popupNode, anchor, onAnchorHidden);

  return (
    <Popover open={open} modal={false} onOpenChange={cancelUnmanagedPopoverDismiss}>
      <PopoverContent
        ref={mergedRef}
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        role={role}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        className={className ? `${ANCHORED_MENU_BASE_CLASS} ${className}` : ANCHORED_MENU_BASE_CLASS}
        {...rest}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
