import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { useLocated } from "@botiverse/raft-ui";
import type { Message } from "../../store/messageStore";
import type { MessageTimelineHandle } from "../../components/message/MessageTimeline";
import { useRetireJump } from "../../hooks/useRetireJump";
import { findLocatedMessageRow, useKeyboardJumpFocus } from "../../hooks/useKeyboardJumpFocus";
import { SHORT_MESSAGE_ID } from "./threadMessages";

/**
 * The reply the panel was asked to show (a permalink, a search hit, a jump):
 * its full id once resolved, the scroll to it once it is loaded, its located
 * highlight, and retiring the focus where it came from.
 */
// oxlint-disable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
export function useThreadFocus({
  focusedMessageId,
  resolvedFocus,
  messages,
  focusNonce,
  timelineRef,
  consumeFocusedMessage,
}: {
  focusedMessageId: string | null;
  resolvedFocus: { from: string; to: string } | null;
  messages: Message[];
  focusNonce: number;
  timelineRef: RefObject<MessageTimelineHandle | null>;
  consumeFocusedMessage: () => void;
}) {
  const resolvedFocusId = focusedMessageId && resolvedFocus?.from === focusedMessageId ? resolvedFocus.to : focusedMessageId;
  const scrolledFocusJumpRef = useRef<string | null>(null);

  // A short-id focus in a thread that is already open (a ref clicked while the
  // thread is up) never reaches the load, which runs only for a new thread: it
  // resolves against the loaded replies, to the one reply whose id starts with
  // it. None or two such replies: it stays as it came.
  const effectiveFocusId = useMemo(() => {
    if (!resolvedFocusId || !SHORT_MESSAGE_ID.test(resolvedFocusId)) return resolvedFocusId;
    const matches = messages.filter((msg) => msg.id.startsWith(resolvedFocusId));
    return matches.length === 1 ? matches[0].id : resolvedFocusId;
  }, [resolvedFocusId, messages]);
  const focusedMessageLoaded = !!effectiveFocusId && messages.some((msg) => msg.id === effectiveFocusId);
  // One jump to a reply, once it is loaded: the reply and the jump's nonce
  // (never the reply's id alone, states.md#located), so a second jump to the
  // same reply scrolls to it and locates it again.
  const focusJump = focusedMessageLoaded ? `${effectiveFocusId}:${focusNonce}` : null;
  useEffect(() => {
    if (!effectiveFocusId) {
      scrolledFocusJumpRef.current = null;
      return;
    }
    if (!focusJump) return;
    if (scrolledFocusJumpRef.current === focusJump) return;
    scrolledFocusJumpRef.current = focusJump;
    requestAnimationFrame(() => {
      timelineRef.current?.scrollToMessage(effectiveFocusId, { align: "center" });
    });
  }, [focusJump, effectiveFocusId, timelineRef]);

  // The reply a jump went to is located (states.md#located), then the focus
  // is retired. Keyed on the jump alone: new replies and later pages must not
  // restart it. The panel holds the highlight, not the row, so a row that
  // scrolls out and back in after it has run stays unlit.
  const replyLocated = useLocated(focusJump);
  const locatedReplyId = replyLocated ? effectiveFocusId : null;
  useRetireJump(focusJump, consumeFocusedMessage);
  useKeyboardJumpFocus(
    effectiveFocusId ? `${effectiveFocusId}:${focusNonce}` : null,
    focusedMessageLoaded,
    () => findLocatedMessageRow(effectiveFocusId),
  );

  return { effectiveFocusId, focusedMessageLoaded, locatedReplyId };
}
// oxlint-enable react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state, react-doctor/no-event-handler
