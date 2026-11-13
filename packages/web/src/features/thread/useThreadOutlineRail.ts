import { useCallback, useMemo, useState } from "react";
import { useLocated } from "@botiverse/raft-ui";
import { findLocatedMessageRow, useKeyboardJumpFocus } from "../../hooks/useKeyboardJumpFocus";
import { nextFocusNonce } from "../../store/threadStore";
import { buildMessagePath } from "../../utils/messagePath";

/**
 * A jump from the conversation outline, as a focus of this panel's own: the
 * panel's focus can come from a host (`threadIdentity`) or from the store, and
 * the outline has to work under either. Same path as any other focus: located
 * highlight, context load, keyboard focus (useThreadFocus, useThreadReplyContext).
 * It belongs to the thread it was made in: the panel isn't remounted for the
 * next thread, so a jump still pending there must not reach it.
 */
export function useOutlineFocus(threadChannelId: string | null, hostFocus: { messageId: string | null; nonce: number }) {
  const [focus, setFocus] = useState<{ messageId: string; nonce: number; host: { messageId: string | null; nonce: number } } | null>(null);
  // Dropped when the panel moves to another thread, so going back doesn't bring it back.
  const [focusThread, setFocusThread] = useState(threadChannelId);
  if (focusThread !== threadChannelId) {
    setFocusThread(threadChannelId);
    setFocus(null);
  }
  const { messageId: hostMessageId, nonce: hostNonce } = hostFocus;
  const jumpToReply = useCallback((messageId: string) => {
    setFocus({ messageId, nonce: nextFocusNonce(), host: { messageId: hostMessageId, nonce: hostNonce } });
  }, [hostMessageId, hostNonce]);
  const clearOutlineFocus = useCallback(() => setFocus(null), []);
  // Until the host's or the store's focus moves (a link, a search hit), which
  // then wins. Compared by what it was at the jump, not by size: a host may
  // count its own nonces (a search slot's openNonce).
  const outlineWins = focus !== null && focusThread === threadChannelId
    && focus.host.messageId === hostMessageId && focus.host.nonce === hostNonce;
  return {
    focusedMessageId: outlineWins ? focus.messageId : hostMessageId,
    focusNonce: outlineWins ? focus.nonce : hostNonce,
    jumpToReply,
    clearOutlineFocus,
  };
}

/** What ThreadPanelReplies gives ConversationOutline: the jump, and each row's link as Copy Link makes it. */
export function useThreadOutlineRail(jumpToReply: (messageId: string) => void, jumpToThreadStart: () => Promise<void>, {
  parentChannelId,
  parentMessageId,
  parentRouteKind,
  parentTaskId,
  serverSlug,
}: {
  parentChannelId: string | null | undefined;
  parentMessageId: string | null | undefined;
  parentRouteKind: string | null | undefined;
  parentTaskId: string | null;
  serverSlug: string | undefined;
}) {
  // A jump to the message the thread started from: no reply, so it takes none
  // of the replies' focus path. It heads the panel, and is located there once
  // the panel has reached it (states.md#located).
  // Its thread's own, as a reply's jump is (useOutlineFocus).
  const [parentJumpState, setParentJump] = useState<{ parentMessageId: string | null | undefined; nonce: number } | null>(null);
  if (parentJumpState && parentJumpState.parentMessageId !== parentMessageId) setParentJump(null);
  const parentJump = parentJumpState && parentJumpState.parentMessageId === parentMessageId ? parentJumpState.nonce : null;
  const parentLocated = useLocated(parentJump);
  useKeyboardJumpFocus(parentJump === null ? null : `${parentMessageId}:${parentJump}`, parentJump !== null, () => findLocatedMessageRow(parentMessageId));
  const jumpToParent = useCallback(async () => {
    await jumpToThreadStart();
    setParentJump({ parentMessageId, nonce: nextFocusNonce() });
  }, [jumpToThreadStart, parentMessageId]);
  return useMemo(() => {
    const base = `/s/${serverSlug ?? ""}`;
    const routeKind = parentRouteKind === "dm" ? "dm" : "channel";
    const channelId = parentChannelId ?? "";
    return {
      onJump: (messageId: string) => (messageId === parentMessageId ? void jumpToParent() : jumpToReply(messageId)),
      leadingMessageId: parentMessageId ?? null,
      locatedParentId: parentLocated ? parentMessageId ?? null : null,
      hrefFor: (messageId: string) => (parentTaskId
        // A task's own conversation has no thread parent: the link opens the conversation.
        ? `${base}/${routeKind}/${channelId}?task=${channelId}:task:${parentTaskId}`
        : buildMessagePath(base, channelId, messageId, { routeKind, threadParentMessageId: parentMessageId })),
    };
  }, [jumpToParent, jumpToReply, parentChannelId, parentLocated, parentMessageId, parentRouteKind, parentTaskId, serverSlug]);
}
