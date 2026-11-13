import { useCallback, useLayoutEffect, useState } from "react";
import type { Ref } from "react";

/**
 * #189 rule 6 (#proj-raft-ui:#189, the design lead's prototype `headModel`): a column's head always fits it. The title
 * ellipsizes; where the buttons don't fit, the column's own actions fold into ⋯, the last first, while ⋯, Expand and
 * Close never fold. ⋯ shows only with something in it. PanelAction is 32px, 4px apart (raft-design panel.md).
 */

export const HEAD_ACTION_WIDTH = 32;
export const HEAD_ACTION_GAP = 4;
/** The Agent followers button in a thread's or a task's head (up to three faces and the count). */
export const FOLLOWERS_HEAD_WIDTH = 64;
/** The title's least room before the actions fold (the prototype's 56; tabs in its place, 120). */
const TITLE_MIN = 56;
const TABS_MIN = 120;

export interface HeadFit {
  /** The head's width; 0 where it isn't measured yet (everything shows). */
  width: number;
  /** Buttons before the title (Back, a stacked section's fold chevron): 40px each, the head's start margin 13. */
  lead: number;
  /** Each of the column's own actions' width, in order (32 for a PanelAction; a row of faces wider). */
  own: readonly number[];
  /** The window controls shown: Expand and Close (0 to 2). */
  controls: number;
  /** What ⋯ holds besides folded actions (the column's own commands, Move Left / Move Right). */
  menuItems: number;
  /** Tabs stand in the title's place (rule 4). */
  tabs?: boolean;
  /** What else the head's content needs beside the title, at the least (an Artifact's readers in its meta line). */
  content?: number;
  /**
   * What else stands before the title, in px (the side window's switch chip and its separator, PanelHeadLead): room
   * the title and the buttons don't have. It never folds itself.
   */
  leadWidth?: number;
}

/** How many of the head's own actions show as buttons; the rest go into ⋯. */
export function shownOwnActions({ width, lead, own, controls, menuItems, tabs = false, content = 0, leadWidth = 0 }: HeadFit): number {
  if (width <= 0) return own.length;
  const room = width - (lead > 0 ? 13 : 20) - 13 - 40 * lead - leadWidth - (tabs ? TABS_MIN : TITLE_MIN) - content;
  for (let shown = own.length; shown > 0; shown -= 1) {
    const menu = menuItems + (own.length - shown) > 0 ? 1 : 0;
    const fixed = controls + menu;
    const need = own.slice(0, shown).reduce((total, w) => total + w, 0) + HEAD_ACTION_WIDTH * fixed + HEAD_ACTION_GAP * (shown + fixed - 1);
    if (need <= room) return shown;
  }
  return 0;
}

/** A head's width as it lays out (a ref callback and the width), measured again whenever it changes. */
export function useHeadWidth(): [(element: HTMLElement | null) => void, number, HTMLElement | null] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [element]);
  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);
  return [ref, width, element];
}

const assign = <T,>(ref: Ref<T> | undefined, node: T | null) => {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: T | null }).current = node;
};

/** Two refs as one, stable while they are (a head both measured and a drag's node). */
export function useMergedRef<T>(a: Ref<T> | undefined, b: Ref<T> | undefined): (node: T | null) => void {
  return useCallback((node: T | null) => {
    assign(a, node);
    assign(b, node);
  }, [a, b]);
}
