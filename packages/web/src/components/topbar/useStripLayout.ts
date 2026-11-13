// Where the workspace strip starts and how much room it has (task #140). Kept
// apart from the strip so the top bar can size the name slot with it.

import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { STRIP_BUTTON_PX, STRIP_GAP_PX, stripFreePx } from "./workspaceStripLayout";
import { searchBaseWidth } from "./useElasticSearch";

/** The current-name text cap while the strip shows (AppTopBar's max-w). */
export const NAME_MAX_PX = 120;
/**
 * Fallback chrome around the name (no button to measure, e.g. jsdom): the
 * raft-ui WorkspaceButton's padding (10 each side) + the avatar (27) + the
 * gap before the name (8) + the chevron (16) after a 4px gap.
 */
export const NAME_CHROME_PX = 10 + 27 + 8 + 4 + 16 + 10;
/**
 * The public-page globe after a name, inside the name's cap: the button's
 * 8px gap plus the 13px glyph (PublicPageGlobe).
 */
export const NAME_GLOBE_PX = 8 + 13;

/**
 * The widest label in the list: each name's text width, plus the globe for a
 * public workspace. A function of the list alone, so the slot it sizes is the
 * same whichever workspace is current.
 */
export function widestLabelPx(names: readonly StripLayoutName[], textPx: (text: string) => number): number {
  let widest = 0;
  for (const entry of names) {
    widest = Math.max(widest, Math.ceil(textPx(entry.name)) + (entry.publicPageLive ? NAME_GLOBE_PX : 0));
  }
  return widest;
}

/** One workspace as the name slot sees it. */
export interface StripLayoutName {
  name: string;
  /** Its name carries the public-page globe. */
  publicPageLive: boolean;
}

/**
 * The narrowest the switcher may get: everything in it but the server name's
 * text, the one part that truncates. raft-ui's WorkspaceButton is `min-w-0
 * shrink` and centres its content, so a button squeezed below this overflows
 * on both sides: in the desktop title bar the avatar slid left under the macOS
 * traffic lights and the chevron right into ‹ › (task #161). `boxPx` is the
 * button's horizontal padding and border, `partsPx` the outer widths of the
 * parts that do not truncate (avatar, chevron, and inside the label the
 * public-page globe; margins included), `gapsPx` the gaps between items (the
 * name among them, even when it shows none).
 */
export function switcherFloorPx({ boxPx, partsPx, gapsPx }: { boxPx: number; partsPx: readonly number[]; gapsPx: number }): number {
  return Math.ceil(boxPx + partsPx.reduce((sum, w) => sum + w, 0) + gapsPx);
}

const shown = (el: Element) => getComputedStyle(el).display !== "none";
const px = (v: string) => Number.parseFloat(v) || 0;
const outerWidth = (el: Element) => {
  const s = getComputedStyle(el);
  return el.getBoundingClientRect().width + px(s.marginLeft) + px(s.marginRight);
};

/**
 * `label` is the capped group (`data-workspace-name`): the name's text and,
 * on a public workspace, the globe after it. The group shrinks, but only its
 * text truncates: the globe is `shrink-0` and the group does not clip, so the
 * globe and its gap count once, inside the group, and the group itself only
 * for its gaps in the button. `publicPageLive` is the fallback's globe.
 */
function measureSwitcherFloor(button: HTMLElement, label: HTMLElement | null, publicPageLive: boolean): number {
  const box = getComputedStyle(button);
  const content = button.querySelector<HTMLElement>(":scope > [data-slot=button-content]") ?? button;
  // Elements, not just HTML ones: the chevron is an <svg>.
  const items = [...content.children].filter(shown);
  const partsPx = items.filter((c) => c !== label).map(outerWidth);
  let gapsPx = px(getComputedStyle(content).columnGap) * Math.max(0, items.length - 1);
  if (label) {
    const inner = [...label.children].filter(shown);
    const text = label.querySelector("[data-slot='workspace-button-name']");
    partsPx.push(...inner.filter((c) => c !== text).map(outerWidth));
    gapsPx += px(getComputedStyle(label).columnGap) * Math.max(0, inner.length - 1);
  }
  const floor = switcherFloorPx({
    boxPx: px(box.paddingLeft) + px(box.paddingRight) + px(box.borderLeftWidth) + px(box.borderRightWidth),
    partsPx,
    gapsPx,
  });
  // No layout (jsdom): the documented chrome, plus the globe on a public workspace.
  return floor > 0 && partsPx.some((w) => w > 0) ? floor : NAME_CHROME_PX + (publicPageLive ? NAME_GLOBE_PX : 0);
}

/**
 * Layout of the name + strip, as a function of the workspace LIST only (never
 * of which workspace is current), so switching moves nothing: the name slot is
 * as wide as the longest name (capped at NAME_MAX_PX), and the strip starts
 * after that slot, so no avatar shifts when the current workspace changes.
 *
 * `free`: width the avatars may use between the slot's end and the history
 * controls (see stripFreePx). `slotPx`: width reserved for the name button
 * while the strip shows. `floorPx`: the switcher's narrowest width (see
 * switcherFloorPx). `avatarSlotPx`: one strip avatar and its gap, as rendered
 * (the region's slot probe, WorkspaceStripSlotProbe).
 */
export function useStripLayout(nameRef: RefObject<HTMLElement | null>, names: readonly StripLayoutName[], searchRef?: RefObject<HTMLElement | null>): { free: number; slotPx: number; floorPx: number; avatarSlotPx: number } {
  const [layout, setLayout] = useState({ free: 0, slotPx: 0, floorPx: NAME_CHROME_PX, avatarSlotPx: STRIP_BUTTON_PX + STRIP_GAP_PX });
  // A public workspace's label is its name plus the globe; both are facts of
  // the list, so the slot still never depends on which workspace is current.
  const namesKey = names.map((n) => `${n.publicPageLive ? "1" : "0"}${n.name}`).join("\n");
  const namesRef = useRef(names);
  namesRef.current = names;
  useLayoutEffect(() => {
    const name = nameRef.current;
    const region = name?.parentElement;
    if (!name || !region) return;
    const ctx = document.createElement("canvas").getContext("2d");
    const probe = region.querySelector<HTMLElement>("[data-strip-slot-probe]");
    const measure = () => {
      // The label is the capped group: the name and, on a public workspace,
      // its globe.
      const label = name.querySelector<HTMLElement>("[data-workspace-name]");
      const text = label?.querySelector<HTMLElement>("[data-slot='workspace-button-name']") ?? label;
      let widest = label ? label.scrollWidth : 0;
      if (ctx && text) {
        ctx.font = getComputedStyle(text).font;
        widest = Math.max(widest, widestLabelPx(namesRef.current, (t) => ctx.measureText(t).width));
      }
      const nameSlotPx = Math.min(NAME_MAX_PX, widest);
      // The button's chrome around the text: everything in the raft-ui
      // WorkspaceButton but the name (padding, border, avatar, gaps, chevron).
      // The button has one shape whether the strip shows or not (avatar, name,
      // chevron), so measuring the live button gives the same answer in both
      // states and the strip can't flicker at the threshold (Josh, #110).
      const button = label?.closest("button");
      let chromePx = NAME_CHROME_PX;
      if (button && label) {
        chromePx = Math.ceil(button.getBoundingClientRect().width - label.getBoundingClientRect().width);
      }
      const slotRight = name.getBoundingClientRect().left + chromePx + nameSlotPx;
      // The history controls are the region's last item (ml-auto). Use the
      // region's right edge minus their width, NOT their current position:
      // when a resize leaves the old (wider) strip overflowing, the controls
      // get pushed against it, so their position depended on the strip itself
      // and one resize could hide the strip and bring it back (Josh, #110).
      const history = region.querySelector<HTMLElement>("[data-topbar-leading-end]");
      // The region's own right padding is not room for avatars (the web bar
      // pads the region; the desktop title bar does not).
      const regionPaddingRight = Number.parseFloat(getComputedStyle(region).paddingRight) || 0;
      // The search field grows into what the strip leaves (useElasticSearch),
      // which pulls this region's edge in by half of its growth. Count from
      // the field's base width, or the strip would shrink to make room for a
      // field that only grew because the strip left room.
      const search = searchRef?.current;
      const taken = search ? Math.max(0, (search.getBoundingClientRect().width - searchBaseWidth(window.innerWidth)) / 2) : 0;
      const limit = region.getBoundingClientRect().right + taken - regionPaddingRight - (history ? history.getBoundingClientRect().width : 0);
      const free = stripFreePx(limit - slotRight);
      const slotPx = chromePx + nameSlotPx;
      const live = label?.querySelector("[data-testid='public-page-globe']") != null;
      const floorPx = button ? measureSwitcherFloor(button, label, live) : NAME_CHROME_PX;
      // The avatar's width as raft-ui renders it at this density (32 by
      // touch, 34 with a mouse); counting a fixed 32 let a strip that only
      // fit 32px avatars push ‹ › past their region.
      const avatarSlotPx = (probe?.getBoundingClientRect().width || STRIP_BUTTON_PX) + STRIP_GAP_PX;
      setLayout((prev) => (prev.free === free && prev.slotPx === slotPx && prev.floorPx === floorPx && prev.avatarSlotPx === avatarSlotPx ? prev : { free, slotPx, floorPx, avatarSlotPx }));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(region);
    ro?.observe(name);
    if (probe) ro?.observe(probe);
    window.addEventListener("resize", measure);
    // Canvas measures with whatever font is loaded; re-measure once the display font arrives.
    void document.fonts?.ready.then(measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, [nameRef, namesKey, searchRef]);
  return layout;
}
