import { HEAD_ACTION_GAP, HEAD_ACTION_WIDTH } from "../../components/layout/appPanelHead";
import type { BrowserTab } from "./browserTabsStore";

/**
 * How the built-in browser's tab row gives way as its column narrows
 * (raft-design panel.md, "A head fits its column"; the order is the switch
 * chip's design, 2026-11): the tabs behind narrow first, down to a slot that
 * still shows an icon and a few letters; then the Artifact chip's title
 * shortens and, under a few letters' room, goes (its icon stays); then the
 * tabs that no longer fit go under More tabs. The tab in front keeps its
 * title at every width, and the chip itself, New tab, Expand and Close never
 * fold. The numbers are the drawn parts' widths at desktop sizes.
 */

/** The head's edge margin once a bar button's icon inset is pulled out (headFit's 13). */
const EDGE = 13;
/** The Artifact chip's title: 132px at most; under 48px (a few letters) it goes and the icon stays. */
export const CHIP_TITLE_MAX = 132;
export const CHIP_TITLE_MIN = 48;
/** The Artifact chip around its title: icon, gap and padding. */
const CHIP_PAD = 34;
/** The line after the chip: 1px, 4px on each side, and the row's gap on each side. */
const CHIP_SEPARATOR = 1 + 8 + 2 * HEAD_ACTION_GAP;
/** A tab behind at its narrowest (icon and a few letters), and the gap between two tabs. */
export const TAB_MIN_WIDTH = 70;
const TAB_GAP = 2;
/** The tab in front where it isn't measured yet: a short title and its close button. */
const TAB_FRONT_WIDTH = 120;

export interface BrowserHeadFit {
  /** The head's width; 0 where it isn't measured yet (everything shows). */
  width: number;
  /** The Artifact chip leads the row. */
  chip: boolean;
  tabs: number;
  /** The tab in front's own width, 0 where it isn't measured. */
  frontWidth: number;
  /** Bar buttons that never fold besides New tab: Back (covering), Expand, Close. */
  controls: number;
}

export interface BrowserHeadRoom {
  /** The room the chip's title has; 0: the icon alone. */
  chipTitle: number;
  /** How many tabs show in the row; the rest are under More tabs. */
  tabsShown: number;
}

export function fitBrowserHead({ width, chip, tabs, frontWidth, controls }: BrowserHeadFit): BrowserHeadRoom {
  if (width <= 0) return { chipTitle: chip ? CHIP_TITLE_MAX : 0, tabsShown: tabs };
  const bar = HEAD_ACTION_WIDTH + HEAD_ACTION_GAP;
  // What the chip's button, the tabs, More tabs and New tab share.
  const strip = width - 2 * EDGE - controls * bar - (chip ? CHIP_SEPARATOR : 0);
  const front = frontWidth > 0 ? frontWidth : TAB_FRONT_WIDTH;
  const need = (shown: number) => front + (shown - 1) * (TAB_MIN_WIDTH + TAB_GAP) + (shown < tabs ? bar : 0);
  // The chip's title takes what the tabs leave once the ones behind are at their narrowest.
  const titleRoom = chip ? strip - CHIP_PAD - need(tabs) - bar : 0;
  const chipTitle = titleRoom >= CHIP_TITLE_MIN ? Math.min(CHIP_TITLE_MAX, titleRoom) : 0;
  const room = strip - (chip ? (chipTitle > 0 ? CHIP_PAD + chipTitle : HEAD_ACTION_WIDTH) : 0) - bar;
  let tabsShown = tabs;
  while (tabsShown > 1 && need(tabsShown) > room) tabsShown -= 1;
  return { chipTitle, tabsShown };
}

/**
 * The tabs the row shows and the ones under More tabs, in their order: the
 * first `shown`, the tab in front always among them (it takes the last place
 * where it would have been hidden).
 */
export function splitBrowserTabs(tabs: readonly BrowserTab[], activeId: string, shown: number): { row: BrowserTab[]; more: BrowserTab[] } {
  if (shown >= tabs.length) return { row: [...tabs], more: [] };
  const count = Math.max(1, shown);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  const inRow = new Set(tabs.slice(0, count).map((tab) => tab.id));
  if (activeIndex >= count) {
    inRow.delete(tabs[count - 1]!.id);
    inRow.add(activeId);
  }
  return { row: tabs.filter((tab) => inRow.has(tab.id)), more: tabs.filter((tab) => !inRow.has(tab.id)) };
}

/** The room the browser chip and its separator take in the Artifact's head (headFit's `leadWidth`): a globe and the count. */
export function browserChipWidth(tabs: number): number {
  return 42 + (tabs >= 10 ? 8 : 0) + 17;
}
