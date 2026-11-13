import { useCallback, useContext } from "react";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useMessageStore } from "../../store/messageStore";
import { markThreadUnreadFromThread } from "../thread/inboxRowActions";
import { markOpenThreadUnread, OpenThreadContext } from "./threadUnreadHold";

/**
 * Mark as Unread from a message's menu in a channel's or DM's message list
 * (xxchan, #triage:9f2eeecb). The menu of a message in a thread panel has
 * the thread's own Mark Thread as Unread (useEnclosingThreadMarkUnread) and
 * none of these: there the menu acts on the thread.
 *
 * - The conversation: the sidebar row's Mark as Unread
 *   (SidebarReadToggleMenuItem), offered for channels and DMs alike; while
 *   the person stays in it, it stays unread (messageStore.markUnread). Not
 *   in a channel the person hasn't joined (a preview): the sidebar doesn't
 *   list it, so it has no unread to show.
 * - The message's thread, when the person follows it: the thread header ⋯'s
 *   Mark as Unread (useOpenThreadMarkUnread). Held unread while that thread
 *   is open beside the list (threadUnreadHold); a thread not open gets the
 *   same write with no hold, which would otherwise keep the thread from
 *   reading when it is next opened.
 */
export interface MessageMenuMarkUnread {
  markConversationUnread: (() => void) | null;
  markThreadUnread: (() => void) | null;
}

export function useMessageMenuMarkUnread({
  conversationId,
  topLevel,
  followedThreadChannelId,
  threadOpen,
}: {
  /** The channel or DM the list shows (the sidebar row's id). */
  conversationId: string;
  /** A top-level message in an interactive list (not a thread reply, not a read-only projection). */
  topLevel: boolean;
  /** The message's thread channel, when the person follows its thread. */
  followedThreadChannelId: string | null;
  /** Whether the message's thread is the one open beside the list. */
  threadOpen: boolean;
}): MessageMenuMarkUnread {
  const inThreadPanel = useContext(OpenThreadContext) !== null;
  const markUnread = useMessageStore((s) => s.markUnread);
  const notJoined = useChannelStore((s) => findStoredChannel(s, conversationId)?.joined === false);
  const enabled = topLevel && !inThreadPanel;
  const markConversationUnread = useCallback(() => {
    void markUnread(conversationId).catch(() => {
      void useMessageStore.getState().loadUnreadCounts();
    });
  }, [conversationId, markUnread]);
  const markThreadUnread = useCallback(() => {
    if (!followedThreadChannelId) return;
    if (threadOpen) markOpenThreadUnread(followedThreadChannelId);
    else void markThreadUnreadFromThread(followedThreadChannelId);
  }, [followedThreadChannelId, threadOpen]);
  return {
    markConversationUnread: enabled && conversationId && !notJoined ? markConversationUnread : null,
    markThreadUnread: enabled && followedThreadChannelId ? markThreadUnread : null,
  };
}
