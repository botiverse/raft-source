import { useEffect, useRef, useState } from "react";

/** Where a message row is relative to what the chat shows right now. */
export type MessagePlacement = "above" | "visible" | "below";

const NO_PLACEMENTS: ReadonlyMap<string, MessagePlacement> = new Map();
const NO_IDS: readonly string[] = [];
// A scroll with no `scrollend` (older WebKit) is placed once it pauses.
const SCROLL_SETTLE_MS = 120;

const MESSAGE_ROW_SELECTOR = "[data-timeline-message-id]";

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

type Bounds = { readonly top: number; readonly bottom: number };
/** Indexes (in the message order) of the first and last row the reader sees. */
export type MessageIndexRange = { readonly first: number; readonly last: number };

/**
 * Where a loaded message whose row is not mounted sits, from its index in the
 * message order: above the rows in view, below them, or among them (a message
 * folded into a row on screen, such as a collapsed system-message group).
 */
export function placeByIndex(index: number, inView: MessageIndexRange): MessagePlacement {
  if (index < inView.first) return "above";
  if (index > inView.last) return "below";
  return "visible";
}

/**
 * The placement of each of `ids`, from the rows mounted in the scroller
 * (`rows`: each row's message id and box) and, for a loaded message whose row
 * is not mounted (a virtual timeline mounts only the rows near the view), from
 * its index in `order` against the indexes of the rows in view. A message
 * that is neither mounted nor in `order` (not loaded) is left out; the caller
 * decides where it sits.
 */
export function computeMessagePlacements(
  ids: readonly string[],
  rows: readonly { id: string; top: number; bottom: number }[],
  bounds: Bounds,
  order: ReadonlyMap<string, number>,
): Map<string, MessagePlacement> {
  const boxById = new Map<string, { top: number; bottom: number }>();
  let inView: { first: number; last: number } | null = null;
  let mounted: { first: number; last: number } | null = null;
  const widen = (range: { first: number; last: number } | null, index: number) => (
    range ? { first: Math.min(range.first, index), last: Math.max(range.last, index) } : { first: index, last: index }
  );
  for (const row of rows) {
    boxById.set(row.id, row);
    const index = order.get(row.id);
    if (index === undefined) continue;
    mounted = widen(mounted, index);
    if (row.bottom > bounds.top && row.top < bounds.bottom) inView = widen(inView, index);
  }
  const range = inView ?? mounted;
  const placements = new Map<string, MessagePlacement>();
  for (const id of ids) {
    const box = boxById.get(id);
    if (box) {
      placements.set(id, box.bottom <= bounds.top ? "above" : box.top >= bounds.bottom ? "below" : "visible");
      continue;
    }
    const index = order.get(id);
    if (index !== undefined && range) placements.set(id, placeByIndex(index, range));
  }
  return placements;
}

function samePlacements(a: ReadonlyMap<string, MessagePlacement>, b: ReadonlyMap<string, MessagePlacement>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, placement] of a) if (b.get(id) !== placement) return false;
  return true;
}

/**
 * Placement of each message in `ids` relative to the chat's view.
 *
 * A mounted row is placed from its layout box. A loaded message whose row is
 * not mounted (the virtual timeline mounts only the rows near the view, so a
 * loaded message far from it has no row) is placed from its index in
 * `orderedIds`, the loaded messages in order, against the rows in view: never
 * from DOM presence. A message that is not loaded is absent from the map; the
 * caller decides where it sits.
 *
 * Placed when the rendered rows may have changed (`renderKey`: messages loaded
 * or added), when an IntersectionObserver on the mounted rows of `ids`
 * reports one entering or leaving the view, and whenever a scroll settles
 * (`scrollend`, or a pause in the scroll events where there is none): no
 * per-frame scroll work. Each time every message is placed again, so a row
 * that jumped from above the view to below it in one scroll (never reported
 * by the observer) points the right way too. The map keeps its identity while
 * nothing moved across the view.
 */
export function useMessagePlacement(
  ids: readonly string[],
  renderKey: string,
  orderedIds: readonly string[] = NO_IDS,
): ReadonlyMap<string, MessagePlacement> {
  const key = `${renderKey}#${ids.join("|")}`;
  const [placements, setPlacements] = useState<ReadonlyMap<string, MessagePlacement>>(NO_PLACEMENTS);
  const orderedIdsRef = useRef(orderedIds);
  orderedIdsRef.current = orderedIds;

  useEffect(() => {
    if (ids.length === 0) return;
    const order = new Map<string, number>();
    orderedIdsRef.current.forEach((id, index) => order.set(id, index));
    // The scroller of this chat's rows: the parent of a row of one of `ids`,
    // or of any row of the loaded messages (none of `ids` may be mounted).
    const findRow = (): HTMLElement | null => {
      for (const row of document.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)) {
        const id = row.dataset.timelineMessageId;
        if (id && (order.has(id) || ids.includes(id))) return row;
      }
      return null;
    };
    const firstRow = findRow();
    if (!firstRow) return;
    const root = scrollParent(firstRow);
    const container: ParentNode = root ?? document;
    const rootBounds = (): Bounds => root?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };

    const place = (bounds: Bounds = rootBounds()) => {
      const rows: { id: string; top: number; bottom: number }[] = [];
      for (const row of container.querySelectorAll<HTMLElement>(MESSAGE_ROW_SELECTOR)) {
        const id = row.dataset.timelineMessageId;
        if (!id) continue;
        const rect = row.getBoundingClientRect();
        rows.push({ id, top: rect.top, bottom: rect.bottom });
      }
      const next = computeMessagePlacements(ids, rows, bounds, order);
      setPlacements((previous) => (samePlacements(previous, next) ? previous : next));
    };

    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        place();
      }, SCROLL_SETTLE_MS);
    };
    const onScrollEnd = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
      place();
    };
    const scrollTarget: HTMLElement | Document = root ?? document;
    scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    scrollTarget.addEventListener("scrollend", onScrollEnd, { passive: true });
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        place(entries[0]?.rootBounds ?? rootBounds());
      }, { root, threshold: 0 });
      for (const id of ids) {
        const row = container.querySelector<HTMLElement>(`[data-timeline-message-id="${CSS.escape(id)}"]`);
        if (row) observer.observe(row);
      }
    }
    place();
    return () => {
      observer?.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      scrollTarget.removeEventListener("scroll", onScroll);
      scrollTarget.removeEventListener("scrollend", onScrollEnd);
    };
    // `key` stands for ids and renderKey (which changes with the loaded messages).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return placements;
}
