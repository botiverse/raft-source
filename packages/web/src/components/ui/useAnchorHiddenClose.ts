import { useEffect, useLayoutEffect, useRef } from "react";
import type { ComponentProps } from "react";
import type { Popover, PopoverContentProps } from "@botiverse/raft-ui";

export const POINT_MENU_COLLISION_AVOIDANCE = {
  side: "shift",
  align: "shift",
  fallbackAxisSide: "none",
} as const;

export const TRIGGER_MENU_COLLISION_AVOIDANCE = {
  side: "flip",
  align: "shift",
  fallbackAxisSide: "none",
} as const;

type PopoverOpenChangeDetails = Parameters<NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>>[1];

/**
 * Prevents Base UI's internal `useDismiss` from swallowing Escape
 * (`preventDefault` / `stopPropagation`) or desyncing `PopoverStore` on outside
 * presses when the caller owns dismissal via `DismissBackdrop`,
 * `useShortcutLayer`, or iOS/touch phantom-click shields.
 */
export function cancelUnmanagedPopoverDismiss(next: boolean, details: PopoverOpenChangeDetails) {
  if (next) return;
  details.cancel();
  details.allowPropagation();
}

const REMOVAL_CONTAINER_SELECTOR = [
  "[data-virtual-timeline]",
  '[data-testid="message-scroller"]',
  '[data-testid="thread-message-scroller"]',
  '[data-slot="scroll-area-viewport"]',
  "nav",
  "aside",
  "main",
].join(", ");

function resolveAnchorTarget(
  anchor: PopoverContentProps["anchor"],
): Element | { contextElement?: Element } | null {
  if (!anchor) return null;
  if (typeof anchor === "function") return anchor();
  if ("current" in anchor) return anchor.current;
  return anchor;
}

function anchorContextElement(anchor: PopoverContentProps["anchor"]): Element | null {
  const resolved = resolveAnchorTarget(anchor);
  if (!resolved) return null;
  if (typeof (resolved as Element).nodeType === "number") return resolved as Element;
  const ctx = (resolved as { contextElement?: Element }).contextElement;
  return ctx && typeof ctx.nodeType === "number" ? ctx : null;
}

/**
 * Closes a controlled anchored popup if its anchor element detaches from the
 * document (observed immediately via `MutationObserver`, even without scroll or
 * resize) or, inside a real laid-out viewport, scrolls out of its clipping
 * region (`data-anchor-hidden` on the Base UI Positioner), preventing an
 * invisible menu from leaving a `DismissBackdrop` mounted over the page.
 */
export function useAnchorHiddenClose(
  popupNode: HTMLDivElement | null,
  anchor: PopoverContentProps["anchor"],
  onAnchorHidden?: () => void,
) {
  const onAnchorHiddenRef = useRef(onAnchorHidden);
  const enabled = Boolean(popupNode && onAnchorHidden);

  useLayoutEffect(() => {
    onAnchorHiddenRef.current = onAnchorHidden;
  }, [onAnchorHidden]);

  useEffect(() => {
    if (!popupNode || !enabled) return;
    const positioner = popupNode.parentElement;
    if (!positioner) return;

    let trackedElement = anchorContextElement(anchor);
    let dismissed = false;

    const dismiss = () => {
      if (dismissed || !onAnchorHiddenRef.current) return;
      dismissed = true;
      onAnchorHiddenRef.current();
    };

    const check = () => {
      if (dismissed) return;
      const currentElement = anchorContextElement(anchor);
      if (currentElement !== trackedElement) {
        trackedElement = currentElement;
      }
      if (trackedElement && !trackedElement.isConnected) {
        dismiss();
        return;
      }
      if (!positioner.hasAttribute("data-anchor-hidden")) return;
      // Only trust Floating UI's `data-anchor-hidden` when the document has a
      // real laid-out viewport (jsdom has 0x0 clientWidth/clientHeight and
      // marks every non-origin point hidden on mount).
      const docEl = positioner.ownerDocument.documentElement;
      if (docEl.clientWidth <= 0 || docEl.clientHeight <= 0) return;
      dismiss();
    };

    check();

    const positionerObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(check);
    positionerObserver?.observe(positioner, {
      attributes: true,
      attributeFilter: ["data-anchor-hidden", "data-open", "data-side"],
    });

    let removalObserver: MutationObserver | null = null;
    if (trackedElement && trackedElement.isConnected && typeof MutationObserver !== "undefined") {
      const container = trackedElement.closest(REMOVAL_CONTAINER_SELECTOR)
        ?? trackedElement.ownerDocument.body;
      if (container) {
        removalObserver = new MutationObserver(check);
        removalObserver.observe(container, { childList: true, subtree: true });
      }
    }

    const win = positioner.ownerDocument.defaultView;
    win?.addEventListener("scroll", check, { capture: true, passive: true });
    win?.addEventListener("resize", check);
    return () => {
      positionerObserver?.disconnect();
      removalObserver?.disconnect();
      win?.removeEventListener("scroll", check, true);
      win?.removeEventListener("resize", check);
    };
  }, [anchor, enabled, popupNode]);
}
