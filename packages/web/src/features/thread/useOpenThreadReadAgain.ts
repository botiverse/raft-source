import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { isAutoReadHeld } from "../../store/autoReadHold";
import { canAutoMarkCurrentChannelRead, queueThreadLiveReplyReadSync } from "../../store/messageStore";
import { registerOpenThreadPanel } from "../../store/openThreadReadSaved";
import { forgetSkippedSeenRead, hasSkippedSeenRead } from "../../store/seenReadCatchUp";
import { useThreadStore } from "../../store/threadStore";
import { isThreadUnreadLocally } from "../../store/threadUnreadLocal";

export interface OpenThreadReadAgain {
  /** Persists the read of replies that landed in view; one the explicit-activity gate refused waits for the next activity. */
  persistLiveRead: (seq: number) => void;
  /** A reply arrived while the reader was scrolled up. */
  noteUnseenLiveReply: () => void;
  /** The timeline reached (or left) the bottom: reaching it reads the thread when nothing newer is loaded. */
  readAtBottom: (atBottom: boolean) => void;
}

/**
 * Reading the open thread after its open (#triage:#157): "if I can see it,
 * it's read". The open reads it once, on mount; picking it again reads it in
 * threadStore.openThread. Here: reaching the bottom (nothing newer loaded)
 * reads what arrived while the reader was scrolled up, and a reply that landed
 * in view while the explicit-activity gate refused its read is read on the
 * next click or key press (store/seenReadCatchUp), if the reader is still at
 * the bottom. The open thread's local badge may already be 0 then (thread:
 * updated zeroes a thread shown read) while the server cursor is behind, so
 * those replies are remembered rather than read off the badge. Never while
 * Activity or Mark as Unread holds it, never in a hidden tab.
 */
export function useOpenThreadReadAgain({
  threadChannelId,
  parentMessageId,
  isNearBottomRef,
  hasNewerRef,
}: {
  threadChannelId: string | null;
  parentMessageId: string | null;
  isNearBottomRef: RefObject<boolean>;
  hasNewerRef: RefObject<boolean>;
}): OpenThreadReadAgain {
  const hasUnread = useThreadStore((state) => isThreadUnreadLocally(state, parentMessageId, threadChannelId));
  const hasUnreadRef = useRef(hasUnread);
  hasUnreadRef.current = hasUnread;
  const unseenLiveReplyRef = useRef(false);

  /** Reads the thread if it is seen and not held; false when it can't be read now. */
  const readNow = useCallback(() => {
    if (!threadChannelId) return false;
    if (isAutoReadHeld(threadChannelId) || !canAutoMarkCurrentChannelRead(undefined, undefined, "thread")) return false;
    unseenLiveReplyRef.current = false;
    useThreadStore.getState().clearThreadUnread(threadChannelId);
    return true;
  }, [threadChannelId]);

  // The panel leaving this thread drops its pending catch-up and what it saw.
  useEffect(() => {
    unseenLiveReplyRef.current = false;
    if (!threadChannelId) return;
    return () => forgetSkippedSeenRead(threadChannelId);
  }, [threadChannelId]);

  // #244: the Activity row counts a live reply here as read only while this read will be saved.
  useEffect(() => {
    if (!threadChannelId) return;
    return registerOpenThreadPanel(threadChannelId, () => !!isNearBottomRef.current && !hasNewerRef.current);
  }, [threadChannelId, isNearBottomRef, hasNewerRef]);

  const persistLiveRead = useCallback((seq: number) => {
    if (!threadChannelId) return;
    queueThreadLiveReplyReadSync(threadChannelId, seq, () => {
      if (!isNearBottomRef.current || hasNewerRef.current) return false;
      return readNow();
    });
  }, [threadChannelId, readNow, isNearBottomRef, hasNewerRef]);
  const noteUnseenLiveReply = useCallback(() => { unseenLiveReplyRef.current = true; }, []);
  const readAtBottom = useCallback((atBottom: boolean) => {
    if (!atBottom || hasNewerRef.current) return;
    if (hasUnreadRef.current || unseenLiveReplyRef.current || hasSkippedSeenRead(threadChannelId)) readNow();
  }, [readNow, hasNewerRef, threadChannelId]);
  return { persistLiveRead, noteUnseenLiveReply, readAtBottom };
}
