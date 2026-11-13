import { useCallback, useContext, useState } from "react";
import { isThreadFollowed, useThreadStore } from "../../store/threadStore";
import { OpenThreadContext } from "./threadUnreadHold";
import type { OpenThreadIdentity } from "./threadUnreadHold";

/** A conversation's one-shot Follow / Unfollow command, as its menus show it. */
export interface ConversationFollowCommand {
  followed: boolean;
  disabled: boolean;
  onFollowAction: () => void;
}

/**
 * A thread's Follow / Unfollow, shared by its header ⋯ menu and its messages'
 * menus in the thread panel: follow by the parent message, unfollow by the
 * thread's channel, busy while one is in flight. Null with no parent message
 * (no thread, or a task conversation, whose caller supplies its own).
 */
export function useThreadFollowCommand(thread: OpenThreadIdentity | null): ConversationFollowCommand | null {
  const threadChannelId = thread?.threadChannelId ?? null;
  const parentMessageId = thread?.parentMessageId ?? null;
  const [followBusy, setFollowBusy] = useState(false);
  const followed = useThreadStore((state) => (parentMessageId ? isThreadFollowed(state, parentMessageId) : false));
  const followThread = useThreadStore((state) => state.followThread);
  const unfollowThread = useThreadStore((state) => state.unfollowThread);

  const onFollowAction = useCallback(() => {
    if (followBusy) return;
    const action = followed
      ? threadChannelId ? unfollowThread(threadChannelId) : null
      : parentMessageId ? followThread(parentMessageId) : null;
    if (!action) return;

    // Follow/Unfollow are one-shot commands, matching the message context
    // menu. They are intentionally not modelled as a preference Switch. A
    // thread has no notification level: following it is what notifies.
    setFollowBusy(true);
    void action
      .catch(() => {})
      .finally(() => setFollowBusy(false));
  }, [followBusy, followed, threadChannelId, parentMessageId, unfollowThread, followThread]);

  if (!parentMessageId) return null;
  return { followed, disabled: followBusy || (followed && !threadChannelId), onFollowAction };
}

/** The enclosing thread panel's Follow / Unfollow, for a message's menu (null outside a thread panel). */
export function useEnclosingThreadFollowCommand(): ConversationFollowCommand | null {
  return useThreadFollowCommand(useContext(OpenThreadContext));
}
