import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Spinner } from "@botiverse/raft-ui";
import {
  MessageListJumpControls,
  MessageListJumpPill,
  MessageListJumpPillDismiss,
  MessageListJumpPillGroup,
} from "@botiverse/raft-ui/wip";

import { useMessagePlacement } from "../../hooks/useMessagePlacement";
import type { MessagePlacement } from "../../hooks/useMessagePlacement";
import { useParentUnreadThreadsForJump } from "../../hooks/useParentThreadUnread";
import { useThreadStore } from "../../store/threadStore";
import type { FollowedThread } from "../../store/threadStore";
import { BottomJumpControls } from "./BottomJumpControls";
import type { SelectToHere } from "./useSelectToHere";

/** How a jump that had to load ended: on the history paywall (the parent is behind the plan's window) or not. */
export type ParentJumpResult = { historyLimited: boolean };

/** The chat's loaded messages, to place unread threads whose parent row is not rendered. */
export type LoadedMessageRange = {
  /** createdAt of the oldest loaded message. */
  oldestAt: string | null;
  /** createdAt of the newest loaded message. */
  newestAt: string | null;
  /** Newer messages exist past the loaded ones (reading history). */
  hasNewer: boolean;
};

function placeUnrendered(parentAt: string | undefined, range: LoadedMessageRange): MessagePlacement {
  const time = parentAt ? Date.parse(parentAt) : Number.NaN;
  if (range.hasNewer && range.newestAt && !Number.isNaN(time) && time > Date.parse(range.newestAt)) return "below";
  // Not loaded and not newer: older history above (or an older server without the parent time).
  return "above";
}

/**
 * One pill for the unread followed threads of a channel whose parent message
 * is off screen (a parent on screen already shows its unread replies):
 * - some below: at the bottom, beside "Back to bottom", "Next unread thread
 *   (N)" goes to the nearest one below;
 * - only above: at the top, "Earliest unread thread (N)"
 *   goes to the topmost one.
 * So repeated clicks walk the channel top to bottom and then start over at
 * the top; N (all unread threads of the channel) shrinks as threads are read,
 * and ✕ stops it until the count changes. A click scrolls to the parent and
 * flashes it; it does not open the thread. A parent behind the plan's
 * history window, though, is only the paywall there: a thread the server says
 * goes on inside the window (`parentInHistory` false, `repliesInHistory`
 * true) opens instead, which reads it; any other lands on the paywall, where it can't be opened to read it, so
 * once the jump says so the thread is read (as opening it would). Either way
 * the count drops and the next click goes on to the next one.
 * Nothing is remembered between clicks. A parent outside the loaded
 * messages needs its context window first: until it arrives the pill is busy (DS States › Busy: the pixel
 * spinner in place of its arrow and a label that says what is happening,
 * "Loading Thread…"; disabled, but it keeps focus), so the click shows at
 * once. A polite status line says the same to screen readers.
 *
 * raft-ui's jump controls (message-list.md, "Jump controls"): a
 * MessageListJumpPill with its MessageListJumpPillDismiss joined on one edge,
 * beside the "Back to bottom" pill.
 */
export function ThreadUnreadJumpPill({
  channelId,
  onJumpToMessage,
  bottomButton,
  selectToHere,
  loadedRange,
  loadedMessageIds,
  renderKey,
}: {
  channelId: string;
  /** Scroll the channel's chat to this parent message and flash it; a promise when it has to load first. */
  onJumpToMessage: (messageId: string) => void | Promise<ParentJumpResult>;
  /** The chat's "back to bottom" button, laid out beside the bottom pill. */
  bottomButton?: ReactNode;
  /** Select to here's pill, first on the bottom controls' line (BottomJumpControls). */
  selectToHere?: SelectToHere;
  loadedRange: LoadedMessageRange;
  /**
   * The chat's loaded messages in order: a loaded parent whose row is not
   * mounted (the virtual timeline mounts only the rows near the view) is
   * placed by its index in them.
   */
  loadedMessageIds?: readonly string[];
  /** Changes when the rendered message rows may have changed. */
  renderKey: string;
}) {
  const { formatMessage } = useIntl();
  // Unread threads of this channel, top to bottom by parent message.
  const threads = useParentUnreadThreadsForJump(channelId);
  const parentIds = useMemo(() => threads.map((thread) => thread.parentMessageId), [threads]);
  const placements = useMessagePlacement(parentIds, renderKey, loadedMessageIds);
  // Dismissed per channel until the number of unread threads changes.
  const [dismissed, setDismissed] = useState<{ channelId: string; count: number } | null>(null);

  const { above, below } = useMemo(() => {
    const aboveThreads: FollowedThread[] = [];
    const belowThreads: FollowedThread[] = [];
    for (const thread of threads) {
      const placement = placements.get(thread.parentMessageId)
        ?? placeUnrendered(thread.parentMessageCreatedAt, loadedRange);
      if (placement === "above") aboveThreads.push(thread);
      else if (placement === "below") belowThreads.push(thread);
    }
    return { above: aboveThreads, below: belowThreads };
  }, [loadedRange, placements, threads]);

  const total = threads.length;
  const isDismissed = dismissed?.channelId === channelId && dismissed.count === total;
  const dismiss = useCallback(() => setDismissed({ channelId, count: total }), [channelId, total]);

  // Below first: the nearest one below. Only when none is below: the earliest above.
  const nearestBelow = below[0];
  const earliestAbove = above[0];
  // At most one pill shows (below wins), so one handler serves both.
  const target = nearestBelow ?? earliestAbove;
  // The channel whose jump is waiting for its parent to load. Scoped to the
  // channel, so a jump left behind doesn't make another channel's pill busy;
  // the ref drops a stale jump's end when a newer one started.
  const [busyChannelId, setBusyChannelId] = useState<string | null>(null);
  const jumpRef = useRef(0);
  const busy = busyChannelId === channelId;
  const jump = useCallback(() => {
    if (!target || busy) return;
    if (target.parentInHistory === false && target.repliesInHistory === true) {
      void useThreadStore.getState().openThread({
        parentChannelId: channelId,
        parentMessageId: target.parentMessageId,
        threadChannelId: target.threadChannelId,
      });
      return;
    }
    const loading = onJumpToMessage(target.parentMessageId);
    // A parent already loaded is there at once: nothing to wait for.
    if (!(loading instanceof Promise)) return;
    const jumpId = ++jumpRef.current;
    setBusyChannelId(channelId);
    const settle = () => {
      if (jumpRef.current === jumpId) setBusyChannelId(null);
    };
    // A failed jump says so itself (ChatPanel's not-found toast); here it
    // only ends the busy state, so the pill can be pressed again.
    const { threadChannelId } = target;
    loading.then((result) => {
      if (result.historyLimited) useThreadStore.getState().clearThreadUnread(threadChannelId);
      settle();
    }, settle);
  }, [busy, channelId, onJumpToMessage, target]);

  const busyLabel = formatMessage({ id: "message.chatPanel.threadUnreadJumpLoading" });
  const renderPill = (direction: "up" | "down") => {
    const Arrow = direction === "up" ? ArrowUp : ArrowDown;
    return (
      <MessageListJumpPillGroup
        data-testid="thread-unread-jump-pill"
        data-placement={direction === "up" ? "top" : "bottom"}
      >
        <MessageListJumpPill onClick={jump} disabled={busy} focusableWhenDisabled aria-busy={busy || undefined}>
          {/* DS Spinner › Size: in place of a 16px icon, `sm`. */}
          {busy ? <Spinner size="sm" aria-hidden="true" /> : <Arrow aria-hidden />}
          {busy ? busyLabel : formatMessage(
            { id: direction === "up" ? "message.chatPanel.threadUnreadJumpEarliest" : "message.chatPanel.threadUnreadJumpNext" },
            { count: total },
          )}
        </MessageListJumpPill>
        <MessageListJumpPillDismiss
          aria-label={formatMessage({ id: "message.chatPanel.threadUnreadDismiss" })}
          onClick={dismiss}
        >
          <X aria-hidden />
        </MessageListJumpPillDismiss>
      </MessageListJumpPillGroup>
    );
  };

  const bottomPill = !isDismissed && nearestBelow ? renderPill("down") : null;
  const topPill = !isDismissed && !nearestBelow && earliestAbove ? renderPill("up") : null;

  // Both slots stay mounted and are shown with `hidden`: they sit right after
  // the timeline, and WebKit restyles the timeline's whole subtree when that
  // child list changes, which used to happen each time the reader left or
  // reached the live tail. Only the slots' own content changes.
  return (
    <>
      {/* Always mounted, so the busy label is announced when it changes. */}
      <span className="sr-only" role="status" data-testid="thread-unread-jump-status">{busy ? busyLabel : null}</span>
      <MessageListJumpControls side="top" data-testid="chat-top-controls" hidden={!topPill}>
        {topPill}
      </MessageListJumpControls>
      <BottomJumpControls
        data-testid="chat-bottom-controls"
        selectToHere={selectToHere}
        hidden={!bottomPill && !bottomButton}
      >
        {bottomButton}
        {bottomPill}
      </BottomJumpControls>
    </>
  );
}
