// The top bar's search field takes the room the two side regions leave over
// (task #773). The field is centred on the window and its two side regions
// hold content in whole steps (the workspace strip adds an avatar only when a
// whole slot fits), so some room is always left between a region's content and
// the field. Left as blank, its size depends on the window width and the
// workspace count, which reads as a gap nobody meant. The field is the bar's
// one element that can grow, so it grows into that room, both sides at once so
// it stays centred, up to its own maximum. A region's content then always ends
// at the region's own inner edge: the same 8px before the field on both sides.

import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

/** raft-ui SearchTrigger's own width: clamp(360px, 32vw, 520px). */
const SEARCH_MIN_PX = 360;
const SEARCH_VW = 0.32;
export const SEARCH_MAX_PX = 520;

/** The field's width before it takes any room: raft-ui's clamp for this window. */
export function searchBaseWidth(viewportPx: number): number {
  return Math.min(SEARCH_MAX_PX, Math.max(SEARCH_MIN_PX, viewportPx * SEARCH_VW));
}

/**
 * The field's width given each side's left-over room measured at `currentPx`.
 * Measured room shrinks by half of whatever the field already took, so the
 * result is computed back from the base width and stays the same however many
 * times it is measured.
 */
export function elasticSearchWidth(basePx: number, currentPx: number, leadingRoomPx: number, trailingRoomPx: number): number {
  const taken = (currentPx - basePx) / 2;
  const room = Math.max(0, Math.min(leadingRoomPx, trailingRoomPx) + taken);
  return Math.min(Math.max(basePx, SEARCH_MAX_PX), basePx + 2 * Math.floor(room));
}

function innerEdges(region: HTMLElement) {
  const rect = region.getBoundingClientRect();
  const style = getComputedStyle(region);
  return {
    left: rect.left + (Number.parseFloat(style.paddingLeft) || 0),
    right: rect.right - (Number.parseFloat(style.paddingRight) || 0),
  };
}

/**
 * Room in the region that no content uses: its inner width less its items and
 * the gaps between them. Counted this way, not from where the items sit, so an
 * item pushed to the far edge (the history controls, ml-auto) does not hide the
 * room before it. Only items in the row count: an open popover's trigger gets
 * two 1px `position: fixed` focus guards beside it, which take no room.
 */
export function leftOverRoom(innerWidth: number, items: { width: number; inFlow: boolean }[], gap: number): number {
  const widths = items.filter((item) => item.inFlow && item.width > 0).map((item) => item.width);
  return innerWidth - widths.reduce((sum, w) => sum + w, 0) - gap * Math.max(0, widths.length - 1);
}

function rowItems(region: HTMLElement) {
  return [...region.children].map((c) => {
    const position = getComputedStyle(c).position;
    const rect = c.getBoundingClientRect();
    return { width: rect.width, left: rect.left, inFlow: position !== "fixed" && position !== "absolute" };
  });
}

function leftOver(region: HTMLElement): number {
  const edges = innerEdges(region);
  const gap = Number.parseFloat(getComputedStyle(region).columnGap) || 0;
  return leftOverRoom(edges.right - edges.left, rowItems(region), gap);
}

/** The theme's top strip (raft-ui `frame-decor-top`), and the air it keeps on each side. */
export const DECOR_TOP_STRIP_PX = 190;
export const DECOR_TOP_GAP_PX = 16;

/** Where the strip goes: see frameDecorTop. */
export interface FrameDecorTop {
  /** --frame-decor-top-end: from the strip's right end to the bar's edge inside the safe area. */
  endPx: number;
  /** The whole strip, with its gap on both sides, fits between the field and the actions. */
  fits: boolean;
}

/**
 * The theme's strip sits in the empty room between the search field and the
 * trailing actions, 16px clear of each, or not at all: never half a strip
 * under the field or the actions. `regionRightPx` is the trailing region's
 * right edge, the bar's edge inside any reserved corner (the desktop's
 * caption buttons pad the bar, and raft-ui adds --raft-frame-inset-end on top
 * of this, so it is not counted here); `actionsLeftPx` the left edge of the
 * region's first item; `searchRightPx` the field's right edge.
 */
export function frameDecorTop(regionRightPx: number, actionsLeftPx: number, searchRightPx: number): FrameDecorTop {
  return {
    endPx: Math.ceil(regionRightPx - actionsLeftPx) + DECOR_TOP_GAP_PX,
    fits: actionsLeftPx - searchRightPx >= DECOR_TOP_STRIP_PX + 2 * DECOR_TOP_GAP_PX,
  };
}

/** The left edge of the region's first item in the row, or its inner right edge when it has none. */
function actionsLeft(region: HTMLElement): number {
  const lefts = rowItems(region).filter((item) => item.inFlow && item.width > 0).map((item) => item.left);
  return lefts.length > 0 ? Math.min(...lefts) : innerEdges(region).right;
}

export interface ElasticSearchLayout {
  /** Width for the search field. */
  width: number;
  /** Where the theme's top strip goes once the field has that width. */
  decorTop: FrameDecorTop;
  /**
   * The trailing region's room with the field at its base width: what its
   * items leave over, plus what the field took beyond its base on this side.
   * Negative when they run over the field's base (TopBarTrailingRoomContext).
   * Null without layout (the field has no width: jsdom, a hidden bar).
   */
  trailingRoom: number | null;
}

/** The trailing region's room with the field at its base width (see ElasticSearchLayout.trailingRoom). */
export function trailingRoomAtBase(trailingLeftOverPx: number, fieldPx: number, basePx: number): number {
  return Math.floor(trailingLeftOverPx + (fieldPx - basePx) / 2);
}

/** The search field's width and the top strip's place, or undefined before the first measurement. */
export function useElasticSearch(
  searchRef: RefObject<HTMLElement | null>,
  leadingRef: RefObject<HTMLElement | null>,
  trailingRef: RefObject<HTMLElement | null>,
): ElasticSearchLayout | undefined {
  const [layout, setLayout] = useState<ElasticSearchLayout | undefined>(undefined);
  useLayoutEffect(() => {
    const search = searchRef.current;
    const leading = leadingRef.current;
    const trailing = trailingRef.current;
    if (!search || !leading || !trailing) return;
    const measure = () => {
      const base = searchBaseWidth(window.innerWidth);
      const field = search.getBoundingClientRect();
      const trailingRoomNow = leftOver(trailing);
      const next = elasticSearchWidth(base, field.width, leftOver(leading), trailingRoomNow);
      // The field grows or shrinks on both sides at once: its right edge
      // moves by half the change, the trailing actions stay where they are.
      const decorTop = frameDecorTop(trailing.getBoundingClientRect().right, actionsLeft(trailing), field.right + (next - field.width) / 2);
      const trailingRoom = field.width > 0 ? trailingRoomAtBase(trailingRoomNow, field.width, base) : null;
      setLayout((prev) => (
        prev && prev.width === next && prev.decorTop.endPx === decorTop.endPx && prev.decorTop.fits === decorTop.fits && prev.trailingRoom === trailingRoom
          ? prev
          : { width: next, decorTop, trailingRoom }
      ));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    // A region's items come and go after mount (the desktop's Update button
    // appears once an update is downloaded). The region keeps its size then,
    // so only the item list says the room changed: observe every current item
    // and measure again whenever the list changes.
    const observeItems = () => {
      ro?.disconnect();
      ro?.observe(leading);
      ro?.observe(trailing);
      for (const child of [...leading.children, ...trailing.children]) ro?.observe(child);
    };
    observeItems();
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { observeItems(); measure(); });
    mo?.observe(leading, { childList: true });
    mo?.observe(trailing, { childList: true });
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); mo?.disconnect(); window.removeEventListener("resize", measure); };
  }, [searchRef, leadingRef, trailingRef]);
  return layout;
}
