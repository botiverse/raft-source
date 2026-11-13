import { createContext } from "react";
import { MAIN_COLUMN_MIN_WIDTH } from "../../lib/panelBounds";

import type { ChannelSideCard } from "../../store/channelSideCardStore";

/**
 * Where a Task v2 section stands (task #165; ChannelSideArea places them):
 *
 * - beside: in a column of the layout row, full height, while the channel
 *   keeps its 360px (MAIN_COLUMN_MIN_WIDTH) and the column its minimum
 *   (280px; 360 with the thread in it);
 * - float: the row has no room for its column, so it floats over the right of
 *   the channel's messages, under the channel header, raised by a shadow;
 * - overlay: a phone, or a channel panel too narrow for a floating column and
 *   readable messages (280 + 240): it covers the panel under its header, with
 *   Back.
 */
export type SideCardsMode = "beside" | "float" | "overlay";

/** The conversation keeps the main column's minimum, as it does beside a thread (lib/panelBounds.ts). */
export const SIDE_CARDS_CHAT_MIN_WIDTH = MAIN_COLUMN_MIN_WIDTH;
export const SIDE_CARDS_MIN_WIDTH = 280;
/** Messages left readable beside the floating column. */
export const SIDE_CARDS_FLOAT_MESSAGES_MIN_WIDTH = 240;
const CARD_MIN_HEIGHT = 160;
/** Stacked sections: each at least 160px, and the seams between them (two: 321, three with an Artifact: 482). */
export function sideCardsStackMinHeight(sections: number): number {
  return sections * CARD_MIN_HEIGHT + (sections - 1);
}


/**
 * With both sections open, one at a time (under a Tasks / Files switch) when
 * two don't fit: covering a phone, or a column too short for two 160px
 * sections (`sideCardsColumnHeight`). Floating, they stack as they do beside
 * (task #165).
 */
export function sideCardsOneAtATime(mode: SideCardsMode, columnHeight: number, sections = 2): boolean {
  return mode === "overlay" || columnHeight < sideCardsStackMinHeight(sections);
}

/** How far from the composer the floating column stops (ChannelSideArea sets its bottom). */
export const SIDE_CARDS_FLOAT_COMPOSER_GAP = 12;

/** The column's height: the panel's, or floating, the part above the composer and its gap. */
export function sideCardsColumnHeight(mode: SideCardsMode, panelHeight: number, composerHeight: number): number {
  return mode === "float" ? panelHeight - composerHeight - SIDE_CARDS_FLOAT_COMPOSER_GAP : panelHeight;
}

/** The card opened or picked last (ties go to the first in `open`). */
export function activeSideCard<Card extends string>(open: readonly Card[], focusAt: Readonly<Partial<Record<string, number>>>): Card | null {
  let best: Card | null = null;
  for (const card of open) {
    if (best === null || (focusAt[card] ?? 0) > (focusAt[best] ?? 0)) best = card;
  }
  return best;
}

/** Where a card sits, decided by the column; the card reads it from here. */
export interface SideCardState {
  /** Tasks, Files, the profile, a context view or the channel details in a side column (#189 rule 7). */
  card: ChannelSideCard | "profile" | "context" | "details";
  mode: SideCardsMode;
  collapsible: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** On screen, not behind another section's tab (one at a time); absent: shown. */
  shown?: boolean;
}

export const SideCardContext = createContext<SideCardState | null>(null);

export const ROW_SELECTOR = '[data-testid="thread-layout-container"]';
const CHANNEL_COLUMN_CLASS = "thread-main-column";
const SLOT_TESTID = "channel-side-slot";

/**
 * The room the channel and the sections share in the layout row: the row's
 * width less every other column standing in it (a thread beside the channel,
 * a profile). Not the channel's own width, which its 360px minimum holds up
 * while the sections stand beside it; none where a thread covers the row.
 */
export function rowRoom(row: HTMLElement): number {
  // A thread covering the row (under 720px) hides the channel: no room beside it.
  const channel = Array.from(row.children).find((child) => child.classList.contains(CHANNEL_COLUMN_CLASS));
  if (channel && getComputedStyle(channel).display === "none") return 0;
  let others = 0;
  const count = (element: Element) => {
    if (!(element instanceof HTMLElement) || element.hidden) return;
    if (element.classList.contains(CHANNEL_COLUMN_CLASS) || element.dataset.testid === SLOT_TESTID) return;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") return;
    if (style.display === "contents") {
      for (const child of Array.from(element.children)) count(child);
      return;
    }
    others += element.getBoundingClientRect().width;
  };
  for (const child of Array.from(row.children)) count(child);
  return row.getBoundingClientRect().width - others;
}
