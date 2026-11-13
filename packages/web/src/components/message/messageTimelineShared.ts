import { createContext } from "react";
import type { ReactNode } from "react";
import type { Message } from "../../store/messageStore";

// MessageTimeline's contract (VirtualMessageTimeline, on raft-ui's
// VirtualList): props, handle, contexts, the timeline's rows and the scroll
// memory. MessageTimeline.tsx re-exports all of it; import from there.

export type MessageTimelineSource = {
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  loading: boolean;
  loadOlder: () => void | Promise<void>;
  loadNewer: () => void | Promise<void>;
  // One-shot focus on mount (permalink / context window). Setting this AFTER
  // mount is a noop — focus is initialization input, not controlled state.
  // Consumers wanting to re-focus call `handle.scrollToMessage(id)` instead.
  initialFocusMessageId?: string | null;
  // Open at the first row instead of the tail: a jump to a message behind the
  // plan's history window lands on the history paywall at the top. Like the
  // focus, read on mount only.
  initialAtStart?: boolean;
  // The same landing in a list already mounted: each new non-null key (one per
  // jump) goes to the first row, even when the rows are the ones shown.
  atStartKey?: string | number | null;
  // Changing this to a non-null key arms a one-shot pagination barrier for a
  // dynamic bounded context window. Edge auto-load stays blocked until the
  // next real user scroll; a later distinct key re-arms the barrier.
  sentinelAutoLoadBlockKey?: string | null;
};

export type MessageTimelineHandle = {
  scrollToTop: () => void;
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  scrollToMessage: (id: string, opts?: { smooth?: boolean; align?: "start" | "center" | "end" }) => void;
  isAtBottom: () => boolean;
  isFollowingBottom: () => boolean;
  preserveAnchorOnNextLayoutChange: () => void;
  // For surfaces (ChatPanel send-flow) that want to pin the next append even
  // if the user happens to be slightly off the bottom at the time of click.
  // Single-shot: cleared after the next append-induced follow.
  armFollowOnNextAppend: () => void;
  // The loaded messages in list order (the thread parent's leading row first,
  // then `source.messages`, folded ones included), from the data the list
  // renders, not from which rows are mounted: a range selection's order.
  getMessages: () => readonly Message[];
  // What is in view now, from the list's own row offsets and scroll position
  // (raft-ui VirtualList `getOffsetTopOfKey`; timelineVisibleRows.ts), not
  // from which rows are mounted. A row is in view once VISIBLE_ROW_MIN_PX of
  // it (or all of a shorter one) is; `bottomOcclusion` px at the view's bottom
  // are covered (the select-mode toolbar, the agent typing line) and do not
  // count. `onViewportChange` says when to read again.
  // The messages in view, top to bottom (a message folded into another's row
  // is not listed: its row's message is).
  getVisibleMessageIds: (options?: { bottomOcclusion?: number }) => string[];
  // Where one message's row is from the view: one row's offsets, cheap enough
  // for every scroll frame. Null when it has no row here (not loaded).
  getMessageViewportPosition: (
    messageId: string,
    options?: { bottomOcclusion?: number },
  ) => "above" | "below" | "in-view" | null;
};

// How much of a row must be in view for it to count as visible
// (MessageTimelineHandle.getVisibleMessageIds).
export const VISIBLE_ROW_MIN_PX = 24;

export const MessageTimelinePreserveViewportContext = createContext<(() => void) | null>(null);
export const MessageTimelineKeepMessageVisibleContext = createContext<((messageId: string) => void) | null>(null);
// The id of the message a timeline row renders, for state a row keeps outside
// itself so it survives the row unmounting (the virtual timeline mounts only
// the rows near the view): a Mermaid block's Diagram / Code view.
export const MessageTimelineRowMessageIdContext = createContext<string | null>(null);

// Drag the conversation left on a touch screen to see each message's time
// (useTimelineTimeReveal): the list's wrapper carries TIME_REVEAL_ATTR
// (`dragging`, then `settling`) while the rows are slid, and each message row
// has one aria-hidden time marked TIMELINE_REVEAL_TIME_ATTR past its right
// edge, shown only then (index.css).
export const TIME_REVEAL_ATTR = "data-time-reveal";
// With reduced motion (`fade`): the merged rows' gutter times fade in instead (index.css).
export const TIME_REVEAL_MOTION_ATTR = "data-time-reveal-motion";
export const TIMELINE_REVEAL_TIME_ATTR = "data-timeline-reveal-time";

// The rows of a timeline: the messages, and above them the list's own leading
// content (a thread's parent message, the history boundary). Leading rows are
// rows of the list like the messages (measured, virtualized, scrolled to by
// key); everything that counts or indexes messages (`renderItem`'s index,
// unread, the visible window) sees only the `message` rows.
export type MessageTimelineBoundaryVariant = "start" | "loading" | "history-limit" | "replies-start";
export type MessageTimelineLeadingRow =
  // `message` is null when the parent is hidden (a task page shows its own
  // head through the thread's parent slot instead).
  | { kind: "parent"; message: Message | null }
  | { kind: "boundary"; variant: MessageTimelineBoundaryVariant };
export type MessageTimelineRow = { kind: "message"; message: Message } | MessageTimelineLeadingRow;

// One row object per message object, so an unchanged message keeps its row
// (and a virtual list its item) across renders.
const messageRows = new WeakMap<Message, MessageTimelineRow>();
function messageRow(message: Message): MessageTimelineRow {
  let row = messageRows.get(message);
  if (!row) {
    row = { kind: "message", message };
    messageRows.set(message, row);
  }
  return row;
}

// The timeline's rows: the leading rows, then one row per message that is not
// folded into another message's row (a collapsed system-message group is ONE
// row, its summary). Every row has a height of its own: a virtual list sizes
// its window by its shortest row, so empty rows would leave it short.
export function buildMessageTimelineRows(
  leadingRows: readonly MessageTimelineLeadingRow[],
  messages: readonly Message[],
  foldedMessageIds?: ReadonlyMap<string, string>,
): MessageTimelineRow[] {
  const rows: MessageTimelineRow[] = [...leadingRows];
  for (const message of messages) {
    if (foldedMessageIds?.has(message.id)) continue;
    rows.push(messageRow(message));
  }
  return rows;
}

// The messages of a timeline in list order: a leading parent row's message,
// then every message (folded ones too: they are in the list, inside their
// summary's row). Independent of what the virtual list has mounted.
export function messageTimelineMessages(
  leadingRows: readonly MessageTimelineLeadingRow[],
  messages: readonly Message[],
): Message[] {
  const ordered: Message[] = [];
  for (const row of leadingRows) {
    if (row.kind === "parent" && row.message) ordered.push(row.message);
  }
  for (const message of messages) ordered.push(message);
  return ordered;
}

// The key of the row that shows a message: its own row, the row of the
// message it is folded into, or the parent row for a thread's parent.
export function messageTimelineRowKeyOfMessageId(
  id: string,
  leadingRows: readonly MessageTimelineLeadingRow[],
  foldedMessageIds?: ReadonlyMap<string, string>,
): string {
  if (leadingRows.some((row) => row.kind === "parent" && row.message?.id === id)) return `parent:${id}`;
  return `message:${foldedMessageIds?.get(id) ?? id}`;
}

export function messageTimelineRowKey(row: MessageTimelineRow): string {
  switch (row.kind) {
    case "message":
      return `message:${row.message.id}`;
    case "parent":
      return `parent:${row.message?.id ?? "slot"}`;
    case "boundary":
      return `boundary:${row.variant}`;
  }
}

export type MessageTimelineProps = {
  source: MessageTimelineSource;
  renderItem: (msg: Message, index: number) => ReactNode;
  // Rows above the messages, top to bottom, rendered by `renderLeadingRow`.
  leadingRows?: readonly MessageTimelineLeadingRow[];
  renderLeadingRow?: (row: MessageTimelineLeadingRow) => ReactNode;
  footer?: ReactNode;
  // Messages rendered inside another message's row, not as rows of their own:
  // message id -> the id of the message whose row shows it (a system-message
  // group's hidden messages -> its summary). `renderItem` is not called for
  // them; a jump to one goes to the row that shows it. `renderItem`'s index
  // stays the index in `source.messages`.
  foldedMessageIds?: ReadonlyMap<string, string>;
  // Notifies the surface chrome (Back-to-bottom button, server unread sync,
  // new-message badge). Fires whenever the at-bottom state actually changes;
  // this does NOT imply isFollowingBottom changed.
  onAtBottomChange?: (atBottom: boolean) => void;
  // Reports the visible reading window plus roughly one viewport of lookahead
  // for bounded read-side enrichment such as translation.
  onVisibleMessageWindowChange?: (messageIds: string[]) => void;
  // Called when what is in view may have changed: the rows, a scroll, the
  // rows' sizes, the scroller's size, and when the timeline mounts or
  // unmounts (a surface that reads the view through the handle reads again;
  // SelectToHerePill). Cheap: read the view in a frame, not here.
  onViewportChange?: () => void;
  className?: string;
  testId?: string;
  // When set, the primitive remembers the top-visible message id under this
  // key and restores scroll on next mount with the same key. Skipped when
  // the user was at-bottom (re-enter at tail is the expected "live mode"
  // landing).
  persistKey?: string;
  // Where sparse content (fewer messages than fill the viewport) should rest.
  // "top" — content stacks from the top; the empty space is below. Right for
  //   threads, where the "Beginning of replies" divider sits above the first
  //   reply and the visual expectation is replies grow downward from it.
  // "bottom" — content is pushed flush against the bottom edge (input bar).
  //   Right for channels, where the input bar is glued to the scroller and
  //   floating sparse content at the top would leave a confusing dead zone.
  // Defaults to "top".
  sparseAnchor?: "top" | "bottom";
  // The message first in view keeps its offset across a width change of the
  // scroller instead of the list following its end (the thread, #189;
  // timelineWidthAnchor.ts).
  keepTopOnWidthChange?: boolean;
};

// The timeline's DOM helpers, on its scroller (VirtualMessageTimeline).
export function distanceFromBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

export function messageRowSelector(messageId: string): string {
  return `[data-timeline-message-id="${CSS.escape(messageId)}"]`;
}

export const AT_BOTTOM_THRESHOLD = 100;
// How long after a user scroll gesture (wheel/touch/pointer/keyboard) the resulting
// inertial/momentum `scroll` events are still attributed to that gesture.
// Covers iOS Safari fling deceleration, which emits scroll events with no
// further gesture events for a few hundred ms after touchend. Refreshed on
// every scroll frame while a gesture is active so a long, continuous fling
// stays attributed for its full duration.
export const USER_SCROLL_MOMENTUM_WINDOW_MS = 700;
// The visible-window report feeds read-side enrichment (translation), not
// layout, so a few reports a second are enough: one at the start of a scroll,
// then at most one per interval, and a trailing one when the scroll settles.
export const VISIBLE_WINDOW_REPORT_INTERVAL_MS = 250;

// Keys that scroll a focused scroller natively (or through VirtualList's own
// keyboard handling): pressed on the scroller itself, they are a user gesture.
export const SCROLL_NAVIGATION_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];

// ── Scroll-position memory (sessionStorage with LRU eviction) ───────────────

/** The boot script reads a conversation's entry too (bootInlineScript BOOT_SCROLL_MEMORY_PREFIX; a test compares). */
export const SCROLL_MEMORY_PREFIX = "slock.scroll-memory.v1.";
const SCROLL_MEMORY_INDEX = "slock.scroll-memory.v1.__index__";
const SCROLL_MEMORY_MAX = 64;
const scrollMemoryFallback = new Map<string, string>();

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readIndex(storage: Storage): string[] {
  try {
    const raw = storage.getItem(SCROLL_MEMORY_INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(storage: Storage, index: string[]) {
  try {
    storage.setItem(SCROLL_MEMORY_INDEX, JSON.stringify(index));
  } catch {
    /* quota / disabled */
  }
}

export function rememberScroll(key: string, messageId: string) {
  const storage = getStorage();
  if (!storage) {
    scrollMemoryFallback.delete(key);
    scrollMemoryFallback.set(key, messageId);
    if (scrollMemoryFallback.size > SCROLL_MEMORY_MAX) {
      const oldest = scrollMemoryFallback.keys().next().value;
      if (oldest !== undefined) scrollMemoryFallback.delete(oldest);
    }
    return;
  }
  try {
    storage.setItem(SCROLL_MEMORY_PREFIX + key, messageId);
    const index = readIndex(storage).filter((k) => k !== key);
    index.push(key);
    while (index.length > SCROLL_MEMORY_MAX) {
      const oldest = index.shift();
      if (oldest) storage.removeItem(SCROLL_MEMORY_PREFIX + oldest);
    }
    writeIndex(storage, index);
  } catch {
    /* quota / disabled */
  }
}

export function recallScroll(key: string): string | undefined {
  const storage = getStorage();
  if (!storage) return scrollMemoryFallback.get(key);
  try {
    const v = storage.getItem(SCROLL_MEMORY_PREFIX + key);
    if (v === null) return undefined;
    const index = readIndex(storage).filter((k) => k !== key);
    index.push(key);
    writeIndex(storage, index);
    return v;
  } catch {
    return undefined;
  }
}

export function forgetScroll(key: string) {
  const storage = getStorage();
  if (!storage) {
    scrollMemoryFallback.delete(key);
    return;
  }
  try {
    storage.removeItem(SCROLL_MEMORY_PREFIX + key);
    const index = readIndex(storage).filter((k) => k !== key);
    writeIndex(storage, index);
  } catch {
    /* quota / disabled */
  }
}

// Public helper for consumers to pre-seed `initialFocusMessageId` from the
// remembered scroll position when their data loader needs to know which
// window to fetch. Safe to call before mount.
export function recallPersistedScrollMessageId(key: string | undefined): string | null {
  if (!key) return null;
  return recallScroll(key) ?? null;
}
