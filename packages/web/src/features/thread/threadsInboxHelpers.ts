import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { InboxFilter, InboxItem, ObjectActivityItem } from "../../store/inboxStore";
import { getInboxItemKey } from "../../store/inboxItem";
import { isTaskConversationItem } from "../../utils/taskConversation";
import { artifactActivityComment, artifactActivityPinnedVersion, artifactActivityReview } from "../../apps/artifacts";
import type { SearchContentSlot } from "../../store/searchContentStore";
import type { InboxContextMenuPosition } from "../../components/thread/inboxContextMenuPosition";


/**
 * Up and Down on a row move to the previous or next row, whatever its kind
 * (a conversation's, an Artifact's), as Tab and Shift+Tab do without the
 * stops inside each row; Enter or Space opens it.
 */
export function moveRowFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const trigger = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(ROW_TRIGGER_SELECTOR) : null;
  if (!trigger) return;
  const triggers = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ROW_TRIGGER_SELECTOR));
  const next = triggers[triggers.indexOf(trigger) + (event.key === "ArrowDown" ? 1 : -1)];
  event.preventDefault();
  next?.focus();
}

/** A row's open trigger (raft-ui InboxItemTrigger), the row's first stop. */
export const ROW_TRIGGER_SELECTOR = "[data-inbox-key] [data-slot=inbox-item-open]";

/** The row `key`'s open trigger. Keys are compared rather than put in a selector: they hold a row's ids. */
export function rowTrigger(container: HTMLElement, key: string): HTMLElement | null {
  const row = Array.from(container.querySelectorAll<HTMLElement>("[data-inbox-key]")).find((element) => element.dataset.inboxKey === key);
  return row?.querySelector<HTMLElement>("[data-slot=inbox-item-open]") ?? null;
}

/** Rows land this far under the top of the list (or its pinned filter row). */
export const ROW_LANDING_GAP = 8;
/** Under a stuck day heading a row lands where its day's first row sits: the heading's 2px margin and the list's 2px gap. */
const ROW_UNDER_HEADING_GAP = 4;
/** Pages one re-tap may load to find an unread row past the loaded ones. */
export const RETAP_MAX_PAGE_LOADS = 3;
export const RETAP_ANCHOR_DROPPING_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => { window.requestAnimationFrame(() => resolve()); });
}

// Ask for the next page this close to the end of what is loaded: two screens,
// at least 240px. At 240px (under half a screen) the reader reached the end
// and waited for every page (task #5, InNOut on staging).
export function nearLoadedEnd(container: HTMLElement): boolean {
  // A list with no height is not on screen (a hidden panel): nobody is reading its end.
  if (container.clientHeight === 0) return false;
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance < Math.max(240, container.clientHeight * 2);
}

// Pages asked for after a page lands, with no scroll in between. A list the
// client filters down to a few rows never fills two screens; without a cap it
// would pull the whole inbox while the reader sits still (Tenny, #11357).
export const MAX_PAGES_WITHOUT_SCROLL = 3;

function stickyHeight(element: HTMLElement | null): number | null {
  return element && getComputedStyle(element).position === "sticky" ? element.getBoundingClientRect().height : null;
}

/**
 * How far under the scroller's top a row scrolled to the top of the list lands.
 * On a phone the filter row is pinned at the top of the scroller, and a day's
 * heading sticks under it (or at the very top), so the row lands below them, not
 * under them. Every day's heading is one height, so the first one speaks for all.
 */
export function rowLandingOffset(container: HTMLElement): number {
  const toolbar = stickyHeight(container.querySelector<HTMLElement>('[data-testid="inbox-toolbar"]')) ?? 0;
  const heading = stickyHeight(container.querySelector<HTMLElement>('[data-testid="inbox-day-heading"]'));
  return heading === null ? toolbar + ROW_LANDING_GAP : toolbar + heading + ROW_UNDER_HEADING_GAP;
}

export type ActivityReadFilter = "all" | "unread";

export function activityReadFilter(filter: InboxFilter): ActivityReadFilter {
  return filter === "unread" || filter === "unread_mentions" ? "unread" : "all";
}

export type CtxMenu = InboxContextMenuPosition;

// An unread row's excerpt reads in full foreground, as its title does.
// raft-ui's InboxItemBody stays foreground-muted under data-unread.
/** Skeleton rows while Activity first loads: about a screenful of compact rows. */
export const ACTIVITY_SKELETON_ROWS = 10;

// What the vertical scrollbar starts below (railInset). A day's heading
// (raft-ui InboxItemListHeading, 26px) is opaque and painted over the
// scrollbar (its z-sticky over the gutters' z-1): stuck, it covers the scroller's
// top 26px, and before the list scrolls it sits 8px lower (the content's and
// the list's 4px). A rail that started above it showed the thumb's top as a
// nub over the heading and the rest under it (Artea, 2026-11-08), so it starts
// below the heading's lower edge at rest. On the phone the filter row, 48px +
// its 1px seam (the toolbar's h-[calc(--spacing(12)+1px)]), is pinned above
// the heading, and the list starts 8px under it (pt-2).
const DAY_HEADING_HEIGHT = 26;
const PHONE_TOOLBAR_HEIGHT = 49;
export const ACTIVITY_RAIL_INSET = { top: 8 + DAY_HEADING_HEIGHT } as const;
export const PHONE_ACTIVITY_RAIL_INSET = { top: PHONE_TOOLBAR_HEIGHT + 8 + DAY_HEADING_HEIGHT } as const;

/**
 * What opening an object row shows in Activity's detail slot, beside the list
 * as a conversation row's conversation (xxchan, Remy): its app's viewer, at
 * the version the row is about when that is not the latest, showing the
 * review's comments when the row is about a review, landing on the comment
 * when it is about one (#proj-workspace:#82).
 */
export function objectRowSlot(item: ObjectActivityItem): SearchContentSlot {
  const version = artifactActivityPinnedVersion(item);
  const review = artifactActivityReview(item);
  const comment = artifactActivityComment(item);
  return {
    kind: "artifact",
    id: item.objectId,
    ...(version === null ? {} : { version }),
    ...(review === null ? {} : { review: review.id }),
    ...(comment === null ? {} : { comment }),
  };
}

/**
 * The Activity row an open detail slot is (getInboxItemKey's keys): an
 * Artifact's is its object row; a task's its conversation's row among `rows`
 * (none when the task has no row there).
 */
export function slotItemKey(slot: SearchContentSlot, rows: readonly InboxItem[] = []): string {
  if (slot.kind === "artifact") return `object:artifact:${slot.id}`;
  if (slot.kind === "task") {
    const row = rows.find((item) => item.kind === "thread" && isTaskConversationItem(item) && item.taskId === slot.id);
    return row ? getInboxItemKey(row) : `task:${slot.id}`;
  }
  return `${slot.kind}:${slot.id}`;
}
