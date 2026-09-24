/**
 * Consecutive-same-sender message grouping + day-boundary computation.
 *
 * task #44 (stdrc): merge consecutive messages from the same sender (hide the
 * repeated avatar + name on continuation rows), and show a date divider only at
 * day boundaries.
 *
 * This is a PURE function over the message list — it does NOT read the rendered
 * DOM. That is deliberate: grouping/day-boundary decisions must be derived from
 * the ordered data, not from rendered-row adjacency, so they stay correct for
 * lazy-loaded / out-of-order mounts and for future windowing (task #9). Today
 * MessageTimeline is native-scroll + IntersectionObserver lazy-load — NOT yet
 * windowed, so every loaded row stays mounted. That is exactly why per-message
 * `MessageGroupState` reference stability matters: MessageItem is a default
 * (reference-comparing) `memo`, so a fresh object per recompute would break the
 * memo for every mounted row on each `message:new` → O(N) re-render churn. To
 * avoid that, consume this through `useStableMessageGrouping` (below), which
 * reuses the previous state object for any message whose 5 fields are unchanged.
 * Look up each message's state by id while rendering.
 *
 * Grouping rules — a message CONTINUES the previous sender's group iff all hold:
 *   1. same sender (same senderType AND senderId),
 *   2. neither this message nor the previous is a `system` message
 *      (system messages have their own grouping in `systemMessageGrouping.ts`
 *      and never act as a chat continuation), and
 *   3. same local calendar day (a day boundary always starts a new group so the
 *      date divider sits between groups, never inside one).
 */
import { useMemo, useRef } from "react";

export interface MessageGroupState {
  /** First row of a sender group — renders the avatar + name; a day boundary always starts a new group. */
  isFirstInGroup: boolean;
  /** Immediate predecessor when this row continues a sender group; null for standalone/group-opening rows. */
  previousMessageId: string | null;
  /** Render the sender avatar (first-in-group and not a system message). */
  showAvatar: boolean;
  /** Render the sender name (first-in-group and not a system message). */
  showName: boolean;
  /** Stable local-calendar-day bucket (`YYYY-MM-DD`), for day-boundary detection + the sticky day header. */
  dayKey: string;
  /** This message opens a new calendar day → render a date divider before it. */
  showDayDivider: boolean;
}

/**
 * A selected continuation row whose predecessor is omitted from the selection
 * cannot rely on that predecessor's avatar. Promote the first selected row of
 * each contiguous group segment; later selected continuations stay compact.
 */
export function shouldShowGroupedMessageHeader(
  groupState: MessageGroupState | undefined,
  selectionScopedHere: boolean,
  isSelected: boolean,
  isPreviousMessageSelected: boolean,
): boolean {
  if (!groupState) return true;
  if (groupState.showAvatar) return true;
  return (
    groupState.previousMessageId !== null &&
    selectionScopedHere &&
    isSelected &&
    !isPreviousMessageSelected
  );
}

/** Minimal shape the grouping computation needs from a message. */
export interface GroupableMessage {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  senderId: string;
  messageType?: "chat" | "system";
  createdAt: string;
}

/**
 * Stable calendar-day key (`YYYY-MM-DD`) so a day boundary is detected in the
 * viewer's timezone. Pass the app's effective timezone (from
 * `useTimeFormatter().options.timeZone`) so grouping/day-divider boundaries agree
 * with the timezone-aware divider labels; omit it to fall back to the machine's
 * local zone. `en-CA` renders as `YYYY-MM-DD`.
 */
export function localDayKey(createdAt: string, timeZone?: string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
}

function isSameSender(a: GroupableMessage, b: GroupableMessage): boolean {
  return a.senderType === b.senderType && a.senderId === b.senderId;
}

function isSystem(m: GroupableMessage): boolean {
  return m.messageType === "system";
}

/**
 * Compute per-message grouping + day-boundary state for an ordered (oldest→newest)
 * message list. Returns a Map keyed by message id for O(1) lookup during render.
 */
export function computeMessageGrouping(
  messages: readonly GroupableMessage[],
  timeZone?: string,
  // Message ids that must render standalone (full header) and never merge —
  // messages carrying a thread reply or a task status keep their own avatar,
  // name, time, reply count + task badge, and break the run around them (stdrc).
  standaloneIds?: ReadonlySet<string>,
  // Previous result to reuse per-message state objects from: when a message's 5
  // fields are unchanged, we return the SAME object reference so a default-memo
  // row does not re-render (reference-stability, #2642-class guard). Any changed
  // field yields a fresh object so that row correctly re-renders. Threaded in by
  // `useStableMessageGrouping`; omit it for a one-shot compute.
  previous?: ReadonlyMap<string, MessageGroupState>,
): Map<string, MessageGroupState> {
  const states = new Map<string, MessageGroupState>();
  let prevDayKey: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    const dayKey = localDayKey(message.createdAt, timeZone);

    const showDayDivider = prevDayKey === null || dayKey !== prevDayKey;
    prevDayKey = dayKey;

    const continuesPrev =
      prev !== null &&
      !showDayDivider &&
      !isSystem(message) &&
      !isSystem(prev) &&
      !standaloneIds?.has(message.id) &&
      !standaloneIds?.has(prev.id) &&
      isSameSender(message, prev);

    const isFirstInGroup = !continuesPrev;
    const showChrome = isFirstInGroup && !isSystem(message);

    const next: MessageGroupState = {
      isFirstInGroup,
      previousMessageId: continuesPrev ? prev.id : null,
      showAvatar: showChrome,
      showName: showChrome,
      dayKey,
      showDayDivider,
    };
    // Reuse the prior object iff every field is unchanged — keeps the reference
    // stable so unchanged rows don't re-render, while any real grouping change
    // (e.g. a message going first-in-group → continuation, or a day boundary
    // shifting) hands back a fresh object that correctly re-renders that row.
    const prevState = previous?.get(message.id);
    states.set(message.id, prevState && groupStateEquals(prevState, next) ? prevState : next);
  }

  return states;
}

/** True iff two group states carry identical values across all 5 fields. */
function groupStateEquals(a: MessageGroupState, b: MessageGroupState): boolean {
  return (
    a.isFirstInGroup === b.isFirstInGroup &&
    a.previousMessageId === b.previousMessageId &&
    a.showAvatar === b.showAvatar &&
    a.showName === b.showName &&
    a.dayKey === b.dayKey &&
    a.showDayDivider === b.showDayDivider
  );
}

/**
 * Memoized `computeMessageGrouping` that keeps per-message `MessageGroupState`
 * reference identity stable across recomputes. Threads the previous result back
 * in so unchanged messages keep the SAME object — the default-memo `MessageItem`
 * rows then skip re-render on `message:new`, avoiding the O(N) churn a fresh Map
 * of fresh objects would cause on the non-windowed timeline (#2642-class guard).
 *
 * The cache is per-hook-instance (`useRef`), so there is no cross-timeline
 * thrash and nothing to evict — it is garbage-collected with the component.
 */
export function useStableMessageGrouping(
  messages: readonly GroupableMessage[],
  timeZone?: string,
  standaloneIds?: ReadonlySet<string>,
): ReadonlyMap<string, MessageGroupState> {
  const prevRef = useRef<Map<string, MessageGroupState> | undefined>(undefined);
  return useMemo(() => {
    const next = computeMessageGrouping(messages, timeZone, standaloneIds, prevRef.current);
    prevRef.current = next;
    return next;
  }, [messages, timeZone, standaloneIds]);
}
