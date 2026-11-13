import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, RefObject, UIEvent } from "react";
import { useIntl } from "react-intl";
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  Popover,
  PopoverContent,
  ScrollArea,
  ScrollAreaGutters,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  VirtualList,
  useScrollAreaContainer,
} from "@botiverse/raft-ui";
import type { VirtualListApi } from "@botiverse/raft-ui";
import type { VisibleMessageWindowStore } from "../../components/message/VisibleMessageTranslations";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { appSocketSource } from "../../notifications/desktopNative/appSocketSource";
import { listenOnEverySocket } from "../../notifications/desktopNative/followSocket";
import { loadOlderOutline, loadOutline, pageOutlineBackTo, useMessageOutlineStore } from "../../store/messageOutlineStore";
import type { OutlineItem } from "../../store/messageOutlineStore";
import type { Message } from "../../store/messageStore";
import { useMessageStore } from "../../store/messageStore";
import { PHONE_MEDIA_QUERY } from "../../components/ui/NarrowDialog";
import { closeOutlineList, hasOutline, useOutlineListStore } from "./outlineListStore";

// The conversation outline (消息时间线), in threads only, where agents' long
// runs bury what people asked (Artea): one tick per message a person wrote,
// and one for the message the thread started from, beside the message list, and over it a card with a line of each on hover or
// keyboard focus, each with a tooltip for the rest of its text. A sibling
// of the timeline, always mounted and shown with `hidden`: adding or removing
// the list's sibling while someone scrolls makes WebKit restyle the whole list
// (raft-ui message-list.md).

const POINTER_QUERY = "(hover: hover) and (pointer: fine)";
/** Narrower than a thread beside the conversation (400 by default, rowLayout.ts), where it mostly lives. */
const MIN_LIST_WIDTH = 360;
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 120;
const TICK_ROW_PX = 10;
/** The rail is a short strip in the middle of the list, not its full height: past this it scrolls with the reader. */
const RAIL_MAX_HEIGHT_PX = 240;
const CARD_ROW_PX = 30;
const CARD_MAX_ROWS = 10;
// raft-ui ScrollArea over the card's list, bound as on the message timeline
// (timelineScrollArea.ts): only the bar is its, scrolling stays the list's. The
// list runs into the card's padding, so the bar sits there and clears the ticks.
const CARD_SCROLL_AREA = { overscroll: "contain", size: "small", trigger: "hover" } as const;
/** Rows from the card's oldest end at which the next older page loads. */
const LOAD_OLDER_WITHIN_PX = CARD_ROW_PX * 5;
const NO_ITEMS: readonly OutlineItem[] = [];
/**
 * The phone's sheet opens at half the screen and drags up to its full height,
 * as an iOS sheet does (Artea, #proj-raft-ui:10ed1ba5): half leaves the thread
 * in sight under it.
 */
const SHEET_SNAP_POINTS = [0.5, 1];
const SHEET_STYLE = { "--drawer-content-height": "82dvh" } as CSSProperties;

/** A row's tooltip clears the card: its padding, then a tooltip's usual gap. */
const ROW_TOOLTIP_OFFSET_PX = 12;

/**
 * On the list's container once the rail is eligible: the room the rail takes,
 * which message content keeps clear and the hover toolbar moves left by
 * (MessageItem, MessageHoverToolbar). It changes with whether the rail shows,
 * never with scrolling, so rows rewrap at most once.
 */
const RAIL_INSET_VAR = "--message-rail-inset";
const RAIL_INSET = "36px";

type OutlineMessage = Pick<Message, "id" | "seq">;

function useParentWidthAtLeast(ref: RefObject<HTMLElement | null>, width: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setWide(parent.clientWidth >= width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref, width]);
  return wide;
}

/** Whether a message is in view: the visible window is the rows in view plus as many again below them, fewer at the list's end. */
function windowShows(windowIds: readonly string[], messageId: string, lastMessageId: string | undefined): boolean {
  const inView = windowIds.at(-1) === lastMessageId ? windowIds.length : Math.ceil(windowIds.length / 2);
  return windowIds.slice(0, inView).includes(messageId);
}

// oxlint-disable react-doctor/no-event-handler -- No handler sees what this follows: the reader's place in the list is the visible window, an external store the list writes as it scrolls (useSyncExternalStore), and paging the outline back to it is syncing with that store. A jump's target arrives as a prop from whatever jumped (a link, a search hit, this rail), adjusted during render as React's "adjusting state when a prop changes".
/**
 * Where the reader is. Current is the last item at or before the top message
 * in view, by seq, so it holds in a context window as at the live end. A jump's
 * target is current from the jump until it has been in view and left it: it
 * lands centered, under the top message. A timeline older than the loaded
 * outline pages the outline back to it.
 */
function useOutlinePosition(
  channelId: string,
  items: readonly OutlineItem[],
  messages: readonly OutlineMessage[],
  visibleWindow: VisibleMessageWindowStore,
  jumpTargetId: string | null,
  leadingMessageId: string | null,
) {
  const windowIds = useSyncExternalStore(visibleWindow.subscribe, visibleWindow.get, visibleWindow.get);
  const topId = windowIds[0];
  const topSeq = useMemo(() => messages.find((message) => message.id === topId)?.seq ?? null, [messages, topId]);
  // The leading message's row is in the window but not among `messages`.
  const topIsLeading = topId !== undefined && topId === leadingMessageId;
  useEffect(() => {
    if (topIsLeading) void pageOutlineBackTo(channelId, 0);
    else if (topSeq !== null) void pageOutlineBackTo(channelId, topSeq);
  }, [channelId, topIsLeading, topSeq]);

  // Adjusted during render, from the same render's window: no commit of a stale current row.
  const [jump, setJump] = useState<{ id: string; landed: boolean } | null>(null);
  const noteJump = useCallback((messageId: string) => setJump({ id: messageId, landed: false }), []);
  // Every jump, wherever it came from: this rail, a link, a search hit.
  const [seenTargetId, setSeenTargetId] = useState<string | null>(null);
  if (jumpTargetId !== seenTargetId) {
    setSeenTargetId(jumpTargetId);
    if (jumpTargetId) setJump({ id: jumpTargetId, landed: false });
  } else if (jump) {
    const inView = windowShows(windowIds, jump.id, messages.at(-1)?.id);
    if (inView && !jump.landed) setJump({ ...jump, landed: true });
    else if (!inView && jump.landed) setJump(null);
  }

  const jumpedId = jump?.id;
  const jumpedRowId = jumpedId && items.some((item) => item.id === jumpedId) ? jumpedId : null;
  const currentIndex = useMemo(() => {
    if (jumpedRowId) return items.findIndex((item) => item.id === jumpedRowId);
    if (topIsLeading) return items[0]?.id === leadingMessageId ? 0 : -1;
    if (topSeq === null) return -1;
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((items[middle]?.seq ?? 0) <= topSeq) low = middle + 1;
      else high = middle;
    }
    return low - 1;
  }, [items, jumpedRowId, leadingMessageId, topIsLeading, topSeq]);
  const currentId = items[currentIndex]?.id ?? null;
  // Where the reader is along the items: past the current one by how far the
  // top message has gone toward the next, so the rail moves as the list does,
  // through the agents' messages between two ticks too.
  const position = useMemo(() => {
    if (currentIndex < 0) return null;
    const current = items[currentIndex];
    const next = items[currentIndex + 1];
    if (jumpedRowId || !current || !next || topSeq === null) return currentIndex;
    return currentIndex + (topSeq - current.seq) / (next.seq - current.seq);
  }, [currentIndex, items, jumpedRowId, topSeq]);
  return { currentId, position, jumpedRowId, noteJump };
}
// oxlint-enable react-doctor/no-event-handler

function OutlineTick({ own, current }: { own: boolean; current: boolean }) {
  const rest = own ? "bg-foreground-muted" : "bg-line-seam";
  return (
    <span
      aria-hidden
      className={`block shrink-0 rounded-full transition-[width] motion-reduce:transition-none ${
        current ? "h-[3px] w-[22px] bg-foreground" : `h-0.5 w-3 ${rest} group-hover/tick:w-[18px] group-hover/tick:bg-foreground`
      }`}
    />
  );
}

function useItemText() {
  const { formatMessage } = useIntl();
  return useCallback((item: OutlineItem) => {
    if (item.preview) return item.preview;
    return item.attachmentCount > 0
      ? formatMessage({ id: "message.outline.attachments" }, { count: item.attachmentCount })
      : formatMessage({ id: "message.outline.noText" });
  }, [formatMessage]);
}

function useItemLabel() {
  const { formatDate, formatMessage } = useIntl();
  const textOf = useItemText();
  return useCallback((item: OutlineItem) => formatMessage({ id: "message.outline.rowLabel" }, {
    sender: item.senderName,
    time: formatDate(new Date(item.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    text: textOf(item),
  }), [formatDate, formatMessage, textOf]);
}

/**
 * Its rows are a popup's items (states.md): the pointer's and the keyboard's
 * item fills `brand-soft`, as a menu's; the reader's place is marked as a
 * menu's current value is, in bold, with its tick long and in ink, and no fill.
 */

function OutlineCard({
  channelId,
  items,
  currentId,
  jumpedRowId,
  currentUserId,
  focusOnOpen,
  hrefFor,
  onJump,
  onEscape,
  onPointerEnter,
  onPointerLeave,
  onBlur,
}: {
  channelId: string;
  items: readonly OutlineItem[];
  currentId: string | null;
  /** A jump's target, in the outline: the card goes to it. */
  jumpedRowId: string | null;
  currentUserId: string | null;
  focusOnOpen: boolean;
  hrefFor: (messageId: string) => string;
  onJump: (messageId: string) => void;
  onEscape: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}) {
  const textOf = useItemText();
  const { formatMessageTime } = useTimeFormatter();
  const labelOf = useItemLabel();
  const apiRef = useRef<VirtualListApi>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const focusRow = useCallback((messageId: string) => {
    apiRef.current?.scrollTo({ key: messageId });
    requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLElement>(`[data-outline-row="${messageId}"]`)?.focus({ preventScroll: true });
    });
  }, []);

  // Once, as it opens: the current row in the middle, and keyboard focus on it.
  const [opening] = useState(() => ({ rowId: currentId ?? items.at(-1)?.id ?? null, focus: focusOnOpen }));
  useLayoutEffect(() => {
    if (!opening.rowId) return;
    apiRef.current?.scrollTo({ key: opening.rowId, align: "center" });
    if (opening.focus) focusRow(opening.rowId);
  }, [focusRow, opening]);

  useEffect(() => {
    if (!jumpedRowId) return;
    apiRef.current?.scrollTo({ key: jumpedRowId });
  }, [jumpedRowId]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const focusedId = (event.target as HTMLElement).dataset.outlineRow;
    const index = items.findIndex((item) => item.id === focusedId);
    const next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) focusRow(next.id);
  }, [focusRow, items, onEscape]);

  // A real link (Open in New Tab, a modified click); a plain click jumps in place.
  const handleRowClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const messageId = event.currentTarget.dataset.outlineRow;
    if (messageId) onJump(messageId);
  }, [onJump]);

  const listHeight = Math.min(items.length, CARD_MAX_ROWS) * CARD_ROW_PX;
  const { containerProps: scrollArea, guttersProps: scrollAreaGutters } = useScrollAreaContainer<HTMLDivElement>(CARD_SCROLL_AREA);
  const listStyle = useMemo(() => ({ ...scrollArea.style, height: listHeight }), [listHeight, scrollArea.style]);
  const handleScroll = useCallback((event: Event) => {
    if ((event.target as HTMLElement).scrollTop < LOAD_OLDER_WITHIN_PX) void loadOlderOutline(channelId);
  }, [channelId]);

  const renderRow = useCallback(({ item, key, style }: { item: OutlineItem; key: string | undefined; style: CSSProperties | undefined }) => {
    const current = item.id === currentId;
    return (
      <Tooltip key={key}>
        <TooltipTrigger
          render={
            <a
              href={hrefFor(item.id)}
              style={style}
              tabIndex={-1}
              data-outline-row={item.id}
              aria-label={labelOf(item)}
              aria-current={current ? "true" : undefined}
              onClick={handleRowClick}
              className="mr-1.5 flex h-[30px] items-center gap-2.5 rounded-control pr-[3px] pl-2.5 text-callout text-foreground-muted no-underline outline-none hover:bg-brand-soft hover:text-foreground focus-visible:bg-brand-soft focus-visible:text-foreground aria-[current=true]:font-semibold aria-[current=true]:text-foreground"
            >
              <span className="min-w-0 flex-1 truncate">{textOf(item)}</span>
              <OutlineTick own={item.senderId === currentUserId} current={current} />
            </a>
          }
        />
        <TooltipContent side="left" sideOffset={ROW_TOOLTIP_OFFSET_PX}>
          <span className="line-clamp-4">{textOf(item)}</span>
          <span className="mt-1 flex items-baseline gap-1.5 text-foreground-on-hud-muted">
            <span className="min-w-0 truncate">{item.senderName}</span>
            <span className="shrink-0">{formatMessageTime(item.createdAt)}</span>
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }, [currentId, currentUserId, formatMessageTime, handleRowClick, hrefFor, labelOf, textOf]);

  return (
    <div
      ref={cardRef}
      data-testid="conversation-outline-card"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      className="pointer-events-auto absolute top-1/2 -right-1 flex max-h-full w-[300px] -translate-y-1/2 flex-col rounded-container bg-layer-popover p-1.5 shadow-float ring-1 ring-line-seam"
    >
      <VirtualList<OutlineItem>
        componentRef={apiRef}
        domRef={scrollArea.ref}
        header={<ScrollAreaGutters {...scrollAreaGutters} />}
        items={items}
        getKey={getItemKey}
        itemEstimatedSize={CARD_ROW_PX}
        itemMinSize={CARD_ROW_PX}
        focusable={false}
        keepAnchorOnItemsChange
        className={`${scrollArea.className} -mr-1.5 min-h-0`}
        style={listStyle}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
      >
        {renderRow}
      </VirtualList>
    </div>
  );
}

function getItemKey(item: OutlineItem): string {
  return item.id;
}

function OutlineRail({
  channelId,
  items,
  messages,
  visibleWindow,
  jumpTargetId,
  leadingMessageId,
  onJump,
  hrefFor,
}: {
  channelId: string;
  items: readonly OutlineItem[];
  messages: readonly OutlineMessage[];
  visibleWindow: VisibleMessageWindowStore;
  jumpTargetId: string | null;
  leadingMessageId: string | null;
  onJump: (messageId: string) => unknown;
  hrefFor: (messageId: string) => string;
}) {
  const { formatMessage } = useIntl();
  const labelOf = useItemLabel();
  const currentUserId = useMessageStore((s) => s.currentUserId);
  // oxlint-disable-next-line react-doctor/no-event-handler -- useOutlinePosition follows the list's visible window (see there).
  const { currentId, position, jumpedRowId, noteJump } = useOutlinePosition(channelId, items, messages, visibleWindow, jumpTargetId, leadingMessageId);
  const [open, setOpen] = useState<false | "pointer" | "keyboard">(false);
  const railApiRef = useRef<VirtualListApi>(null);
  const railElRef = useRef<HTMLDivElement>(null);

  // Open while the pointer or keyboard focus is on the rail or the card. Only
  // focus the keyboard put there counts: a clicked tick keeps its focus after
  // the pointer has gone.
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const ignoreRailFocusRef = useRef(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  const scheduleOpen = useCallback((by: "pointer" | "keyboard") => {
    clearTimers();
    openTimerRef.current = setTimeout(() => setOpen((current) => current || by), OPEN_DELAY_MS);
  }, [clearTimers]);
  const scheduleClose = useCallback(() => {
    if (pointerInsideRef.current || focusInsideRef.current) return;
    clearTimers();
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [clearTimers]);

  const handlePointerEnter = useCallback(() => {
    pointerInsideRef.current = true;
    scheduleOpen("pointer");
  }, [scheduleOpen]);
  const handlePointerLeave = useCallback(() => {
    pointerInsideRef.current = false;
    if (focusInsideRef.current) return;
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
    scheduleClose();
  }, [scheduleClose]);

  // The rail is the one Tab stop: its focus opens the card and goes on to the current row.
  const handleRailFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (ignoreRailFocusRef.current || event.target !== event.currentTarget || !event.target.matches(":focus-visible")) return;
    focusInsideRef.current = true;
    scheduleOpen("keyboard");
  }, [scheduleOpen]);
  // Focus left the rail and the card, which are siblings in the outline.
  const handleBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.parentElement?.contains(event.relatedTarget)) return;
    focusInsideRef.current = false;
    scheduleClose();
  }, [scheduleClose]);
  const handleEscape = useCallback(() => {
    clearTimers();
    focusInsideRef.current = false;
    setOpen(false);
    ignoreRailFocusRef.current = true;
    railElRef.current?.focus({ preventScroll: true });
    ignoreRailFocusRef.current = false;
  }, [clearTimers]);

  const jump = useCallback((messageId: string) => {
    noteJump(messageId);
    void onJump(messageId);
  }, [noteJump, onJump]);
  const handleTickClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const messageId = event.currentTarget.dataset.outlineTick;
    if (messageId) jump(messageId);
  }, [jump]);

  const railContentHeight = items.length * TICK_ROW_PX;
  const railHeight = Math.min(railContentHeight, RAIL_MAX_HEIGHT_PX);
  const railStyle = useMemo(() => ({ height: railHeight }), [railHeight]);
  const markRailOverflow = useCallback(() => {
    const rail = railElRef.current;
    if (!rail) return;
    const above = rail.scrollTop > 0;
    const below = rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1;
    rail.dataset.overflow = above && below ? "both" : above ? "start" : below ? "end" : "none";
  }, []);
  // The rail follows the list: where the reader is stays in its middle, until
  // it runs out of ticks at either end.
  useEffect(() => {
    if (position !== null) {
      const top = (position + 0.5) * TICK_ROW_PX - railHeight / 2;
      railApiRef.current?.scrollTo({ top: Math.min(Math.max(top, 0), railContentHeight - railHeight) });
    }
    markRailOverflow();
  }, [markRailOverflow, position, railContentHeight, railHeight]);

  const renderTick = useCallback(({ item, key, style }: { item: OutlineItem; key: string | undefined; style: CSSProperties | undefined }) => (
    <button
      key={key}
      type="button"
      style={style}
      tabIndex={-1}
      data-outline-tick={item.id}
      aria-label={labelOf(item)}
      aria-current={item.id === currentId ? "true" : undefined}
      onClick={handleTickClick}
      className="group/tick flex h-2.5 w-full items-center justify-end border-0 bg-transparent p-0 pr-1.5 outline-none"
    >
      <OutlineTick own={item.senderId === currentUserId} current={item.id === currentId} />
    </button>
  ), [currentId, currentUserId, handleTickClick, labelOf]);

  return (
    <>
      <VirtualList<OutlineItem>
        componentRef={railApiRef}
        domRef={railElRef}
        items={items}
        getKey={getItemKey}
        itemEstimatedSize={TICK_ROW_PX}
        itemMinSize={TICK_ROW_PX}
        focusable={!open}
        keepAnchorOnItemsChange
        aria-label={formatMessage({ id: "message.outline.label" })}
        className="pointer-events-auto max-h-full w-full rounded-control outline-none focus-visible:shadow-focus data-[overflow=both]:[mask-image:linear-gradient(to_bottom,transparent,oklch(0_0_0)_var(--fade-edge),oklch(0_0_0)_calc(100%-var(--fade-edge)),transparent)] data-[overflow=end]:mask-fade-b-edge data-[overflow=start]:mask-fade-t-edge"
        style={railStyle}
        onScroll={markRailOverflow}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        onFocus={handleRailFocus}
        onBlur={handleBlur}
      >
        {renderTick}
      </VirtualList>
      {open ? (
        <OutlineCard
          channelId={channelId}
          items={items}
          currentId={currentId}
          jumpedRowId={jumpedRowId}
          currentUserId={currentUserId}
          focusOnOpen={open === "keyboard"}
          hrefFor={hrefFor}
          onJump={jump}
          onEscape={handleEscape}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          onBlur={handleBlur}
        />
      ) : null}
    </>
  );
}

/**
 * The outline as a list, from the thread's ⋯ (Timeline): where there is no
 * rail, on a touch screen or in a list too narrow for it. A bottom sheet on a
 * phone, a popover under the thread's head otherwise: a place to go (raft-ui
 * drawer.md). Each row is the text in up to two lines, then who and when, for
 * a touch screen has no tooltip to show the rest (Artea). A row jumps there
 * and closes the list.
 */
function OutlineList({
  channelId,
  items,
  messages,
  visibleWindow,
  jumpTargetId,
  leadingMessageId,
  onJump,
  hrefFor,
}: {
  channelId: string;
  items: readonly OutlineItem[];
  messages: readonly OutlineMessage[];
  visibleWindow: VisibleMessageWindowStore;
  jumpTargetId: string | null;
  leadingMessageId: string | null;
  onJump: (messageId: string) => unknown;
  hrefFor: (messageId: string) => string;
}) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const open = useOutlineListStore((s) => s.channelId === channelId);
  const anchor = useOutlineListStore((s) => (s.channelId === channelId ? s.anchor : null));
  // Closed with the thread: the next thread doesn't open on it.
  useEffect(() => closeOutlineList, [channelId]);
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) closeOutlineList();
  }, []);
  const title = formatMessage({ id: "message.outline.listTitle" });
  const rows = (
    <OutlineListRows
      channelId={channelId}
      items={items}
      messages={messages}
      visibleWindow={visibleWindow}
      jumpTargetId={jumpTargetId}
      leadingMessageId={leadingMessageId}
      onJump={onJump}
      hrefFor={hrefFor}
    />
  );
  if (phone) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange} snapPoints={SHEET_SNAP_POINTS} defaultSnapPoint={SHEET_SNAP_POINTS[0]}>
        <DrawerContent style={SHEET_STYLE} data-testid="conversation-outline-sheet">
          <DrawerHeader>
            <div className="flex items-center justify-between gap-2">
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerClose className="-my-2" aria-label={formatMessage({ id: "common.close" })} />
            </div>
          </DrawerHeader>
          <DrawerBody className="min-h-0 p-0">{rows}</DrawerBody>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverContent
        anchor={anchor ?? undefined}
        side="bottom"
        align="end"
        sideOffset={6}
        aria-label={title}
        className="flex max-h-[min(560px,var(--available-height))] w-[360px] max-w-[calc(100vw-16px)] flex-col p-0"
        data-testid="conversation-outline-popover"
      >
        <div className="flex min-h-11 shrink-0 items-center border-b border-line-seam px-4 text-headline">{title}</div>
        {rows}
      </PopoverContent>
    </Popover>
  );
}

function OutlineListRows({
  channelId,
  items,
  messages,
  visibleWindow,
  jumpTargetId,
  leadingMessageId,
  onJump,
  hrefFor,
}: {
  channelId: string;
  items: readonly OutlineItem[];
  messages: readonly OutlineMessage[];
  visibleWindow: VisibleMessageWindowStore;
  jumpTargetId: string | null;
  leadingMessageId: string | null;
  onJump: (messageId: string) => unknown;
  hrefFor: (messageId: string) => string;
}) {
  const textOf = useItemText();
  const labelOf = useItemLabel();
  const { formatMessageTime } = useTimeFormatter();
  const currentUserId = useMessageStore((s) => s.currentUserId);
  const { currentId } = useOutlinePosition(channelId, items, messages, visibleWindow, jumpTargetId, leadingMessageId);
  const contentRef = useRef<HTMLDivElement>(null);
  // Once, as it opens: the current row near the top, the row before it above
  // it, so it shows in a sheet opened at half height too.
  const [openingId] = useState(() => currentId ?? items.at(-1)?.id ?? null);
  useLayoutEffect(() => {
    const row = openingId ? contentRef.current?.querySelector<HTMLElement>(`[data-outline-row="${openingId}"]`) : null;
    const before = row?.previousElementSibling as HTMLElement | null | undefined;
    (before ?? row)?.scrollIntoView({ block: "start" });
  }, [openingId]);
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollTop < LOAD_OLDER_WITHIN_PX) void loadOlderOutline(channelId);
  }, [channelId]);
  // A real link (Open in New Tab, a modified click); a plain tap jumps in place.
  const handleRowClick = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const messageId = event.currentTarget.dataset.outlineRow;
    if (!messageId) return;
    closeOutlineList();
    void onJump(messageId);
  }, [onJump]);
  return (
    <ScrollArea
      tabIndex={-1}
      overscroll="contain"
      className="min-h-0 flex-1"
      contentRef={contentRef}
      contentClassName="flex flex-col px-1.5 pt-1 pb-[max(--spacing(2),env(safe-area-inset-bottom))]"
      onScroll={handleScroll}
    >
      {items.map((item) => {
        const current = item.id === currentId;
        return (
          <a
            key={item.id}
            href={hrefFor(item.id)}
            data-outline-row={item.id}
            aria-label={labelOf(item)}
            aria-current={current ? "true" : undefined}
            onClick={handleRowClick}
            className="group/row flex min-h-11 items-center gap-3 rounded-control py-2 pr-1.5 pl-3 text-foreground-muted no-underline outline-none hover:bg-brand-soft hover:text-foreground focus-visible:bg-brand-soft focus-visible:text-foreground active:bg-brand-soft aria-[current=true]:text-foreground"
          >
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-callout group-aria-[current=true]/row:font-semibold">{textOf(item)}</span>
              <span className="mt-0.5 flex items-baseline gap-1.5 text-foreground-hint">
                <span className="min-w-0 truncate text-footnote">{item.senderName}</span>
                <span className="shrink-0 font-mono text-mono-meta">{formatMessageTime(item.createdAt)}</span>
              </span>
            </span>
            <OutlineTick own={item.senderId === currentUserId} current={current} />
          </a>
        );
      })}
    </ScrollArea>
  );
}

export const ConversationOutline = memo(function ConversationOutline({
  channelId,
  messages,
  visibleWindow,
  jumpTargetId,
  leadingMessageId,
  onJump,
  hrefFor,
}: {
  channelId: string | null;
  /** The loaded messages: their seqs place the top message in view. */
  messages: readonly OutlineMessage[];
  visibleWindow: VisibleMessageWindowStore;
  /** The message the conversation just jumped to, however it got there. */
  jumpTargetId: string | null;
  /** The message the thread started from: an item, but above the timeline's messages. */
  leadingMessageId: string | null;
  onJump: (messageId: string) => unknown;
  hrefFor: (messageId: string) => string;
}) {
  const { formatMessage } = useIntl();
  const finePointer = useMediaQuery(POINTER_QUERY);
  // Read on every device: the ⋯ menu's Timeline needs it where there is no rail.
  const active = channelId !== null;
  useEffect(() => {
    if (!active || !channelId) return;
    void loadOutline(channelId);
    return listenOnEverySocket(appSocketSource, "connect", () => {
      void loadOutline(channelId);
    });
  }, [active, channelId]);

  const items = useMessageOutlineStore((s) => (channelId ? s.byChannel[channelId]?.items : undefined)) ?? NO_ITEMS;
  const rootRef = useRef<HTMLElement>(null);
  const wide = useParentWidthAtLeast(rootRef, MIN_LIST_WIDTH);
  const enough = active && hasOutline(items, leadingMessageId);
  const shown = enough && finePointer && wide;

  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!shown || !parent) return;
    parent.style.setProperty(RAIL_INSET_VAR, RAIL_INSET);
    return () => {
      parent.style.removeProperty(RAIL_INSET_VAR);
    };
  }, [shown]);

  return (
    <>
    <nav
      ref={rootRef}
      hidden={!shown}
      aria-label={formatMessage({ id: "message.outline.label" })}
      data-testid="conversation-outline"
      className="pointer-events-none absolute inset-y-2 right-2 z-float flex w-7 items-center"
    >
      {shown && channelId ? (
        <OutlineRail
          key={channelId}
          channelId={channelId}
          items={items}
          messages={messages}
          visibleWindow={visibleWindow}
          jumpTargetId={jumpTargetId}
          leadingMessageId={leadingMessageId}
          onJump={onJump}
          hrefFor={hrefFor}
        />
      ) : null}
    </nav>
    {enough && channelId ? (
      <OutlineList
        channelId={channelId}
        items={items}
        messages={messages}
        visibleWindow={visibleWindow}
        jumpTargetId={jumpTargetId}
        leadingMessageId={leadingMessageId}
        onJump={onJump}
        hrefFor={hrefFor}
      />
    ) : null}
    </>
  );
});
