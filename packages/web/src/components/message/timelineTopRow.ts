import { useEffect } from "react";
import type { RefObject } from "react";
import { onBeforeReload } from "../../utils/reloadHolds";
import { forgetScroll, rememberScroll } from "./messageTimelineShared";

// The timeline's top row in the DOM (VirtualMessageTimeline): what scroll
// memory and the width anchor keep, and what is kept for a reload.

export function messageRowElements(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("[data-timeline-message-id]"));
}

export interface TimelineTopAnchor {
  id: string;
  offset: number;
  /** When the top row starts above the viewport, the first block inside it at/below the top edge. */
  sub?: HTMLElement | null;
  subOffset?: number;
}

const SUB_ANCHOR_SELECTOR = "li, p, pre, blockquote, table, h1, h2, h3, h4, hr, [data-card], img";

// The first message row whose bottom is below the view's top, and where its
// top is, in px from the view's top (plus the first visible inner block when
// the row itself starts above the view, so off-screen reflow above the top
// edge does not push the visible lines down).
export function topVisibleMessage(el: HTMLElement): TimelineTopAnchor | null {
  const viewRect = el.getBoundingClientRect();
  const top = viewRect.top;
  const maxSubTop = top + Math.min(120, Math.max(48, viewRect.height / 3));
  for (const row of messageRowElements(el)) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > top + 1 && row.dataset.timelineMessageId) {
      const offset = rect.top - top;
      if (offset < -4) {
        for (const sub of Array.from(row.querySelectorAll<HTMLElement>(SUB_ANCHOR_SELECTOR))) {
          if (sub.querySelector(SUB_ANCHOR_SELECTOR)) continue;
          const subRect = sub.getBoundingClientRect();
          if (subRect.height <= 0) continue;
          if (subRect.top < top - 4 && subRect.bottom > maxSubTop) break;
          if (subRect.top >= top - 4 && subRect.top <= maxSubTop && subRect.top < rect.bottom) {
            return { id: row.dataset.timelineMessageId, offset, sub, subOffset: subRect.top - top };
          }
        }
      }
      return { id: row.dataset.timelineMessageId, offset };
    }
  }
  return null;
}

export function topAnchorDelta(el: HTMLElement, row: HTMLElement, anchor: TimelineTopAnchor): number {
  const viewTop = el.getBoundingClientRect().top;
  if (anchor.sub && anchor.subOffset !== undefined && row.contains(anchor.sub)) {
    return anchor.sub.getBoundingClientRect().top - viewTop - anchor.subOffset;
  }
  return row.getBoundingClientRect().top - viewTop - anchor.offset;
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
