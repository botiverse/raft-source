import { useCallback } from "react";
import { getInboxItemKey } from "../../store/inboxStore";
import type { InboxFilter, InboxItem } from "../../store/inboxStore";
import type { ActivitySwipeActions } from "../../components/thread/activitySwipeActions";

export function itemKey(item: InboxItem): string {
  return getInboxItemKey(item);
}

export function itemUnreadCount(item: InboxItem): number {
  return item.unreadCount;
}

/** Marks the row laid out once the browser has measured it (two frames: layout, then the remembered size). */
function markLaidOut(element: HTMLElement) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (element.isConnected) element.setAttribute("data-laid-out", "");
  }));
}

export type ThreadInboxItem = Extract<InboxItem, { kind: "thread" }>;

export function asThreadItem(item: InboxItem): ThreadInboxItem | null {
  return item.kind === "thread" ? item : null;
}

export function activityMentionsOnly(filter: InboxFilter): boolean {
  return filter === "mentions" || filter === "unread_mentions";
}

export const UNREAD_BODY_CLASS = "group-data-[unread=true]/inbox-item:text-foreground";

// A phone's swipeable row (useRowSwipe): the row's box, its divider and its
// pressed fill stay put while its parts slide left by `--row-swipe-reveal`
// (its end buttons) or right by `--row-swipe-reveal-start` (its start
// button), so the dividers between rows (raft-ui draws them on the row after
// a row) are untouched. `pan-y` keeps vertical scrolling the browser's own, with
// pinch-zoom kept where the browser supports `pan-y pinch-zoom` (where it
// doesn't, as in Safari, the row keeps `pan-y`). The
// slide animates only while the row settles (200ms, useRowSwipe's
// ROW_SWIPE_SETTLE_MS), never under reduced motion.
export const SWIPE_ROW_CLASS = [
  "[touch-action:pan-y] supports-[touch-action:pan-y_pinch-zoom]:[touch-action:pan-y_pinch-zoom] overflow-hidden",
  "[&>*:not([data-row-swipe-layer])]:[transform:translateX(calc(var(--row-swipe-reveal-start,0px)_-_var(--row-swipe-reveal,0px)))]",
  "data-[swipe=settling]:[&>*]:transition-[transform,width] data-[swipe=settling]:[&>*]:duration-200 data-[swipe=settling]:[&>*]:ease-out",
  "motion-reduce:[&>*]:transition-none",
].join(" ");
// The buttons a swipe uncovers (raft-design #785), at the row's end: Done at
// the outer edge, the row's other actions inward, each 72px wide and the
// row's height, its icon (the menu's, #782, 18px) over its word (caption,
// semibold: Jasper, 2026-10-23). They grow evenly
// as the row is pulled further; past the full-swipe point (`data-swipe-full`
// on the row) Done grows across the whole uncovered width over the others.
// Decorative for assistive technology: screen readers and keyboards have the
// row's visually hidden Mark as Done and its menu.
export const SWIPE_LAYER_CLASS = "pointer-events-none absolute inset-y-0 right-0 z-control flex w-[var(--row-swipe-reveal,0px)] justify-end overflow-hidden";
// The one button a swipe right uncovers (raft-design #793), at the row's
// start: Read on an unread row, Unread on a read one, with the menu item's
// icon. Quiet, as the end's inward buttons are; alone on its side, it fills
// the uncovered width, so nothing gives way when the pull passes the
// full-swipe point. Its icon and word sit in a 72px label instead: centred in
// the button short of that point, past it pinned to the button's inner
// (right) edge, next to the row, so they ride the row's edge as the finger
// pulls on (as in iOS Mail). That tells the finger a release will apply it.
export const SWIPE_START_LAYER_CLASS = "pointer-events-none absolute inset-y-0 left-0 z-control flex w-[var(--row-swipe-reveal-start,0px)] justify-start overflow-hidden";
const SWIPE_BUTTON_CLASS = [
  "pointer-events-auto flex h-full min-w-0 shrink-0 grow basis-[72px] flex-col items-center justify-center gap-1 overflow-hidden",
  "text-caption font-semibold whitespace-nowrap outline-none",
  "transition-[flex-basis,flex-grow] duration-150 ease-out motion-reduce:transition-none",
  "[&>svg]:size-[18px] [&>svg]:shrink-0",
].join(" ");
/** Done stands out: solid `success` with ink, as every colored block takes ink. */
export const SWIPE_DONE_BUTTON_CLASS = `${SWIPE_BUTTON_CLASS} bg-success text-sticker-ink`;
/** The rest stay quiet, and give way to Done on a full swipe. */
export const SWIPE_QUIET_BUTTON_CLASS = [
  SWIPE_BUTTON_CLASS,
  "bg-fill-muted text-foreground",
  "group-data-[swipe-full=true]/inbox-item:grow-0 group-data-[swipe-full=true]/inbox-item:basis-0",
].join(" ");
/** The start's button: quiet too, and the only one on its side; its label (SWIPE_START_LABEL_CLASS) rides the row's edge once full. */
export const SWIPE_START_BUTTON_CLASS = [
  "pointer-events-auto flex h-full min-w-0 shrink-0 grow basis-[72px] items-center justify-center overflow-hidden",
  "text-caption font-semibold whitespace-nowrap outline-none",
  "bg-fill-muted text-foreground",
  "group-data-[swipe-full=true]/inbox-item:justify-end",
].join(" ");
/** The start button's icon over its word, 72px wide whatever the button's width. */
export const SWIPE_START_LABEL_CLASS = "flex w-[72px] shrink-0 flex-col items-center gap-1 [&>svg]:size-[18px] [&>svg]:shrink-0";

/** A phone row's swipe: whether it is the open one, and what its buttons do. */
export type RowSwipeProps = {
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
  actions: ActivitySwipeActions;
};

/**
 * A phone's Mark as Done (raft-design #776): visually hidden (`sr-only`) and
 * shown while it holds keyboard focus, so focus never lands on something
 * invisible. It shows where a hover reveal does, over the end of the row on
 * the canvas, so the row keeps its height. `sr-only` is already absolute;
 * keyboard focus only undoes its clipping and 1px box.
 */
export const PHONE_DONE_ACTIONS_CLASS = [
  "sr-only",
  "has-[:focus-visible]:top-1/2 has-[:focus-visible]:right-0 has-[:focus-visible]:-translate-y-1/2",
  "has-[:focus-visible]:m-0 has-[:focus-visible]:size-auto has-[:focus-visible]:overflow-visible",
  "has-[:focus-visible]:whitespace-normal has-[:focus-visible]:[clip-path:none] has-[:focus-visible]:[clip:auto]",
  "has-[:focus-visible]:bg-layer-canvas",
].join(" ");

/** One row's swipe props: the list's shared callbacks, and whether it is the open row. */
export function rowSwipeFor(shared: Omit<RowSwipeProps, "open">, open: boolean): RowSwipeProps {
  return { ...shared, open };
}

/** One ref for the row from both the list (focus) and its swipe. */
export function useMergedRowRef(focusRef: React.Ref<HTMLDivElement> | undefined, swipeRef: (element: HTMLDivElement | null) => void) {
  return useCallback((element: HTMLDivElement | null) => {
    if (element && !element.hasAttribute("data-laid-out")) markLaidOut(element);
    swipeRef(element);
    if (typeof focusRef === "function") focusRef(element);
    else if (focusRef) (focusRef as React.MutableRefObject<HTMLDivElement | null>).current = element;
  }, [focusRef, swipeRef]);
}
