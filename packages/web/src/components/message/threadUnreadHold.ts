import { createContext, useCallback, useContext, useEffect } from "react";
import { holdAutoRead, releaseAutoRead } from "../../store/autoReadHold";
import { useInboxStore } from "../../store/inboxStore";
import { isThreadFollowed, useThreadStore } from "../../store/threadStore";
import { markThreadUnreadFromThread, toggleActivityRowRead } from "../thread/inboxRowActions";

/**
 * Mark as Unread from inside an open thread (its ⋯ menu) does what a
 * channel's Mark as Unread does while the person is in that channel
 * (messageStore.markUnread: its next auto-read is skipped): the thread stays
 * open and stays unread while the person is in it. Auto-read is held for
 * the thread (store/autoReadHold) until they leave it: the thread panel
 * closes or shows another thread. In Activity's detail pane, acting in the
 * thread ends the hold and reads it, as for a thread Activity reopened on its
 * own (activityVisit).
 */
let heldThreadId: string | null = null;
const mountedPanels = new Map<string, number>();

export function holdThreadUnread(threadChannelId: string, read: () => void): void {
  holdAutoRead(threadChannelId, {
    read,
    end: () => {
      if (heldThreadId === threadChannelId) heldThreadId = null;
    },
  });
  heldThreadId = threadChannelId;
}

/** Ends this menu's hold on the thread, unread (never Activity's own hold). */
function releaseThreadUnread(threadChannelId: string): void {
  if (heldThreadId === threadChannelId) releaseAutoRead({ read: false });
}

/** Mount in the thread panel: leaving the thread ends its Mark as Unread hold. */
export function useThreadUnreadHoldRelease(threadChannelId: string | null): void {
  useEffect(() => {
    if (!threadChannelId) return;
    mountedPanels.set(threadChannelId, (mountedPanels.get(threadChannelId) ?? 0) + 1);
    return () => {
      const left = (mountedPanels.get(threadChannelId) ?? 1) - 1;
      if (left > 0) mountedPanels.set(threadChannelId, left);
      else mountedPanels.delete(threadChannelId);
      // On the next task, not now: a layout switch (side panel to a phone's
      // page) unmounts the panel and mounts it again for the same thread,
      // which is not leaving it.
      window.setTimeout(() => {
        if (!mountedPanels.has(threadChannelId)) releaseThreadUnread(threadChannelId);
      }, 0);
    };
  }, [threadChannelId]);
}

/**
 * Mark the open thread unread (the whole thread: the server's /unread has no
 * from-message): the Activity row's action, held unread while the person is
 * in it. The hold's `read` reads it again the way picking its Activity row
 * does (acting in it in Activity's detail pane).
 */
export function markOpenThreadUnread(threadChannelId: string): void {
  holdThreadUnread(threadChannelId, () => {
    const row = useInboxStore.getState().items.find((item) => item.kind === "thread" && item.threadChannelId === threadChannelId);
    if (row && row.unreadCount > 0) void toggleActivityRowRead(row, true);
    else useThreadStore.getState().clearThreadUnread(threadChannelId);
  });
  void markThreadUnreadFromThread(threadChannelId);
}

/** The thread a ThreadPanel shows, for its messages' menus (null outside a thread panel). */
export interface OpenThreadIdentity {
  threadChannelId: string | null;
  parentMessageId: string | null;
}

export const OpenThreadContext = createContext<OpenThreadIdentity | null>(null);

/**
 * The thread's Mark as Unread, shared by its header ⋯ menu and its messages'
 * menus: null when there is none (no thread channel yet, or a thread the
 * person doesn't follow, as its Activity row has none).
 */
export function useOpenThreadMarkUnread(thread: OpenThreadIdentity | null): (() => void) | null {
  const threadChannelId = thread?.threadChannelId ?? null;
  const parentMessageId = thread?.parentMessageId ?? null;
  const followed = useThreadStore((state) => (parentMessageId ? isThreadFollowed(state, parentMessageId) : false));
  const markUnread = useCallback(() => {
    if (threadChannelId) markOpenThreadUnread(threadChannelId);
  }, [threadChannelId]);
  return followed && threadChannelId ? markUnread : null;
}

/** The enclosing thread panel's Mark as Unread, for a message's menu (null outside a thread panel). */
export function useEnclosingThreadMarkUnread(): (() => void) | null {
  return useOpenThreadMarkUnread(useContext(OpenThreadContext));
}
