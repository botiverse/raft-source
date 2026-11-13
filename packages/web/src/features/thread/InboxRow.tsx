import { memo, useCallback, useId, useMemo } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import Tooltip from "../../components/ui/Tooltip";
import { AtSign, BellOff, Check, MessageSquareCheck, MessageSquareDot, Pencil } from "lucide-react";
import type { ConversationInboxItem, InboxFilter, InboxItem } from "../../store/inboxStore";
import { inboxItemChannelId } from "../../store/inboxItem";
import { useScopeMarkedUnread } from "../../store/markedUnreadStore";
import { QuietUnreadDot } from "../../components/layout/QuietUnreadDot";
import { InboxItemBody, InboxItemContent, InboxItemHeading, InboxItemHoverTarget, InboxItemMarks, InboxItemSender, InboxItemTitle, InboxItemTrigger, MessageItemSearchMatch, InboxItem as RaftInboxItem, SidebarItemCount, SidebarItemIndicator } from "@botiverse/raft-ui";
import { UnfollowThreadIcon } from "@botiverse/ricons";
import { InboxItemLine, InboxItemStatus } from "@botiverse/raft-ui/wip";
import { useMessageStore } from "../../store/messageStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import { useLoungeAgentId } from "../../store/useStoredChannel";
import { useLoungeTitle } from "../../components/agent/agentLounge";
import type { Channel } from "../../store/channelStore";
import { useAgentStore, useAppBotAgent } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useActorFallback } from "../../store/localTables/useActorFallback";
import { useTaskMetadataForMessage } from "../../store/taskStore";
import type { TaskStatus } from "../../store/taskStore";
import { StatusBadge } from "../../components/task/StatusBadge";
import { TASK_STATUS_UI, toRuiTaskStatus } from "../../components/task/taskStatusUi";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import InlineMarkdownPreview from "../../components/markdown/InlineMarkdownPreview";
import AvatarSlot from "../../components/ui/AvatarSlot";
import { ConversationAvatar } from "../../components/thread/ConversationAvatar";
import AppBadge from "../../components/agent/AppBadge";
import { itemFilterChannelLabel } from "../../components/thread/inboxChannelFilter";
import { dismissLayerProps } from "../../components/ui/dismissLayer";
import { useLongPress } from "../../hooks/useLongPress";
import { ROW_SWIPE_ACTION_ATTR, ROW_SWIPE_BUTTON_WIDTH, useRowSwipe } from "../../hooks/useRowSwipe";
import { canMuteActivityRow, canSwipeActivityRowRead, canUnfollowActivityRow, toggleActivityRowRead } from "../../components/thread/inboxRowActions";
import { delegatedByOf, formatDelegatedSender, isRetractedPreviewOf } from "../../components/message/delegatedMessage";
import { formatTaskConversationRef, isTaskConversationItem } from "../../utils/taskConversation";
import { useTaskConversationTask } from "../../components/task/useTaskConversationTask";
import { ActivityRowTime } from "./ActivityRowTime";
import { inboxItemTime } from "./activityDayGroups";
import { InboxRowDone } from "./InboxRowDone";
import { SWIPE_DONE_BUTTON_CLASS, SWIPE_LAYER_CLASS, SWIPE_QUIET_BUTTON_CLASS, SWIPE_ROW_CLASS, SWIPE_START_BUTTON_CLASS, SWIPE_START_LABEL_CLASS, SWIPE_START_LAYER_CLASS, UNREAD_BODY_CLASS, activityMentionsOnly, asThreadItem, itemKey, itemUnreadCount, useMergedRowRef } from "./inboxRowShared";
import type { RowSwipeProps } from "./inboxRowShared";

// A row out of view is not laid out or painted (content-visibility: auto),
// sized by its remembered height. Only once it has been laid out for real
// (data-laid-out, set by markLaidOut): before that its height is unknown, and
// a guessed one put a restored scroll position and a jump to an off-screen
// row on the wrong row (Tenny, #11363).
const ROW_OFFSCREEN_CLASS = "[contain-intrinsic-size:auto_64px] data-[laid-out]:[content-visibility:auto]";

function stripActivityTitlePrefix(value: string): string {
  return value.replace(/^[@#]+/, "");
}

function highlightActivitySearchText(value: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return value;
  const lowerValue = value.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let index = lowerValue.indexOf(lowerNeedle);
  while (index !== -1) {
    if (index > cursor) parts.push(value.slice(cursor, index));
    const match = value.slice(index, index + needle.length);
    parts.push(
      <MessageItemSearchMatch key={`${index}-${match}`}>
        {match}
      </MessageItemSearchMatch>,
    );
    cursor = index + needle.length;
    index = lowerValue.indexOf(lowerNeedle, cursor);
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function renderActivityPreview(markdown: string, query: string, retractedLine?: string): ReactNode {
  // RFC 077: a retracted message's preview is the muted retracted line, never its text.
  if (retractedLine) {
    return <span className="text-foreground-hint" data-testid="activity-preview-retracted">{retractedLine}</span>;
  }
  return query.trim()
    ? highlightActivitySearchText(markdown, query)
    : <InlineMarkdownPreview markdown={markdown} />;
}

function InboxRowImpl({ item, filter, searchQuery, taskV2, onOpen, onDone, swipe: rowSwipe, onContextMenu, onLongPress, focused, active, located, focusRef }: {
  item: ConversationInboxItem;
  filter: InboxFilter;
  searchQuery: string;
  /** Task v2 is on for this server: Activity shows no task numbers (raft-design raft-chat, "The bell and Activity"). */
  taskV2: boolean;
  onOpen: (e: React.MouseEvent | ReactKeyboardEvent, item: InboxItem) => void;
  onDone: (item: InboxItem) => void;
  /** A phone: the row's actions are the buttons its swipes uncover (left: Done and the rest; right: Read or Unread), and its press-and-hold menu, with no button shown in the row. */
  swipe?: RowSwipeProps;
  onContextMenu: (e: React.MouseEvent, item: InboxItem) => void;
  /** Press-and-hold on a touch screen opens the same menu right-click opens. */
  onLongPress: (coords: { x: number; y: number }, item: InboxItem) => void;
  /** The row a focus request (double-click, permalink) is for: scrolled to. */
  focused?: boolean;
  /** Open in col 3: raft-ui's active look, for as long as it is open. */
  active?: boolean;
  /** The row a jump just took someone to (re-tap, double-click, permalink):
   *  the located highlight (states.md#located), from `useLocated`. */
  located?: boolean;
  focusRef?: React.Ref<HTMLDivElement>;
}) {
  const { formatMessage } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const serverPublicPageLive = useServerStore((s) => s.current?.publicPageLive === true);
  const currentUser = useAuthStore((s) => s.user);
  // Task v2: a task conversation row has no parent message; its task is the
  // row's subject (title `#channel:#7 title`), live from the task lists.
  const taskConversation = item.kind === "thread" && isTaskConversationItem(item) ? item : null;
  const realtimeTaskMetadata = useTaskMetadataForMessage(item.kind === "thread" && !taskConversation ? item.parentMessageId : null);
  // The row names its task; the task itself (its channel's task list, loaded
  // once per channel) keeps the title, status and reply count live, and its
  // reply count is the one every task surface shows: replies by people and
  // agents, not lifecycle lines (the served row's replyCount counts those).
  const conversationTask = useTaskConversationTask({
    taskId: taskConversation?.taskId ?? null,
    parentChannelId: taskConversation?.parentChannelId ?? null,
  });

  const unreadCount = itemUnreadCount(item);
  // Marked unread with nothing countable: unread with a dot, no number.
  const markedUnread = useScopeMarkedUnread(inboxItemChannelId(item)) && unreadCount === 0;
  const shouldShowMentionBadge = !activityMentionsOnly(filter) && item.hasMention && unreadCount > 0;

  // Agent Lounge: a Lounge row (or a thread in one) is named and drawn as
  // its agent's Lounge. The Lounge is in neither list above: the store's
  // Lounge slice, or the agent DM row that carries it, says whose it is.
  const rowConversationId = item.kind === "thread" ? item.parentChannelId : item.channelId;
  const rowLoungeAgentId = useLoungeAgentId(item.kind === "dm" ? null : rowConversationId);
  const rowLoungeTitle = useLoungeTitle(
    rowLoungeAgentId,
    item.kind === "thread" ? item.parentChannelName : item.channelName,
  );
  const channelLabel = rowLoungeTitle ?? itemFilterChannelLabel(item, channels, dmChannels);
  const titleLabel = (() => {
    if (item.kind === "thread") return null;
    if (rowLoungeTitle) return rowLoungeTitle;
    if (item.kind === "mention_action") return stripActivityTitlePrefix(item.channelName);
    if (item.kind === "dm") {
      const ch = dmChannels.find((c) => c.id === item.channelId);
      return stripActivityTitlePrefix(ch?.peerDisplayName || ch?.peerName || item.channelName);
    }
    return stripActivityTitlePrefix(item.channelName);
  })();

  const senderType = item.kind === "thread" ? item.latestActivitySenderType : item.kind === "mention_action" ? "system" : item.lastMessageSenderType;
  const senderId = item.kind === "thread" ? item.latestActivitySenderId : item.kind === "mention_action" ? "" : item.lastMessageSenderId;
  const senderAgent = senderType === "agent" ? agents.find((a) => a.id === senderId) : null;
  const senderMember = senderType === "user"
    ? resolveMessageSenderMemberFromList({ senderType, senderId }, members, currentUser) ?? null
    : null;
  // A joint channel's other server: neither roster has them, so the actors
  // table (filled by channel rosters and `/actors/resolve`) does. Only joint
  // rows ask: anyone else is this server's, and its rosters will have them.
  const jointRow = item.kind === "thread" ? item.parentChannelType === "joint" : item.kind !== "mention_action" && item.channelType === "joint";
  const senderActor = useActorFallback(
    jointRow && senderId && senderId !== "system" && (senderType === "agent" ? !senderAgent : senderType === "user" && !senderMember)
      ? { kind: senderType === "agent" ? "agent" : "human", id: senderId }
      : null,
  );
  const senderName = senderAgent?.displayName
    ?? senderAgent?.name
    ?? senderMember?.displayName
    ?? senderMember?.name
    ?? senderActor?.displayName
    ?? senderActor?.name
    ?? (item.kind === "thread"
      ? item.latestActivitySenderName
      : item.kind === "channel" || item.kind === "dm"
        ? item.lastMessageSenderName
        : null);
  // System rows take the localized label first: a system row carries a raw
  // English `lastMessageSenderName` ("System") in its data, so resolving
  // senderName first would show that English and bypass the zh catalog. Detect
  // system identity by the real transport shape — mention_action rows surface
  // senderType "system", while channel/dm system broadcasts arrive as senderType
  // "user" with senderId "system" (messageService `createMessage(…, "user",
  // "system", …, "system")). Localize both; fall back to the
  // resolved name for genuine user/agent rows.
  const isSystemSender = senderType === "system" || senderId === "system";
  // RFC 077: "Alice (sent by Friday)" when her assistant sent it.
  const senderDelegatedBy = isSystemSender
    ? null
    : delegatedByOf({ delegatedBy: item.kind === "mention_action" ? null : item.latestDelegatedBy });
  const activitySenderLabel = isSystemSender
    ? formatMessage({ id: "thread.row.systemSender" })
    : senderName
      ? formatDelegatedSender(formatMessage, senderName, senderDelegatedBy)
      : null;
  const rawThreadItem = asThreadItem(item);
  const threadItem = useMemo(() => {
    if (rawThreadItem && conversationTask) {
      return {
        ...rawThreadItem,
        taskNumber: conversationTask.taskNumber,
        taskStatus: conversationTask.status,
        taskClaimedByName: conversationTask.claimedByName ?? null,
        taskTitle: conversationTask.title,
        replyCount: conversationTask.conversationReplyCount ?? rawThreadItem.replyCount,
      };
    }
    if (!rawThreadItem || !realtimeTaskMetadata) return rawThreadItem;
    return {
      ...rawThreadItem,
      taskNumber: realtimeTaskMetadata.taskNumber,
      taskStatus: realtimeTaskMetadata.status,
      taskClaimedByName: realtimeTaskMetadata.claimedByName ?? null,
    };
  }, [conversationTask, rawThreadItem, realtimeTaskMetadata]);
  // A task conversation's address (`#channel:#7`) and its task's title. With
  // task v2 on a task with no title falls back to words with no number
  // ("#proj task"); with it off, to the address.
  const taskConversationParts = (() => {
    if (!taskConversation || !threadItem) return null;
    const dmPeer = taskConversation.parentChannelType === "dm"
      ? dmChannels.find((c) => c.id === taskConversation.parentChannelId)
      : null;
    const ref = threadItem.taskNumber != null
      ? formatTaskConversationRef({
        taskNumber: threadItem.taskNumber,
        channelName: taskConversation.parentChannelName,
        channelType: taskConversation.parentChannelType,
        dmPeerName: dmPeer?.peerName ?? null,
      })
      : null;
    const title = threadItem.taskTitle?.trim() || taskConversation.parentMessagePreview?.trim() || null;
    const noTitle = title === null && taskV2
      ? formatMessage({ id: "activity.list.taskFallbackTitle" }, { channel: channelLabel })
      : null;
    return { ref, title, noTitle };
  })();
  const hasThreadDraft = useMessageStore((s) =>
    threadItem ? !!s.drafts[threadItem.threadChannelId]?.trim() : false
  );
  const preview = item.kind === "thread"
    ? item.parentMessagePreview
    : item.kind === "mention_action"
      ? item.messagePreview
      : item.lastMessagePreview;
  const activityPreview = item.kind === "thread" ? item.latestActivityPreview : preview;
  const retractedLine = formatMessage({ id: "message.delegated.retracted" });
  // RFC 077: the server's flag for the row's latest message; an older server
  // has none, so the placeholder text decides. Nothing produces mention_action
  // rows at all (no server or transport producer), so they never show the line.
  const activityRetracted = item.kind !== "mention_action"
    && isRetractedPreviewOf(item.latestRetracted, activityPreview);
  // Task #164: a row from the saved copy carries no message text (no preview,
  // no parent message). Its excerpt line keeps the sender alone, so the row
  // keeps its height, and a thread is titled by its channel.
  const hasActivityPreview = activityRetracted || (activityPreview ?? "").trim() !== "";
  const parentRetracted = item.kind === "thread" && isRetractedPreviewOf(item.parentRetracted, item.parentMessagePreview);
  const primaryContent = item.kind === "thread"
    ? !parentRetracted && (item.parentMessagePreview ?? "").trim() === ""
      ? formatMessage({ id: "thread.row.savedThreadTitle" }, { conversation: channelLabel })
      // The parent's own flag; an older server has none, so the placeholder text decides.
      : renderActivityPreview(
        item.parentMessagePreview,
        searchQuery,
        parentRetracted ? retractedLine : undefined,
      )
    : titleLabel
      ? highlightActivitySearchText(titleLabel, searchQuery)
      : null;
  // The conversation's channel type picks its kind icon, as in the sidebar.
  const rowChannelType: Channel["type"] = item.kind === "thread" ? item.parentChannelType : item.channelType;
  const rowChannel = findStoredChannel({ channels, dmChannels, loungeChannels }, rowConversationId);
  // A task row's title is the task's own title. The body line names where it
  // is, like a thread row's channel: `#channel`, or with task v2 off its
  // address (`#channel:#7`).
  const listPrimaryContent = taskConversationParts
    ? <span data-testid="conversation-card-task-title">{highlightActivitySearchText(taskConversationParts.title ?? taskConversationParts.noTitle ?? taskConversationParts.ref ?? "", searchQuery)}</span>
    : primaryContent;
  const titleIconKind = taskConversation
    ? "task"
    : item.kind === "thread"
    ? "thread"
    : item.kind === "dm" || (item.kind === "mention_action" && item.channelType === "dm")
      ? "dm"
      : "channel";
  // A thread in a DM: its row leads with the peer's face, so the
  // second line drops the "@peer ·" label the face already says.
  const threadDmChannel = item.kind === "thread" && item.parentChannelType === "dm"
    ? dmChannels.find((c) => c.id === item.parentChannelId) ?? null
    : null;
  const subtitleContent = item.kind === "thread" ? channelLabel : null;
  const taskRefInBody = !taskV2 && taskConversationParts?.title ? taskConversationParts.ref : null;
  // Words standing in for the title already say the channel.
  const channelInBody = !!subtitleContent && (!taskConversation || (taskV2 && !taskConversationParts?.noTitle));
  const taskStatus = (threadItem?.taskStatus ?? null) as TaskStatus | null;
  // A legacy task's thread: its number stays beside the title without task v2,
  // where the badge is also the row's only sign of the status; with task v2 on
  // the number goes and the status moves to the marks, as a task's own row's.
  const legacyTaskRow = !taskConversation && threadItem?.taskNumber != null && taskStatus !== null;
  const legacyTaskNumberBadge = legacyTaskRow && !taskV2;
  const statusInMarks = taskStatus !== null && (taskConversation !== null || (legacyTaskRow && taskV2));
  const rowTime = inboxItemTime(item);
  const bodyContent = hasActivityPreview ? (
    <>
      {activitySenderLabel ? <InboxItemSender>{activitySenderLabel}: </InboxItemSender> : null}
      {renderActivityPreview(activityPreview, searchQuery, activityRetracted ? retractedLine : undefined)}
    </>
  ) : activitySenderLabel ? (
    <InboxItemSender data-testid="conversation-card-sender-only">{activitySenderLabel}</InboxItemSender>
  ) : null;
  // The sender's face before their name, so a row says who spoke
  // while the leading tile says the place: the channel, or a channel thread's
  // or task's own mark (xxchan picked option C).
  // DM rows and DM threads already lead with the peer's face, so they skip it.
  // A sender in neither roster (a joint channel's other server) takes the
  // avatar the row carries, as a chat message does. One still unresolved (not
  // loaded yet, or gone), or a person without a stored avatar, keeps a
  // placeholder face so rows stay aligned.
  // The row's own avatar is the fresher; the actors table fills it when a
  // realtime update that changed the sender nulled it.
  const rowSenderAvatarUrl = item.kind === "mention_action" ? null : item.senderAvatarUrl ?? senderActor?.avatarUrl ?? null;
  const senderAvatar = isSystemSender || titleIconKind === "dm" || threadDmChannel ? null : senderType === "agent" ? (
    <AvatarSlot context="sidebar-list" type="agent" agentAvatarUrl={senderAgent ? senderAgent.avatarUrl ?? null : rowSenderAvatarUrl} />
  ) : senderType === "user" ? (
    <AvatarSlot
      context="sidebar-list"
      type="human"
      humanAvatarUrl={senderMember ? senderMember.avatarUrl ?? null : rowSenderAvatarUrl}
    />
  ) : null;
  const listBodyContent = (
    <>
      {senderAvatar && activitySenderLabel ? (
        <span className="mr-1 inline-flex align-[-2px]" data-testid="conversation-card-sender-avatar">
          {senderAvatar}
        </span>
      ) : null}
      {bodyContent}
    </>
  );
  const dmChannel = item.kind === "dm" || (item.kind === "mention_action" && item.channelType === "dm")
    ? dmChannels.find((c) => c.id === item.channelId) ?? null
    : null;
  // A DM with an App bot names it with the App badge beside the name, as its
  // DM header and messages do, and its face carries no status light.
  const dmPeerAppBot = useAppBotAgent(dmChannel?.peerType === "agent" ? dmChannel.peerId : null);
  const dmAppBot = titleLabel ? dmPeerAppBot : null;
  // The trigger is an empty button over the row; it takes its name from the
  // row's title (with an App bot's Bot badge) and excerpt.
  const titleId = useId();
  const badgeId = useId();
  const bodyId = useId();
  const statusId = useId();
  const timeId = useId();
  const handleLongPress = useCallback((coords: { x: number; y: number }) => onLongPress(coords, item), [item, onLongPress]);
  const longPress = useLongPress(handleLongPress);
  const longPressSuppressClickRef = longPress.suppressClickRef;
  const { onTouchStart: handleTouchStart, onTouchMove: handleTouchMove, onTouchEnd: handleTouchEnd, onTouchCancel: handleTouchCancel } = longPress;
  const handleOpen = useCallback((event: React.MouseEvent | ReactKeyboardEvent) => {
    // The press that opened the menu must not also open the item.
    if (longPressSuppressClickRef.current) {
      longPressSuppressClickRef.current = false;
      return;
    }
    onOpen(event, item);
  }, [item, longPressSuppressClickRef, onOpen]);
  // Enter/Space open the item once: handled on keydown, with the button's own
  // activation click prevented.
  const handleKeyDown = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen(event, item);
  }, [item, onOpen]);
  const handleContextMenu = useCallback((event: React.MouseEvent) => onContextMenu(event, item), [item, onContextMenu]);
  const handleDone = useCallback(() => onDone(item), [item, onDone]);
  // On a phone the row swipes left to uncover its buttons (raft-design
  // #785): Done, then Unfollow on a followed thread or Mute on a joined
  // channel (or a DM that can be muted) whose activity isn't muted. It
  // swipes right to uncover one button (#793): Read on an unread row, Unread
  // on a read one, as its menu item. A row that couldn't be seen to switch
  // has no right swipe: an unfollowed thread (its menu has neither), a direct
  // mention (it has no read state of its own) or a muted conversation's row
  // (drawn quiet, read or not). A full right swipe applies it and the row
  // stays where it is, with no toast: swiping again switches it back.
  // A long press that already opened the menu keeps the stroke.
  const swipeEnabled = rowSwipe !== undefined;
  const swipeActions = rowSwipe?.actions;
  const swipeKey = itemKey(item);
  const swipeUnfollow = canUnfollowActivityRow(item);
  const swipeMuteChannel = item.kind === "channel" ? findStoredChannel({ channels, dmChannels, loungeChannels }, item.channelId)
    : item.kind === "dm" ? dmChannel ?? undefined
      : undefined;
  const swipeMute = canMuteActivityRow(item, swipeMuteChannel);
  const swipeButtonCount = 1 + (swipeUnfollow ? 1 : 0) + (swipeMute ? 1 : 0);
  const mutedChannelId = item.kind === "thread" ? item.parentChannelId : item.channelId;
  const muted = !!(findStoredChannel({ channels, dmChannels, loungeChannels }, mutedChannelId) ?? dmChannel ?? threadDmChannel)?.activityMuted;
  const swipeReadToggle = canSwipeActivityRowRead(item, muted);
  const swipeMarksRead = item.unreadCount > 0 || markedUnread;
  const setSwipeOpen = useCallback((open: boolean) => rowSwipe?.onOpenChange(swipeKey, open), [rowSwipe, swipeKey]);
  const handleFullSwipe = useCallback(() => swipeActions?.done(item), [item, swipeActions]);
  // What the row showed when the finger lifted (or the button was tapped):
  // the hook keeps this callback from the release, not from a later render.
  const handleReadToggle = useCallback(() => void toggleActivityRowRead(item, swipeMarksRead, formatMessage), [formatMessage, item, swipeMarksRead]);
  const longPressOpenedMenu = useCallback(() => longPressSuppressClickRef.current, [longPressSuppressClickRef]);
  const swipe = useRowSwipe<HTMLDivElement>({
    enabled: swipeEnabled,
    end: { width: swipeButtonCount * ROW_SWIPE_BUTTON_WIDTH, onFullSwipe: handleFullSwipe, fullSwipe: "remove" },
    start: swipeReadToggle ? { width: ROW_SWIPE_BUTTON_WIDTH, onFullSwipe: handleReadToggle, fullSwipe: "keep" } : undefined,
    open: rowSwipe?.open ?? false,
    onOpenChange: setSwipeOpen,
    shouldYield: longPressOpenedMenu,
  });
  const rowRef = useMergedRowRef(focusRef, swipe.ref);

  // Raft Design System › InboxItem: the row is raft-ui's InboxItem in its line
  // layout. Its trigger covers the row and takes the clicks, keyboard focus and
  // focus ring; the time ends the first line and the marks the second; Mark as
  // Done (InboxRowDone) shows with a mouse while the row is hovered, holds focus
  // or is open, and the time and marks move over for it. On a tablet's touch
  // screen it rests in the row (the press-and-hold menu carries it too). On a
  // phone the row has no button: Mark as Done is the left swipe and the
  // press-and-hold menu's item (stdrc, raft-design #769).
  const rowProps = {
    ref: rowRef,
    "data-testid": "inbox-row",
    "data-inbox-key": itemKey(item),
    "data-focused": focused ? "true" : undefined,
    "data-located": located ? "" : undefined,
    active: Boolean(active),
    onContextMenu: handleContextMenu,
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
    ...(swipeEnabled ? swipe.handlers : {}),
    // The open row closes on a press elsewhere (the list's listener, below):
    // while it is open it is an outside-press layer, so a host with native
    // chrome (the desktop shell's title bar) lets that press reach the page.
    ...(rowSwipe?.open ? dismissLayerProps : {}),
  };
  const trigger = (
    <InboxItemTrigger
      data-testid="inbox-row-open"
      aria-current={active ? "true" : undefined}
      // The name says the status and the time in words, on screen or not.
      aria-labelledby={[titleId, dmAppBot ? badgeId : null, bodyId, statusInMarks ? statusId : null, timeId].filter(Boolean).join(" ")}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    />
  );
  // Every device's button is named after its row ("Mark #launch-week as
  // Done", raft-design #777), so a list read aloud doesn't repeat one name;
  // its tooltip keeps the action's name. A thread's name is its channel, so
  // a thread row's button is also described by the row's title (its parent
  // message), which tells apart two threads in one channel.
  // With task v2 on the row shows no number, so its button doesn't name one.
  const doneTaskName = taskV2
    ? taskConversationParts?.title ?? taskConversationParts?.noTitle ?? taskConversationParts?.ref ?? null
    : taskConversationParts?.ref ?? null;
  const doneLabel = doneTaskName
    ? formatMessage({ id: "thread.row.markRowAsDone" }, { conversation: doneTaskName })
    : item.kind === "thread"
      ? formatMessage({ id: "thread.row.markThreadAsDone" }, { conversation: channelLabel })
      : formatMessage({ id: "thread.row.markRowAsDone" }, { conversation: channelLabel });

  // Compact density: the unread count (or, marked unread with no count, the
  // quiet pixel) says the row is unread, so data-unread only bolds the title
  // (no attention dot). A muted conversation shows its muted mark instead and
  // stays quiet.
  const strong = (unreadCount > 0 || markedUnread) && !muted;
  return (
    <RaftInboxItem
      {...rowProps}
      density="compact"
      data-layout="list"
      // The state shape and the content's 12px inside it are raft-ui's
      // (raft-design patterns/lists.md): nothing here moves them.
      className={swipeEnabled ? `${ROW_OFFSCREEN_CLASS} ${SWIPE_ROW_CLASS}` : ROW_OFFSCREEN_CLASS}
      data-unread={strong || undefined}
    >
      {trigger}
      {swipeEnabled && swipeReadToggle ? (
        <div data-row-swipe-layer="" aria-hidden="true" data-testid="inbox-row-swipe-start-actions" className={SWIPE_START_LAYER_CLASS}>
          <button
            type="button"
            tabIndex={-1}
            {...{ [ROW_SWIPE_ACTION_ATTR]: swipeMarksRead ? "read" : "unread" }}
            data-testid="inbox-row-swipe-read"
            className={SWIPE_START_BUTTON_CLASS}
            onClick={() => {
              setSwipeOpen(false);
              handleReadToggle();
            }}
          >
            <span data-row-swipe-label="" className={SWIPE_START_LABEL_CLASS}>
              {swipeMarksRead ? <MessageSquareCheck /> : <MessageSquareDot />}
              {swipeMarksRead ? formatMessage({ id: "thread.row.swipeRead" }) : formatMessage({ id: "thread.row.swipeUnread" })}
            </span>
          </button>
        </div>
      ) : null}
      {swipeEnabled && swipeActions ? (
        <div data-row-swipe-layer="" aria-hidden="true" data-testid="inbox-row-swipe-actions" className={SWIPE_LAYER_CLASS}>
          {swipeMute && swipeMuteChannel ? (
            <button
              type="button"
              tabIndex={-1}
              {...{ [ROW_SWIPE_ACTION_ATTR]: "mute" }}
              data-testid="inbox-row-swipe-mute"
              className={SWIPE_QUIET_BUTTON_CLASS}
              onClick={() => {
                setSwipeOpen(false);
                swipeActions.mute(swipeMuteChannel, channelLabel);
              }}
            >
              <BellOff />
              {formatMessage({ id: "thread.row.swipeMute" })}
            </button>
          ) : null}
          {swipeUnfollow ? (
            <button
              type="button"
              tabIndex={-1}
              {...{ [ROW_SWIPE_ACTION_ATTR]: "unfollow" }}
              data-testid="inbox-row-swipe-unfollow"
              className={SWIPE_QUIET_BUTTON_CLASS}
              onClick={() => {
                setSwipeOpen(false);
                swipeActions.unfollow(item, channelLabel);
              }}
            >
              <UnfollowThreadIcon />
              {formatMessage({ id: "thread.row.swipeUnfollow" })}
            </button>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            {...{ [ROW_SWIPE_ACTION_ATTR]: "done" }}
            data-testid="inbox-row-swipe-done"
            className={SWIPE_DONE_BUTTON_CLASS}
            onClick={() => {
              setSwipeOpen(false);
              swipeActions.done(item);
            }}
          >
            <Check />
            {formatMessage({ id: "thread.row.swipeDone" })}
          </button>
        </div>
      ) : null}
      <ConversationAvatar
        kind={titleIconKind}
        dmChannel={dmChannel ?? threadDmChannel}
        peerIsAppBot={dmAppBot !== null}
        parentIsDm={item.kind === "thread" && item.parentChannelType === "dm"}
        channelType={rowChannelType}
        channel={rowChannel}
        serverPublicPageLive={serverPublicPageLive}
        loungeAgentId={rowLoungeAgentId}
      />
      <InboxItemContent data-testid="conversation-card-content">
        <InboxItemHeading>
          {/* With a badge after it the title only takes the room it needs, so
              the badge sits right after the words; a long title truncates on
              one line (the inner span), with no gap before the badge. */}
          <InboxItemTitle id={titleId} data-testid="conversation-card-primary" className={dmAppBot || legacyTaskNumberBadge ? "flex-initial" : undefined}>
            {dmAppBot || legacyTaskNumberBadge ? <span className="block truncate">{listPrimaryContent}</span> : listPrimaryContent}
          </InboxItemTitle>
          {dmAppBot && titleLabel ? (
            // The row's text lets the pointer through to its trigger; the
            // hover target lets the badge's "Created by" tooltip open.
            <InboxItemHoverTarget id={badgeId} className="shrink-0">
              <AppBadge className="shrink-0" appName={dmAppBot.managedByApp?.name} botName={titleLabel} />
            </InboxItemHoverTarget>
          ) : null}
          {legacyTaskNumberBadge && taskStatus !== null ? (
            <StatusBadge
              status={taskStatus}
              size="sm"
              className="shrink-0"
              data-testid="conversation-card-task-badge"
            >
              {formatMessage({ id: "activity.list.taskNumber" }, { number: threadItem?.taskNumber })}
            </StatusBadge>
          ) : null}
          <ActivityRowTime at={rowTime} wordsId={timeId} />
        </InboxItemHeading>
        <InboxItemLine>
          <InboxItemBody id={bodyId} className={UNREAD_BODY_CLASS} data-testid="conversation-card-body">
            {/* A thread's title is its parent message, so the body names the
                channel. So does a task's, whose title is the task's own. */}
            {taskRefInBody ? (
              <span className="mr-1" data-testid="conversation-card-task-ref">
                {formatMessage(
                  { id: "activity.list.threadChannel" },
                  { channel: highlightActivitySearchText(taskRefInBody, searchQuery) },
                )}
              </span>
            ) : channelInBody ? (
              // A DM thread's face says the peer; screen readers still hear it.
              <span className={threadDmChannel ? "sr-only" : "mr-1"} data-testid="conversation-card-subtitle">
                {formatMessage({ id: "activity.list.threadChannel" }, { channel: subtitleContent })}
              </span>
            ) : null}
            {dmChannel && senderId === dmChannel.peerId && !senderDelegatedBy && hasActivityPreview ? renderActivityPreview(activityPreview, searchQuery, activityRetracted ? retractedLine : undefined) : listBodyContent}
          </InboxItemBody>
          <InboxItemMarks data-testid="conversation-card-marks">
            {statusInMarks && taskStatus !== null ? (
              // A task's state ends the excerpt's line, before the unread count,
              // so it never takes room from the title. Under a 360px row it is
              // its pixel, with the word in a tooltip and in the row's name.
              <InboxItemStatus
                id={statusId}
                status={toRuiTaskStatus(taskStatus)}
                data-status={taskStatus}
                data-testid="conversation-card-task-badge"
              >
                {formatMessage({ id: TASK_STATUS_UI[taskStatus]?.labelId ?? "task.status.todo" })}
              </InboxItemStatus>
            ) : null}
            {hasThreadDraft ? (
              <Pencil size={12} aria-label={formatMessage({ id: "thread.row.draftTitle" })} data-testid="inbox-thread-draft-badge" />
            ) : null}
            {/* @you is the sidebar's yellow @ sticker, so a mention reads the same in both places. */}
            {shouldShowMentionBadge ? (
              <Tooltip content={formatMessage({ id: "layout.sidebar.mentionedYouTitle" })}>
                <InboxItemHoverTarget
                  render={<SidebarItemIndicator />}
                  role="img"
                  data-testid="inbox-mention-badge"
                  aria-label={formatMessage({ id: "layout.sidebar.mentionedYouAria" })}
                >
                  <AtSign />
                </InboxItemHoverTarget>
              </Tooltip>
            ) : null}
            {muted ? (
              <BellOff size={14} data-testid="conversation-card-muted" />
            ) : unreadCount > 0 ? (
              <SidebarItemCount data-testid="conversation-card-new-badge">
                {unreadCount}
              </SidebarItemCount>
            ) : markedUnread ? (
              <QuietUnreadDot
                data-testid="conversation-card-marked-unread"
                aria-label={formatMessage({ id: "layout.sidebar.markedUnreadAria" })}
              />
            ) : null}
          </InboxItemMarks>
        </InboxItemLine>
        <InboxRowDone
          phone={swipeEnabled}
          label={doneLabel}
          describedBy={item.kind === "thread" && !doneTaskName ? titleId : undefined}
          onDone={handleDone}
        />
      </InboxItemContent>
    </RaftInboxItem>
  );
}

// A row renders again only when its own props change. Without it, every
// change to the list (a new activity at the top, a row read) rendered every
// loaded row again: 600 rows took 1.7s at 4x CPU (task #5).
export const InboxRow = memo(InboxRowImpl);
