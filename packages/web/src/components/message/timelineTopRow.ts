import { useEffect } from "react";
import type { RefObject } from "react";
import { onBeforeReload } from "../../utils/reloadHolds";
import { forgetScroll, rememberScroll } from "./messageTimelineShared";

// The timeline's top row in the DOM (VirtualMessageTimeline): what scroll
// memory and the width anchor keep, and what is kept for a reload.

export function messageRowElements(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("[data-timeline-message-id]"));
}

// The first message row whose bottom is below the view's top, and where its
// top is, in px from the view's top.
export function topVisibleMessage(el: HTMLElement): { id: string; offset: number } | null {
  const top = el.getBoundingClientRect().top;
  for (const row of messageRowElements(el)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top + 1 && row.dataset.timelineMessageId) {
      return { id: row.dataset.timelineMessageId, offset: rect.top - top };
    }
  }
  return null;
}

// The spot as it is now, as a scroll by hand leaves it: the row at the top,
// or none while following the tail.
function keepSpot(key: string | undefined, following: boolean, el: HTMLElement | null): void {
  if (!key || !el) return;
  if (following) {
    forgetScroll(key);
    return;
  }
  const top = topVisibleMessage(el);
  if (top) rememberScroll(key, top.id);
}

/**
 * Right before this tab reloads itself onto a new Web release
 * (utils/reloadSafety): the spot is kept, so the reloaded page's initial
 * jump opens on the same row.
 */
export function useSpotBeforeReload(
  persistKeyRef: RefObject<string | undefined>,
  followRef: RefObject<boolean>,
  listEl: () => HTMLElement | null,
): void {
  useEffect(() => onBeforeReload(() => keepSpot(persistKeyRef.current, followRef.current, listEl())), [followRef, listEl, persistKeyRef]);
}
