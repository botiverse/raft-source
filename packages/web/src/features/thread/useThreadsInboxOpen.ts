import { useCallback, useEffect, useRef } from "react";
import { useInboxStore } from "../../store/inboxStore";
import type { InboxItem, ObjectActivityItem } from "../../store/inboxStore";
import { inboxItemChannelId } from "../../store/inboxItem";
import { isScopeMarkedUnread } from "../../store/markedUnreadStore";
import { rememberArtifactCard } from "../../apps/artifacts";
import { useMessageStore } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useSearchContentStore } from "../../store/searchContentStore";
import type { SearchContentSlot } from "../../store/searchContentStore";
import { holdAutoRead, releaseAutoRead } from "../../store/autoReadHold";
import { pickReopen, readLastOpenedActivityKey, writeLastOpenedActivityKey } from "../../components/thread/activityArrivalOpen";
import { trackActivityItemOpen } from "../../analytics/activity";
import type { useAppNavigate } from "../../hooks/useAppNavigate";
import { isActivityMasterDetailViewport } from "../../components/thread/activityLayout";
import { activityVisit } from "../../components/thread/activityVisit";
import { isTaskConversationItem } from "../../utils/taskConversation";
import { itemKey } from "./inboxRowShared";
import type { ThreadInboxItem } from "./inboxRowShared";
import { objectRowSlot } from "./threadsInboxHelpers";

type InboxState = ReturnType<typeof useInboxStore.getState>;
type ThreadState = ReturnType<typeof useThreadStore.getState>;
type SearchContentState = ReturnType<typeof useSearchContentStore.getState>;

/**
 * Opening Activity rows (ThreadsInbox): a single click previews the row in
 * Activity's detail slot (`handleOpen`), a double click goes to the full
 * conversation (`navigateToChat`), an object row opens its object, and on
 * arrival desktop reopens the conversation opened last time (`reopen`).
 */
export function useThreadsInboxOpen({
  contentSlot,
  loaded,
  markRead,
  nav,
  openContentSlot,
  openTaskConversation,
  openThread,
  visibleItems,
}: {
  contentSlot: SearchContentSlot | null;
  loaded: boolean;
  markRead: InboxState["markRead"];
  nav: ReturnType<typeof useAppNavigate>;
  openContentSlot: SearchContentState["open"];
  openTaskConversation: ThreadState["openTaskConversation"];
  openThread: ThreadState["openThread"];
  visibleItems: InboxItem[];
}) {
  // Desktop: double-click an Activity item → navigate into the full chat page
  // focused on the message, identical to a /search result (MessageSearchPage
  // uses the same `event.detail >= 2` gesture + `nav.to*Message`). Single-click
  // keeps the col-3 master/detail preview via `handleOpen`, delayed 220ms so a
  // double doesn't also fire the single. On a phone the opened conversation
  // replaces the list, so a tap opens it at once instead of waiting for a
  // double-click. (stdrc #proj-activity:171042a3 2026-07-04)
  const activateTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
    };
  }, []);

  // Task v2: a task conversation row opens its task in Activity's detail slot
  // (stdrc), as an object row opens its object: beside the list on desktop, a
  // page pushed in place of it on a phone; there for a double click too, as
  // the task has no place in the channel timeline to jump to. Not the task
  // dialog: RightPanel leaves it out while the slot is a task. The task rides
  // in threadStore's taskModal slot, which the detail slot's page reads.
  const openTaskConversationRow = useCallback((item: ThreadInboxItem) => {
    if (!item.taskId) return;
    const targetMessageId = item.firstMentionMessageId
      ?? (item.unreadCount > 0 ? item.firstUnreadMessageId ?? item.latestActivityMessageId : null);
    writeLastOpenedActivityKey(useServerStore.getState().current?.id, itemKey(item));
    releaseAutoRead({ read: false });
    // Swapping what is open drops a col-4 thread of the previous conversation.
    useThreadStore.getState().closeThread();
    // The row's conversation is the reader's local one: the task uses it as is.
    openTaskConversation({
      taskId: item.taskId,
      parentChannelId: item.parentChannelId,
      conversationChannelId: item.threadChannelId,
      focusedMessageId: targetMessageId,
    });
    openContentSlot({ kind: "task", id: item.taskId });
  }, [openContentSlot, openTaskConversation]);

  // An object row opens its object in Activity's detail slot, as a
  // conversation row opens its conversation (xxchan, Remy): beside the list
  // on desktop, a page pushed in place of it on a phone; at once on every
  // device and for a double click too, as it has no conversation to jump to.
  // Opening reads it, as opening a conversation row does, and records
  // activity_item_open with its object kind (`artifact`; a new kind must be
  // added to the event's item_kind first); the viewer records
  // `artifact_opened` source `activity`. It is the last row opened, so
  // arriving again reopens no older conversation; an Artifact itself is not
  // reopened (`reopen`).
  const openObjectRow = useCallback((item: ObjectActivityItem) => {
    if (activateTimerRef.current !== null) {
      window.clearTimeout(activateTimerRef.current);
      activateTimerRef.current = null;
    }
    writeLastOpenedActivityKey(useServerStore.getState().current?.id, itemKey(item));
    releaseAutoRead({ read: false });
    trackActivityItemOpen(item.objectKind);
    if (item.unreadCount > 0) void markRead(item);
    // Swapping what is open drops a col-4 thread of the previous conversation.
    useThreadStore.getState().closeThread();
    // Its viewer draws the row's card as its header until its own data is in.
    if (item.summary) rememberArtifactCard(item.summary);
    openContentSlot(objectRowSlot(item));
  }, [markRead, openContentSlot]);

  const navigateToChat = useCallback((item: InboxItem) => {
    if (item.kind === "object") {
      openObjectRow(item);
      return;
    }
    if (item.kind === "thread" && isTaskConversationItem(item)) {
      openTaskConversationRow(item);
      return;
    }
    if (item.kind === "thread") {
      // Prefer the first message that actually @-mentions the user (when the row
      // carries a mention) over the first unread message, so mention rows focus
      // the mention instead of the earliest unread reply.
      const targetMessageId = item.firstMentionMessageId
        ?? (item.unreadCount > 0
          ? item.firstUnreadMessageId ?? item.latestActivityMessageId
          : item.latestActivityMessageId);
      // This gesture leaves Activity for a canonical thread permalink. Do not
      // pre-open threadStore: its store→URL subscriber would first PUSH
      // /activity?thread= and the route navigation below would PUSH again.
      // The destination URL already carries the complete thread identity, so
      // MainLayout's URL→store projection seeds threadStore after the single
      // navigation. One surface transition must own one history write.
      nav.toThreadMessage(
        item.parentChannelId,
        item.parentMessageId,
        targetMessageId,
        item.parentChannelType === "dm" ? "dm" : "channel",
      );
      return;
    }
    if (item.kind === "mention_action") {
      if (item.channelType === "dm") nav.toDmMessage(item.channelId, item.messageId);
      else nav.toMessage(item.channelId, item.messageId);
      return;
    }
    // channel | dm
    const targetMessageId = item.firstUnreadMessageId ?? item.lastMessageId;
    if (item.kind === "dm") nav.toDmMessage(item.channelId, targetMessageId);
    else nav.toMessage(item.channelId, targetMessageId);
  }, [nav, openObjectRow, openTaskConversationRow]);

  const handleOpen = useCallback((item: InboxItem, { automatic = false }: { automatic?: boolean } = {}) => {
    // Never reopened on arrival (`reopen`).
    if (item.kind === "object") {
      if (!automatic) openObjectRow(item);
      return;
    }
    writeLastOpenedActivityKey(useServerStore.getState().current?.id, itemKey(item));
    // Picking any row ends a hold on the reopened one without reading it.
    // Reopened on arrival (`automatic`, see `reopen`): no open event and no
    // read; the hold keeps it unread until the person acts in it.
    releaseAutoRead({ read: false });
    if (!automatic) {
      trackActivityItemOpen(item.kind);
      if (item.unreadCount > 0 || isScopeMarkedUnread(inboxItemChannelId(item))) void markRead(item);
    }
    // Every width opens the conversation in Activity's detail slot, the same
    // interaction as picking a /search result (stdrc #proj-activity:171042a3
    // 2026-06-23). On desktop it sits beside the list; on a phone it is a page
    // pushed inside Activity with a Back to the list, and Activity stays
    // selected (MainLayout, InboxContentRoute). It never leaves for the
    // conversation's own route.
    const masterDetail = isActivityMasterDetailViewport();

    if (item.kind === "thread" && isTaskConversationItem(item)) {
      openTaskConversationRow(item);
      return;
    }
    if (item.kind === "thread") {
      const targetMessageId = item.unreadCount > 0
        ? item.firstUnreadMessageId ?? item.latestActivityMessageId
        : item.latestActivityMessageId;
      // Mark the slot as a thread so InboxContentRoute renders ThreadPanel in
      // the detail slot (not the col-4 overlay). This in-place surface is
      // store-owned, so seed threadStore directly.
      // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: item.parentChannelId,
        parentMessageId: item.parentMessageId,
        focusedMessageId: targetMessageId,
        initialThreadChannelId: item.threadChannelId,
      });
      // Stryker restore all
      openContentSlot({ kind: "thread", id: item.threadChannelId, messageId: targetMessageId });
      return;
    }

    if (item.kind === "mention_action") {
      openContentSlot({ kind: "channel", id: item.channelId, messageId: item.messageId });
      return;
    }

    const unreadTarget = item.unreadCount > 0
      ? item.firstUnreadMessageId ?? item.lastMessageId
      : item.lastMessageId;
    // A phone opens at the first message that mentions you, as it always has;
    // beside the list it opens at the first unread.
    const targetMessageId = masterDetail ? unreadTarget : item.firstMentionMessageId ?? unreadTarget;
    // Swapping the opened conversation drops any col-4 thread from the
    // previous one (mirror MessageSearchPage.openResult).
    useThreadStore.getState().closeThread();
    openContentSlot({
      kind: item.kind === "dm" ? "dm" : "channel",
      id: item.channelId,
      messageId: targetMessageId,
    });
  }, [markRead, openContentSlot, openObjectRow, openTaskConversationRow, openThread]);

  // Reopens `item` without reading it: auto-read is held for it until the
  // person acts in it. The hold ends, unread, as soon as the detail pane shows
  // anything else (closed, another row, another page).
  const reopen = useCallback((item: InboxItem) => {
    // Not an Artifact: loading its viewer reads it (the app advances its read
    // position), and there is no hold to keep it unread until acted in.
    // Not a task conversation either: opening its task reads it
    // (openTaskConversation), with no hold to keep it unread. It stays the
    // last row opened, so arriving again reopens no older conversation.
    if (item.kind === "object" || (item.kind === "thread" && isTaskConversationItem(item))) return;
    handleOpen(item, { automatic: true });
    const id = item.kind === "thread" ? item.threadChannelId : item.channelId;
    const key = itemKey(item);
    const unsubscribe = useSearchContentStore.subscribe((state) => {
      if (state.slot?.id !== id) releaseAutoRead({ read: false });
    });
    holdAutoRead(id, {
      end: unsubscribe,
      read: () => {
        // Read it the way picking the row does, with the row as it is now.
        const fresh = useInboxStore.getState().items.find((candidate) => itemKey(candidate) === key) ?? item;
        if (fresh.unreadCount > 0 || isScopeMarkedUnread(inboxItemChannelId(fresh))) void markRead(fresh);
        if (item.kind === "thread") {
          if (fresh.unreadCount === 0) useThreadStore.getState().clearThreadUnread(id);
        } else if (useMessageStore.getState().currentChannelId === id) {
          useMessageStore.getState().markCurrentChannelRead();
        }
      },
    });
  }, [handleOpen, markRead]);

  // On arrival (once per visit to Activity, after the list first loads),
  // desktop Activity reopens the conversation opened last time, when it is
  // still listed; otherwise the right side stays empty. Nothing happens when
  // something is already open (a link, Back) or on a phone, where opening is
  // a pushed page. The list remounts when the detail pane opens or closes, so
  // "once" is per visit, not per mount.
  useEffect(() => {
    if (!loaded || !activityVisit.claimArrival()) return;
    if (contentSlot || !isActivityMasterDetailViewport()) return;
    const item = pickReopen(visibleItems, itemKey, readLastOpenedActivityKey(useServerStore.getState().current?.id));
    if (!item) return;
    // Opened on the next task, not now: when the list renders in the same
    // commit as the route change (a visit after the first), MainLayout's URL
    // sync runs its effect after this one and, with no `?open=` in the URL
    // yet, would close a conversation opened now. By then the visit may have
    // ended or something else may be open; then nothing is reopened.
    const visit = activityVisit.current();
    window.setTimeout(() => {
      if (visit !== activityVisit.current() || !activityVisit.isActive() || useSearchContentStore.getState().slot) return;
      reopen(item);
    }, 0);
  }, [contentSlot, loaded, reopen, visibleItems]);
  // The list is an Activity surface: the visit (and a hold on the reopened
  // conversation) lasts while it or the opened conversation's pane is mounted.

  return { activateTimerRef, handleOpen, navigateToChat, openObjectRow };
}
