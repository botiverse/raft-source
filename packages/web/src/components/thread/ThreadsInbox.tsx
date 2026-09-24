import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { formatRelativeTime } from "../../utils/relativeTime";
import { Activity, ArrowDownUp, ArrowUp, AtSign, Bell, BellOff, Bookmark, Check, CheckCircle2, ChevronDown, Hash, Inbox, Mail, MessageSquare, MessageSquareCheck, MessageSquareDot, MessageSquareText, Pencil, RotateCcw, Search } from "lucide-react";
import { getInboxItemKey, useInboxStore } from "../../store/inboxStore";
import type { ActivitySortDirection, InboxItem, InboxFilter, InboxGroupCount } from "../../store/inboxStore";
import { useActivityPanelWindowBundle } from "../../store/activityPanel/useActivityShadow";
import {
  Badge,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import { useMessageStore } from "../../store/messageStore";
import { captureReceiverPrivateIngressContext } from "../../store/receiverPrivateIngress";
import { useChannelStore } from "../../store/channelStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useTaskMetadataForMessage } from "../../store/taskStore";
import type { TaskStatus } from "../../store/taskStore";
import { StatusBadge } from "../task/StatusBadge";
import { useSearchContentStore } from "../../store/searchContentStore";
import { useSavedStore } from "../../store/savedStore";
import type { SavedEntry } from "../../store/savedStore";
import type { Channel } from "../../store/channelStore";
import { ACTIVITY_SIDEBAR_INBOX_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import {
  trackActivityItemOpen,
  trackActivityMark,
} from "../../analytics/activity";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import api from "../../api/client";
import type { MessageId } from "../../i18n/messages/en";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import {
  activityInboxTraceScope,
  currentActivityInboxTraceCycle,
  traceActivityInboxTransition,
} from "../../utils/activityInboxTrace";
import InlineMarkdownPreview from "../markdown/InlineMarkdownPreview";
import PanelHeader from "../ui/PanelHeader";
import EmptyState from "../ui/EmptyState";
import MenuItem from "../ui/MenuItem";
import DialogCard from "../ui/DialogCard";
import { ConversationCardSkeleton } from "../ui/Skeleton";
import AvatarSlot from "../ui/AvatarSlot";
import { placeInboxContextMenu } from "./inboxContextMenuPosition";
import type { InboxContextMenuPosition } from "./inboxContextMenuPosition";
import { itemFilterChannelLabel } from "./inboxChannelFilter";
import DismissBackdrop from "../ui/DismissBackdrop";

function itemKey(item: InboxItem): string {
  return getInboxItemKey(item);
}

function itemChannelId(item: InboxItem): string {
  if (item.kind === "mention_action") return item.channelId;
  return item.kind === "thread" ? item.threadChannelId : item.channelId;
}

function handleNestedRowActionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, action: () => void) {
  event.stopPropagation();
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function itemUnreadCount(item: InboxItem): number {
  return item.unreadCount;
}

function itemRenderKey(item: InboxItem, view: ActivitySidebarView): string {
  if (view === "saved") return `saved:${activityItemMessageId(item)}`;
  return itemKey(item);
}

function activityItemMessageId(item: InboxItem): string {
  if (item.kind === "thread") return item.latestActivityMessageId;
  if (item.kind === "mention_action") return item.messageId;
  return item.lastMessageId;
}

function itemActivityGroup(item: InboxItem): InboxGroupCount {
  if (item.kind === "thread") {
    return {
      channelId: item.parentChannelId,
      channelName: item.parentChannelName,
      channelType: item.parentChannelType,
      count: 1,
      lastActivityAt: item.lastActivityAt,
    };
  }
  if (item.kind === "mention_action") {
    return {
      channelId: item.channelId,
      channelName: item.channelName,
      channelType: item.channelType,
      count: 1,
      lastActivityAt: item.createdAt,
    };
  }
  return {
    channelId: item.channelId,
    channelName: item.channelName,
    channelType: item.channelType,
    count: 1,
    lastActivityAt: item.lastMessageAt,
  };
}

function itemDmActivityGroup(item: InboxItem): InboxGroupCount | null {
  const group = itemActivityGroup(item);
  return group.channelType === "dm" ? group : null;
}

function savedSenderType(
  value: string | null | undefined,
): "user" | "agent" | "system" | "external_projection" {
  if (value === "agent" || value === "system" || value === "external_projection") return value;
  return "user";
}

function savedEntryToInboxItem(entry: SavedEntry): InboxItem {
  if (entry.channelType === "thread") {
    return {
      kind: "thread",
      threadChannelId: entry.channelId,
      parentMessageId: entry.parentMessageId ?? entry.messageId,
      parentChannelId: entry.parentChannelId ?? entry.channelId,
      parentChannelName: entry.parentChannelName ?? entry.channelName,
      parentChannelType: (entry.parentChannelType ?? "channel") as "channel" | "private" | "joint" | "dm",
      parentMessagePreview: entry.parentMessagePreview ?? entry.content,
      parentMessageSenderType: entry.parentMessageSenderType === "agent"
        ? "agent"
        : entry.parentMessageSenderType === "external_projection"
          ? "external_projection"
          : "user",
      parentMessageSenderId: entry.parentMessageSenderId ?? entry.senderId,
      latestActivityPreview: entry.content,
      latestActivitySenderType: savedSenderType(entry.senderType),
      latestActivitySenderId: entry.senderId,
      latestActivitySenderName: entry.senderName,
      latestActivityMessageId: entry.messageId,
      latestActivitySeq: null,
      firstUnreadMessageId: null,
      firstMentionMessageId: null,
      lastActivityAt: entry.createdAt,
      lastReplyAt: entry.createdAt,
      replyCount: entry.replyCount ?? 0,
      unreadCount: 0,
      hasMention: false,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    };
  }

  const kind = entry.channelType === "dm" ? "dm" as const : "channel" as const;
  return {
    kind,
    channelId: entry.channelId,
    channelName: entry.channelName,
    channelType: (entry.channelType === "private" || entry.channelType === "joint" || entry.channelType === "dm")
      ? entry.channelType
      : "channel",
    lastMessageId: entry.messageId,
    latestActivitySeq: null,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: entry.createdAt,
    lastMessagePreview: entry.content,
    lastMessageSenderType: savedSenderType(entry.senderType),
    lastMessageSenderId: entry.senderId,
    lastMessageSenderName: entry.senderName,
    unreadCount: 0,
    hasMention: false,
  };
}

type ThreadInboxItem = Extract<InboxItem, { kind: "thread" }>;

function asThreadItem(item: InboxItem): ThreadInboxItem | null {
  return item.kind === "thread" ? item : null;
}

function stripActivityTitlePrefix(value: string): string {
  return value.replace(/^[@#]+/, "");
}

type ActivityReadFilter = "all" | "unread";

function activityReadFilter(filter: InboxFilter): ActivityReadFilter {
  return filter === "unread" || filter === "unread_mentions" ? "unread" : "all";
}

function activityMentionsOnly(filter: InboxFilter): boolean {
  return filter === "mentions" || filter === "unread_mentions";
}

type CtxMenu = InboxContextMenuPosition;
type ActivitySidebarView = "all" | "unread" | "mentions" | "saved" | "done";

const ACTIVITY_SORT_OPTIONS: Array<{ value: ActivitySortDirection; labelId: MessageId }> = [
  { value: "desc", labelId: "activity.current.sortNewest" },
  { value: "asc", labelId: "activity.current.sortOldest" },
];

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
      <mark key={`${index}-${match}`} className="bg-soft-signal px-0.5 text-black">
        {match}
      </mark>,
    );
    cursor = index + needle.length;
    index = lowerValue.indexOf(lowerNeedle, cursor);
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts;
}

function renderActivityPreview(markdown: string, query: string): ReactNode {
  return query.trim()
    ? highlightActivitySearchText(markdown, query)
    : <InlineMarkdownPreview markdown={markdown} />;
}

function ActivityGroupIcon({ group, dmChannel }: { group: InboxGroupCount; dmChannel?: Channel | null }) {
  if (group.channelType === "dm" && dmChannel) {
    return (
      <div data-testid={`activity-group-dm-avatar-${group.channelId}`} className="flex size-5 shrink-0 items-center justify-center">
        {dmChannel.peerType === "agent" ? (
          <AvatarSlot
            context="compact-list"
            type="agent"
            agentAvatarUrl={dmChannel.peerAvatarUrl ?? null}
          />
        ) : (
          <AvatarSlot
            context="compact-list"
            type="human"
            humanAvatarUrl={dmChannel.peerAvatarUrl ?? null}
            gravatarHash={dmChannel.peerGravatarHash ?? null}
            humanPlaceholder={!dmChannel.peerAvatarUrl && !dmChannel.peerGravatarHash}
          />
        )}
      </div>
    );
  }
  const isDm = group.channelType === "dm";
  return (
    <span
      className={`flex size-5 shrink-0 items-center justify-center border-2 border-black/20 ${isDm ? "bg-soft-signal" : "bg-black/[0.04]"}`}
      data-testid={isDm ? `activity-group-dm-fallback-${group.channelId}` : `activity-group-channel-icon-${group.channelId}`}
    >
      {isDm ? <AtSign size={12} /> : <Hash size={12} />}
    </span>
  );
}

function InboxRow({ item, filter, searchQuery, onOpen, onDone, onContextMenu, onDragStart, focused, active, focusRef, doneAction = "done" }: {
  item: InboxItem;
  filter: InboxFilter;
  searchQuery: string;
  onOpen: (e: React.MouseEvent | ReactKeyboardEvent) => void;
  onDone: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (event: React.DragEvent<HTMLDivElement>) => void;
  focused?: boolean;
  active?: boolean;
  focusRef?: React.Ref<HTMLDivElement>;
  doneAction?: "done" | "restore" | "none";
}) {
  const { formatMessage, locale } = useIntl();
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const realtimeTaskMetadata = useTaskMetadataForMessage(item.kind === "thread" ? item.parentMessageId : null);

  const timestamp = item.kind === "thread"
    ? formatRelativeTime(item.lastActivityAt, locale)
    : item.kind === "mention_action"
      ? formatRelativeTime(item.createdAt, locale)
    : formatRelativeTime(item.lastMessageAt, locale);
  const unreadCount = itemUnreadCount(item);
  const shouldShowMentionBadge = !activityMentionsOnly(filter) && item.hasMention && unreadCount > 0;

  const channelLabel = itemFilterChannelLabel(item, channels, dmChannels);
  const titleLabel = (() => {
    if (item.kind === "thread") return null;
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
  const senderName = senderAgent?.displayName
    ?? senderAgent?.name
    ?? senderMember?.displayName
    ?? senderMember?.name
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
  // "system", …, "system")` → inboxTransport). Localize both; fall back to the
  // resolved name for genuine user/agent rows.
  const isSystemSender = senderType === "system" || senderId === "system";
  const activitySenderLabel = isSystemSender
    ? formatMessage({ id: "thread.row.systemSender" })
    : (senderName ?? null);
  const rawThreadItem = asThreadItem(item);
  const threadItem = useMemo(() => {
    if (!rawThreadItem || !realtimeTaskMetadata) return rawThreadItem;
    return {
      ...rawThreadItem,
      taskNumber: realtimeTaskMetadata.taskNumber,
      taskStatus: realtimeTaskMetadata.status,
      taskClaimedByName: realtimeTaskMetadata.claimedByName ?? null,
    };
  }, [rawThreadItem, realtimeTaskMetadata]);
  const hasThreadDraft = useMessageStore((s) =>
    threadItem ? !!s.drafts[threadItem.threadChannelId]?.trim() : false
  );
  const preview = item.kind === "thread"
    ? item.parentMessagePreview
    : item.kind === "mention_action"
      ? item.messagePreview
      : item.lastMessagePreview;
  const activityPreview = item.kind === "thread" ? item.latestActivityPreview : preview;
  const primaryContent = item.kind === "thread"
    ? renderActivityPreview(item.parentMessagePreview, searchQuery)
    : titleLabel
      ? highlightActivitySearchText(titleLabel, searchQuery)
      : null;
  const titleIconKind = item.kind === "thread"
    ? "thread"
    : item.kind === "dm" || (item.kind === "mention_action" && item.channelType === "dm")
      ? "dm"
      : "channel";
  const titleIcon = (() => {
    const className = "mr-1.5 inline-block align-[-2px] text-black/45";
    if (titleIconKind === "thread") return <MessageSquare size={13} className={className} />;
    if (titleIconKind === "dm") return <AtSign size={13} className={className} />;
    return <Hash size={13} className={className} />;
  })();
  const subtitleContent = item.kind === "thread" ? channelLabel : null;
  const bodyContent = (
    <>
      {activitySenderLabel ? <span className="font-bold text-black/70">{activitySenderLabel}: </span> : null}
      {renderActivityPreview(activityPreview, searchQuery)}
    </>
  );
  const rowClassName = `group relative flex w-full items-start gap-3 border-2 p-3 text-left transition-colors hover:border-black hover:shadow-brutal-sm active:border-black active:shadow-brutal-sm ${
    focused
      ? "border-black bg-brutal-cyan/25 shadow-brutal"
      : active
      ? "border-black bg-white shadow-brutal-sm"
      : "border-black/30 bg-white"
  }`;
  const rowActionVisibilityClassName = active
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100";
  const doneActionClassName = `btn-brutal-sm relative z-10 shrink-0 bg-white p-1.5 transition-opacity ${
    rowActionVisibilityClassName
  }`;
  const hasRowAction = doneAction !== "none";
  const timestampVisibilityClassName = !hasRowAction
    ? ""
    : active
      ? "opacity-0"
      : "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0";
  const rowActionBackgroundClassName = active
    ? "bg-white"
    : "bg-transparent group-hover:bg-white group-focus-visible:bg-white group-focus-within:bg-white [@media(hover:none)]:bg-white";

  return (
    <div
      ref={focusRef}
      role="button"
      tabIndex={0}
      data-testid="inbox-row"
      data-focused={focused ? "true" : undefined}
      data-active={active ? "true" : undefined}
      aria-current={focused || active ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(event);
      }}
      onContextMenu={onContextMenu}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      className={rowClassName}
    >
      <div className="min-w-0 w-full" data-testid="conversation-card-content">
        {subtitleContent ? (
          <div
            className="mb-0.5 min-w-0 text-[11px] font-bold leading-3 text-black/45"
            data-testid="conversation-card-subtitle"
          >
            {subtitleContent}
          </div>
        ) : null}
        <div className="mb-0.5 flex min-w-0 items-start gap-2">
          <div
            className={`line-clamp-2 min-w-0 flex-1 text-sm leading-5 ${unreadCount > 0 ? "font-bold text-black" : "font-semibold text-black/55"}`}
            data-testid="conversation-card-primary"
          >
            <span aria-hidden="true" data-testid="conversation-card-title-icon" data-kind={titleIconKind}>
              {titleIcon}
            </span>
            {primaryContent}
          </div>
          {timestamp ? (
            <span
              className={`shrink-0 font-mono text-xs leading-5 text-black/40 ${timestampVisibilityClassName}`}
              data-testid="conversation-card-timestamp"
            >
              {timestamp}
            </span>
          ) : null}
        </div>
        <p
          className={`line-clamp-2 text-xs leading-4 ${unreadCount > 0 ? "text-black" : "text-black/55"}`}
          data-testid="conversation-card-body"
        >
          {bodyContent}
        </p>
        <div
          className="mt-1 flex min-h-5 flex-wrap items-center gap-1.5"
          data-testid="conversation-card-metadata"
        >
          {threadItem && threadItem.taskNumber != null && threadItem.taskStatus && (
            <StatusBadge
              status={threadItem.taskStatus as TaskStatus}
              data-testid="conversation-card-task-badge"
            >
              #{threadItem.taskNumber}
              {threadItem.taskClaimedByName && ` @${threadItem.taskClaimedByName}`}
            </StatusBadge>
          )}
          {threadItem && (
            <Badge
              appearance="outline"
              variant="muted"
              uppercase={false}
              data-testid="conversation-card-reply-count"
            >
              {formatMessage({ id: "thread.row.replies" }, { count: threadItem.replyCount })}
            </Badge>
          )}
          {threadItem?.isFollowing === false && (
            <Badge
              appearance="outline"
              variant="muted"
              uppercase={false}
              data-testid="conversation-card-unfollowed-badge"
            >
              <BellOff size={10} />
              {formatMessage({ id: "thread.row.unfollowed" })}
            </Badge>
          )}
          {shouldShowMentionBadge && (
            <Badge
              variant="primary"
              uppercase={false}
              data-testid="inbox-mention-badge"
              title={formatMessage({ id: "thread.row.mentionBadgeTitle" })}
            >
              <AtSign size={10} />
              {formatMessage({ id: "thread.row.mentionBadgeLabel" })}
            </Badge>
          )}
          {unreadCount > 0 && (
            <Badge
              variant="accent"
              uppercase={false}
              data-testid="conversation-card-new-badge"
            >
              {formatMessage({ id: "thread.row.unreadCount" }, { count: unreadCount })}
            </Badge>
          )}
          {hasThreadDraft && (
            <Badge
              appearance="outline"
              variant="muted"
              uppercase={false}
              data-testid="inbox-thread-draft-badge"
              title={formatMessage({ id: "thread.row.draftTitle" })}
              aria-label={formatMessage({ id: "thread.row.draftTitle" })}
            >
              <Pencil size={12} />
            </Badge>
          )}
        </div>
      </div>
      {hasRowAction ? (
        <div
          className={`pointer-events-none absolute right-3 top-3 z-10 flex items-center pl-1 ${rowActionBackgroundClassName}`}
          data-testid="conversation-card-actions"
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDone(); }}
            onKeyDown={(event) => handleNestedRowActionKeyDown(event, onDone)}
            className={doneActionClassName}
            title={formatMessage({ id: doneAction === "restore" ? "activity.current.restore" : "thread.row.markAsDone" })}
            aria-label={formatMessage({ id: doneAction === "restore" ? "activity.current.restore" : "thread.row.markAsDone" })}
            data-testid="inbox-row-done"
          >
            {doneAction === "restore" ? <RotateCcw size={14} /> : <Check size={14} />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function isDesktopMasterDetailViewport(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(min-width: 1024px)").matches;
}

export default function ThreadsInbox({ onOpenItem, onDragItem, compactActivitySidebar = false }: {
  onOpenItem?: (item: InboxItem) => void;
  onDragItem?: (event: React.DragEvent<HTMLDivElement>, item: InboxItem) => void;
  compactActivitySidebar?: boolean;
} = {}) {
  const { formatMessage, formatNumber } = useIntl();
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const legacyStoreItems = useInboxStore((s) => s.items);
  const acceptedWindowGeneration = useInboxStore((s) => s.acceptedWindowGeneration);
  const legacyActivityGroups = useInboxStore((s) => s.groups);
  const filter = useInboxStore((s) => s.filter);
  const channelFilterId = useInboxStore((s) => s.channelFilterId);
  const loading = useInboxStore((s) => s.loading);
  const loaded = useInboxStore((s) => s.loaded);
  const loadingMore = useInboxStore((s) => s.loadingMore);
  const legacyHasMore = useInboxStore((s) => s.hasMore);
  const legacyTotalCount = useInboxStore((s) => s.totalCount);
  const legacyTotalUnreadCount = useInboxStore((s) => s.totalUnreadCount);
  const sortDirection = useInboxStore((s) => s.sortDirection);
  const inboxSearchQuery = useInboxStore((s) => s.searchQuery);
  const setSortDirection = useInboxStore((s) => s.setSortDirection);
  const setInboxSearchQuery = useInboxStore((s) => s.setSearchQuery);
  const savedScrollTop = useInboxStore((s) => s.scrollTop);
  const focusedItemKey = useInboxStore((s) => s.focusedItemKey);
  const setFilter = useInboxStore((s) => s.setFilter);
  const setChannelFilterId = useInboxStore((s) => s.setChannelFilterId);
  const setSavedScrollTop = useInboxStore((s) => s.setScrollTop);
  const setFocusedItemKey = useInboxStore((s) => s.setFocusedItemKey);
  const loadInbox = useInboxStore((s) => s.loadInbox);
  const refreshInbox = useInboxStore((s) => s.refreshInbox);
  const markRead = useInboxStore((s) => s.markRead);
  const markAllRead = useInboxStore((s) => s.markAllRead);
  const markDone = useInboxStore((s) => s.markDone);
  const markThreadUnfollowed = useInboxStore((s) => s.markThreadUnfollowed);
  const markThreadRefollowed = useInboxStore((s) => s.markThreadRefollowed);
  const openThread = useThreadStore((s) => s.openThread);
  const openContentSlot = useSearchContentStore((s) => s.open);
  const contentSlot = useSearchContentStore((s) => s.slot);
  const followThread = useThreadStore((s) => s.followThread);
  const unfollowThread = useThreadStore((s) => s.unfollowThread);
  const focusedThreadChannelId = useThreadStore((s) => s.focusedThreadChannelId);
  const setFocusedThreadChannelId = useThreadStore((s) => s.setFocusedThreadChannelId);
  const savedEntries = useSavedStore((s) => s.saved);
  const savedLoading = useSavedStore((s) => s.loading);
  const savedHasMore = useSavedStore((s) => s.hasMore);
  const savedTotal = useSavedStore((s) => s.total);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loadSaved = useSavedStore((s) => s.loadSaved);
  const loadMoreSaved = useSavedStore((s) => s.loadMore);
  const checkSaved = useSavedStore((s) => s.checkSaved);
  const nav = useAppNavigate();
  const { enabled: activitySidebarInboxEnabled } = useServerFeatureFlag(ACTIVITY_SIDEBAR_INBOX_FLAG_KEY);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [activityView, setActivityView] = useState<ActivitySidebarView>("all");
  const [activitySearchVisible, setActivitySearchVisible] = useState(false);
  const [activitySwitcherOpen, setActivitySwitcherOpen] = useState(false);
  const [doneItems, setDoneItems] = useState<InboxItem[]>([]);
  const [doneLoading, setDoneLoading] = useState(false);
  const [doneLoadingMore, setDoneLoadingMore] = useState(false);
  const [doneHasMore, setDoneHasMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLDivElement>(null);
  const autoScrolledFocusKeyRef = useRef<string | null>(null);
  const activitySearchInputRef = useRef<HTMLInputElement>(null);
  const isNearTopRef = useRef(true);
  const [newUpdateCount, setNewUpdateCount] = useState(0);
  const restoredScrollRef = useRef(false);
  const doneRequestIdRef = useRef(0);
  const activeFocusKey = focusedItemKey ?? (focusedThreadChannelId ? `thread:${focusedThreadChannelId}` : null);
  const activitySortOptions = useMemo(
    () => ACTIVITY_SORT_OPTIONS.map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
    })),
    [formatMessage],
  );
  // When an item is open in col 3 of the Activity master/detail, keep its row
  // visually selected in the master list — same affordance as the selected
  // /search result card. Slot kind→item-key mirrors getInboxItemKey:
  // thread → `thread:<threadChannelId>`, channel/dm → `<kind>:<channelId>`.
  const openItemKey = contentSlot
    ? `${contentSlot.kind}:${contentSlot.id}`
    : null;
  const effectiveChannelFilterId = activitySidebarInboxEnabled ? channelFilterId : null;
  const receiverInput = useMemo(() => ({
    legacySnapshot: {
      generation: acceptedWindowGeneration,
      window: {
        items: legacyStoreItems,
        groups: legacyActivityGroups,
        totalCount: legacyTotalCount,
        totalUnreadCount: legacyTotalUnreadCount,
        hasMore: legacyHasMore,
        // The legacy endpoint paginates by offset. Preserve that exact cursor
        // as an opaque string so pagination travels through the same bundle as
        // rows/counts instead of being re-derived after the source decision.
        nextCursor: legacyHasMore ? String(legacyStoreItems.length) : null,
        complete: !legacyHasMore,
      },
    },
    activityView: "active" as const,
    filter,
    sortDirection,
    searchQuery: inboxSearchQuery,
    channelFilterId: effectiveChannelFilterId,
  }), [
    acceptedWindowGeneration,
    effectiveChannelFilterId,
    filter,
    inboxSearchQuery,
    legacyActivityGroups,
    legacyHasMore,
    legacyStoreItems,
    legacyTotalCount,
    legacyTotalUnreadCount,
    sortDirection,
  ]);
  const activityWindow = useActivityPanelWindowBundle(receiverInput);
  // S2's only visible source split. Every downstream active-window read uses
  // this one discriminated value; no field is selected again from Zustand.
  const items = activityWindow.items;
  const totalCount = activityWindow.totalCount;
  const totalUnreadCount = activityWindow.totalUnreadCount;
  const hasMore = activityWindow.hasMore;
  const nextCursor = activityWindow.nextCursor;
  const activityGroups = activityWindow.groups;
  const activityGroupTotal = activityGroups.reduce((sum, group) => sum + group.count, 0);
  const savedActivityItems = useMemo(() => savedEntries.map(savedEntryToInboxItem), [savedEntries]);
  const visibleItems = activityView === "saved"
    ? savedActivityItems
    : activityView === "done"
      ? doneItems
      : items;
  // Top-level Activity views and source selection are independent dimensions.
  // Saved/Done change the result set, never the mixed DM/channel navigation.
  const activityFacetGroups = activityGroups;
  const dmActivityGroups = useMemo(() => {
    const byId = new Map<string, InboxGroupCount>();
    for (const group of activityFacetGroups) {
      if (group.channelType === "dm") byId.set(group.channelId, group);
    }
    for (const item of items) {
      const group = itemDmActivityGroup(item);
      if (!group || byId.has(group.channelId)) continue;
      byId.set(group.channelId, group);
    }
    return Array.from(byId.values());
  }, [activityFacetGroups, items]);
  const channelActivityGroups = useMemo(
    () => activityFacetGroups.filter((group) => group.channelType !== "dm"),
    [activityFacetGroups],
  );
  const dmChannelById = useMemo(
    () => new Map(dmChannels.map((channel) => [channel.id, channel])),
    [dmChannels],
  );
  const selectedActivityGroup = effectiveChannelFilterId
    ? activityFacetGroups.find((group) => group.channelId === effectiveChannelFilterId)
      ?? null
    : null;
  const visibleLoading = activityView === "saved"
    ? savedLoading
    : activityView === "done"
      ? doneLoading
      : loading;
  const visibleLoadingMore = activityView === "saved"
    ? savedLoading && savedActivityItems.length > 0
    : activityView === "done"
      ? doneLoadingMore
      : loadingMore;
  const visibleHasMore = activityView === "saved"
    ? savedHasMore
    : activityView === "done"
      ? doneHasMore
      : hasMore;
  const showMarkAllRead = totalUnreadCount > 0 && activityView !== "saved" && activityView !== "done";
  const prevItemsRef = useRef(visibleItems);

  const setActivityFilter = useCallback((nextFilter: InboxFilter) => {
    if (nextFilter === "all" || nextFilter === "unread" || nextFilter === "mentions") {
      setActivityView(nextFilter);
    }
    if (filter !== nextFilter) setFilter(nextFilter);
  }, [filter, setFilter]);

  const setSidebarView = useCallback((nextView: ActivitySidebarView) => {
    setActivityView(nextView);
    if (nextView === "all" || nextView === "unread" || nextView === "mentions") {
      setActivityFilter(nextView);
      return;
    }
  }, [setActivityFilter]);

  const toggleActivityGroup = useCallback((groupId: string) => {
    const clearingSelection = channelFilterId === groupId;
    setChannelFilterId(clearingSelection ? null : groupId);
  }, [channelFilterId, setChannelFilterId]);

  const loadDoneItems = useCallback(async (reset = true, offset = 0) => {
    const requestId = ++doneRequestIdRef.current;
    if (reset) setDoneLoading(true);
    else setDoneLoadingMore(true);
    try {
      const { data } = await api.get("/channels/inbox/done", {
        params: {
          limit: 30,
          offset,
          sort: sortDirection,
          q: inboxSearchQuery || undefined,
          channelId: effectiveChannelFilterId || undefined,
        },
      });
      if (requestId !== doneRequestIdRef.current) return;
      const nextItems = (data.items ?? []) as InboxItem[];
      setDoneItems((current) => reset ? nextItems : [...current, ...nextItems]);
      setDoneHasMore(!!data.hasMore);
    } catch (err) {
      console.error("Failed to load Done Activity:", err);
    } finally {
      if (requestId === doneRequestIdRef.current) {
        setDoneLoading(false);
        setDoneLoadingMore(false);
      }
    }
  }, [effectiveChannelFilterId, inboxSearchQuery, sortDirection]);

  const restoreDoneItem = useCallback(async (item: InboxItem) => {
    if (item.kind === "mention_action") return;
    const key = itemKey(item);
    setDoneItems((current) => current.filter((candidate) => itemKey(candidate) !== key));
    try {
      if (item.kind === "thread") {
        await api.post("/channels/threads/undone", { threadChannelId: item.threadChannelId });
      } else {
        await api.post("/channels/inbox/undone", { channelId: item.channelId });
      }
      await refreshInbox({ background: true });
    } catch (err) {
      console.error("Failed to restore Done Activity:", err);
      await loadDoneItems(true, 0);
    }
  }, [loadDoneItems, refreshInbox]);

  useEffect(() => {
    if (!loaded && !loading) {
      loadInbox({ reset: true });
    }
  }, [loadInbox, loaded, loading]);

  useEffect(() => {
    if (
      !activitySidebarInboxEnabled
      || !loaded
      || loading
      || !effectiveChannelFilterId
      || selectedActivityGroup
    ) return;

    // A facet without any retained identity cannot be rendered or cleared and
    // would silently constrain every top-level Activity view. Heal sessions
    // that already entered that orphaned state before the preservation fix.
    setChannelFilterId(null);
  }, [
    activitySidebarInboxEnabled,
    effectiveChannelFilterId,
    loaded,
    loading,
    selectedActivityGroup,
    setChannelFilterId,
  ]);

  useEffect(() => {
    if (!activitySidebarInboxEnabled || activityView !== "saved") return;
    void loadSaved({ query: inboxSearchQuery, sortDirection, channelId: effectiveChannelFilterId ?? undefined });
  }, [activitySidebarInboxEnabled, activityView, effectiveChannelFilterId, inboxSearchQuery, loadSaved, sortDirection]);

  useEffect(() => {
    if (!activitySidebarInboxEnabled || activityView !== "done") return;
    void loadDoneItems(true, 0);
  }, [activitySidebarInboxEnabled, activityView, loadDoneItems]);

  useEffect(() => {
    if (!activitySidebarInboxEnabled || activityView === "saved" || activityView === "done") return;
    void checkSaved(items.map(activityItemMessageId));
  }, [activitySidebarInboxEnabled, activityView, checkSaved, items]);

  useEffect(() => {
    if (!activitySidebarInboxEnabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setActivitySearchVisible(true);
    };
    // keydown-focus-on-open
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activitySidebarInboxEnabled]);

  useEffect(() => {
    if (!activitySidebarInboxEnabled || !activitySearchVisible) return;
    const raf = requestAnimationFrame(() => {
      activitySearchInputRef.current?.focus();
      activitySearchInputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [activitySearchVisible, activitySidebarInboxEnabled]);

  // Resolve a deferred "focus first unread" intent (set by the sidebar
  // dbl-click) once items are actually loaded — data-driven, so it doesn't
  // matter when items arrive or which loadInbox call populated them. If items
  // are loaded but none are unread, keep the intent pending until a later items
  // update (e.g. a new reply) can resolve it.
  useEffect(() => {
    if (useInboxStore.getState().pendingFocusKind !== "first-unread" || visibleItems.length === 0) return;
    const firstUnread = visibleItems.find((item) => item.unreadCount > 0);
    if (!firstUnread) return;
    setFocusedItemKey(itemKey(firstUnread));
    useInboxStore.getState().setPendingFocusKind(null);
  }, [setFocusedItemKey, visibleItems]);

  useEffect(() => {
    restoredScrollRef.current = false;
  }, [activityView, channelFilterId, filter]);

  useEffect(() => {
    if (restoredScrollRef.current || visibleItems.length === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const raf = requestAnimationFrame(() => {
      container.scrollTop = savedScrollTop;
      isNearTopRef.current = savedScrollTop < 50;
      restoredScrollRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [savedScrollTop, visibleItems.length]);

  useEffect(() => {
    if (!activeFocusKey) {
      autoScrolledFocusKeyRef.current = null;
      return;
    }
    if (autoScrolledFocusKeyRef.current === activeFocusKey) return;
    const idx = visibleItems.findIndex((item) => itemKey(item) === activeFocusKey);
    if (idx === -1) return;
    const raf = requestAnimationFrame(() => {
      const container = scrollRef.current;
      const row = focusedRowRef.current;
      if (!container || !row) return;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      container.scrollTo({ top: container.scrollTop + rowRect.top - containerRect.top - 8, behavior: "smooth" });
      autoScrolledFocusKeyRef.current = activeFocusKey;
      traceActivityInboxTransition({
        source: "focus_scroll",
        itemKey: activeFocusKey,
        fromIndex: idx,
        toIndex: idx,
        focusOwner: true,
      }, currentActivityInboxTraceCycle(activityInboxTraceScope(
        captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId),
        activeFocusKey,
      )));
      isNearTopRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeFocusKey, visibleItems]);

  useEffect(() => {
    if (!focusedItemKey) return;
    const t = setTimeout(() => setFocusedItemKey(null), 3000);
    return () => clearTimeout(t);
  }, [focusedItemKey, setFocusedItemKey]);

  useEffect(() => {
    if (!focusedThreadChannelId) return;
    const t = setTimeout(() => setFocusedThreadChannelId(null), 3000);
    return () => clearTimeout(t);
  }, [focusedThreadChannelId, setFocusedThreadChannelId]);

  useEffect(() => {
    const prev = prevItemsRef.current;
    prevItemsRef.current = visibleItems;
    if (prev === visibleItems) return;
    const prevTopId = prev[0] ? itemKey(prev[0]) : null;
    const newTopId = visibleItems[0] ? itemKey(visibleItems[0]) : null;
    if (prevTopId && newTopId && prevTopId !== newTopId && !isNearTopRef.current) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing new-update counter now observes the atomic receiver result; behavior is unchanged.
      setNewUpdateCount((count) => count + 1);
    }
    if (restoredScrollRef.current && isNearTopRef.current && scrollRef.current && !focusedThreadChannelId) {
      scrollRef.current.scrollTop = 0;
      setSavedScrollTop(0);
    }
  }, [visibleItems, focusedThreadChannelId, setSavedScrollTop]);

  // Desktop: double-click an Activity item → navigate into the full chat page
  // focused on the message, identical to a /search result (MessageSearchPage
  // uses the same `event.detail >= 2` gesture + `nav.to*Message`). Single-click
  // keeps the col-3 master/detail preview via `handleOpen`, delayed 220ms so a
  // double doesn't also fire the single. Mobile has no Activity master/detail
  // preview, so a tap should open immediately instead of waiting for a desktop
  // double-click gesture. (stdrc #proj-activity:171042a3 2026-07-04)
  const activateTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
    };
  }, []);

  const navigateToChat = (item: InboxItem) => {
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
  };

  const handleActivate = (event: React.MouseEvent | ReactKeyboardEvent, item: InboxItem) => {
    const activationDetail = "detail" in event ? event.detail : 1;
    if (onOpenItem) {
      handleOpen(item);
      return;
    }
    // Activity needs enough horizontal room for both the inbox list and the
    // detail pane. Tablet/narrow desktop keeps the rail but opens the target
    // route directly instead of crushing the middle column.
    if (!isDesktopMasterDetailViewport()) {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
      handleOpen(item);
      return;
    }
    if (activationDetail >= 2) {
      if (activateTimerRef.current !== null) {
        window.clearTimeout(activateTimerRef.current);
        activateTimerRef.current = null;
      }
      trackActivityItemOpen(item.kind);
      if (item.unreadCount > 0) void markRead(item);
      navigateToChat(item);
      return;
    }
    if (activateTimerRef.current !== null) window.clearTimeout(activateTimerRef.current);
    activateTimerRef.current = window.setTimeout(() => {
      activateTimerRef.current = null;
      handleOpen(item);
    }, 220);
  };

  const handleOpen = (item: InboxItem) => {
    trackActivityItemOpen(item.kind);
    if (item.unreadCount > 0) {
      void markRead(item);
    }
    if (onOpenItem) {
      onOpenItem(item);
      return;
    }
    // Master/detail (open in col 3) on desktop — identical interaction to
    // clicking a /search result (stdrc #proj-activity:171042a3 2026-06-23).
    // Mobile keeps the original full-page push behaviour. (The rail-vs-sidebar
    // placement A/B was dropped 2026-06-30 — rail master/detail is the default.)
    const desktopMasterDetail = isDesktopMasterDetailViewport();

    if (item.kind === "thread") {
      const targetMessageId = item.unreadCount > 0
        ? item.firstUnreadMessageId ?? item.latestActivityMessageId
        : item.latestActivityMessageId;
      // Desktop: also mark the slot as a thread so the layout flips to
      // master/detail and SearchContentRoute/InboxContentRoute renders
      // ThreadPanel embedded in col 3 (not the col-4 overlay). This in-place
      // surface is store-owned, so seed threadStore directly.
      if (desktopMasterDetail) {
        // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
        void openThread({
          parentChannelId: item.parentChannelId,
          parentMessageId: item.parentMessageId,
          focusedMessageId: targetMessageId,
          initialThreadChannelId: item.threadChannelId,
        });
        // Stryker restore all
        openContentSlot({ kind: "thread", id: item.threadChannelId, messageId: targetMessageId });
      } else {
        // Mobile leaves Activity for a canonical route. Let URL→store hydrate
        // the thread so this click produces one PUSH, not openThread()'s
        // /activity?thread= PUSH followed by another route PUSH.
        nav.toThreadMessage(
          item.parentChannelId,
          item.parentMessageId,
          targetMessageId,
          item.parentChannelType === "dm" ? "dm" : "channel",
        );
      }
      return;
    }

    if (item.kind === "mention_action") {
      if (desktopMasterDetail) {
        openContentSlot({ kind: "channel", id: item.channelId, messageId: item.messageId });
      } else {
        nav.toMessage(item.channelId, item.messageId);
      }
      return;
    }

    const targetMessageId = item.unreadCount > 0
      ? item.firstUnreadMessageId ?? item.lastMessageId
      : item.lastMessageId;
    if (desktopMasterDetail) {
      // Swapping col-3 entity should drop any col-4 thread from the previous
      // entity (mirror MessageSearchPage.openResult).
      useThreadStore.getState().closeThread();
      openContentSlot({
        kind: item.kind === "dm" ? "dm" : "channel",
        id: item.channelId,
        messageId: targetMessageId,
      });
    } else if (item.kind === "dm") {
      nav.toDmMessage(item.channelId, item.firstMentionMessageId ?? (item.unreadCount > 0 ? item.firstUnreadMessageId ?? item.lastMessageId : item.lastMessageId));
    } else {
      nav.toMessage(item.channelId, item.firstMentionMessageId ?? (item.unreadCount > 0 ? item.firstUnreadMessageId ?? item.lastMessageId : item.lastMessageId));
    }
  };

  const openCtxMenu = useCallback((e: React.MouseEvent, item: InboxItem) => {
    e.preventDefault();
    setCtxMenu(placeInboxContextMenu({ x: e.clientX, y: e.clientY, item }));
  }, []);

  const focusNextUnread = useCallback(() => {
    const unreadItems = visibleItems.filter((item) => item.unreadCount > 0);
    if (unreadItems.length === 0) return;
    const currentIdx = activeFocusKey
      ? unreadItems.findIndex((item) => itemKey(item) === activeFocusKey)
      : -1;
    const next = unreadItems[(currentIdx + 1) % unreadItems.length];
    setFocusedItemKey(itemKey(next));
  }, [activeFocusKey, setFocusedItemKey, visibleItems]);

  const handleHeaderTitleClick = useCallback((event: React.MouseEvent) => {
    if (event.detail < 2) return;
    focusNextUnread();
  }, [focusNextUnread]);

  const handleScroll = (target: HTMLDivElement) => {
    isNearTopRef.current = target.scrollTop < 50;
    setSavedScrollTop(target.scrollTop);
    if (isNearTopRef.current) setNewUpdateCount(0);
    if (
      target.scrollHeight - target.scrollTop - target.clientHeight < 240
      && visibleHasMore
      && !visibleLoadingMore
    ) {
      if (activityView === "saved") {
        void loadMoreSaved();
      } else if (activityView === "done") {
        void loadDoneItems(false, doneItems.length);
      } else if (nextCursor !== null) {
        void loadInbox();
      }
    }
  };

  const contextMenuBackdrop = ctxMenu ? (
    <DismissBackdrop onDismiss={() => setCtxMenu(null)} trapContextMenu />
  ) : null;

  const sidebarResponsiveSuffix = " lg:justify-start lg:gap-2 lg:px-2.5";
  const sidebarLabelClassName = "sr-only lg:not-sr-only lg:min-w-0 lg:flex-1 lg:truncate";
  const sidebarCountClassName = "hidden font-mono text-[11px] tabular-nums text-black/40 lg:inline";
  const sidebarSectionLabelClassName = "hidden flex-1 text-[10px] font-black uppercase text-black/40 lg:block";
  const activityViewOptions = [
    { value: "all" as const, label: formatMessage({ id: "thread.filter.all" }), icon: <Inbox size={14} />, count: activityGroupTotal || totalCount },
    { value: "unread" as const, label: formatMessage({ id: "thread.filter.unread" }), icon: <Mail size={14} />, count: totalUnreadCount },
    { value: "mentions" as const, label: formatMessage({ id: "thread.filter.mentions" }), icon: <AtSign size={14} />, count: null },
    { value: "saved" as const, label: formatMessage({ id: "activity.current.saved" }), icon: <Bookmark size={14} />, count: savedTotal },
    { value: "done" as const, label: formatMessage({ id: "activity.current.done" }), icon: <CheckCircle2 size={14} />, count: doneItems.length },
  ];
  const activeActivityViewOption = activityViewOptions.find((entry) => entry.value === activityView) ?? activityViewOptions[0];
  const compactScopeLabel = selectedActivityGroup
    ? stripActivityTitlePrefix(selectedActivityGroup.channelName)
    : formatMessage({ id: "activity.current.dmAndChannels" });

  const renderActivitySidebarContent = ({
    variant,
    closeAfterSelect = false,
  }: {
    variant: "sidebar" | "dialog";
    closeAfterSelect?: boolean;
  }) => {
    const isDialog = variant === "dialog";
    const testIdPrefix = isDialog ? "activity-switcher" : "activity";
    const navButtonClass = (active: boolean) => isDialog
      ? `flex w-full items-center gap-3 px-3 py-3 text-left text-sm font-bold transition-colors ${active ? "bg-black/[0.06]" : "hover:bg-black/[0.04]"}`
      : `flex w-full items-center justify-center gap-0 border-2 px-2 py-2 text-left text-xs font-bold transition-colors${sidebarResponsiveSuffix} ${active ? "border-black bg-soft-signal shadow-brutal-sm" : "border-transparent hover:border-black/30 hover:bg-black/5"}`;
    const labelClass = isDialog ? "min-w-0 flex-1 truncate" : sidebarLabelClassName;
    const countClass = isDialog ? "font-mono text-black/50" : sidebarCountClassName;
    const sectionClass = isDialog ? "flex-1 text-xs font-black uppercase text-black/45" : sidebarSectionLabelClassName;
    const formatSidebarCount = (count: number) => count > 99 ? "99+" : formatNumber(count);
    const groupRowClass = (active: boolean) => isDialog
      ? `flex w-full border-2 transition-colors ${active ? "border-black bg-black/[0.08]" : "border-transparent hover:border-black/30 hover:bg-black/[0.04]"}`
      : `flex w-full border-2 transition-colors ${active ? "border-black bg-black/[0.08]" : "border-transparent hover:border-black/30 hover:bg-black/5"}`;
    const groupButtonClass = isDialog
      ? "flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm font-bold"
      : `flex min-w-0 flex-1 items-center justify-center gap-0 px-2 py-2 text-left text-xs font-bold${sidebarResponsiveSuffix}`;
    const iconSize = isDialog ? 18 : 15;
    const handleViewClick = (view: ActivitySidebarView) => {
      setSidebarView(view);
      if (closeAfterSelect) setActivitySwitcherOpen(false);
    };
    const handleGroupClick = (groupId: string) => {
      toggleActivityGroup(groupId);
      if (closeAfterSelect) setActivitySwitcherOpen(false);
    };
    const renderGroup = (group: InboxGroupCount, dmChannel?: Channel | null) => {
      const active = effectiveChannelFilterId === group.channelId;
      return (
        <div key={group.channelId} className={groupRowClass(active)} data-testid={`${testIdPrefix}-group-row-${group.channelId}`}>
          <button
            type="button"
            aria-pressed={active}
            className={groupButtonClass}
            onClick={() => handleGroupClick(group.channelId)}
            data-testid={`${testIdPrefix}-group-${group.channelId}`}
            title={stripActivityTitlePrefix(group.channelName)}
          >
            <ActivityGroupIcon group={group} dmChannel={dmChannel} />
            <span className={labelClass}>{stripActivityTitlePrefix(group.channelName)}</span>
            {activityView === "saved" || activityView === "done"
              ? null
              : (
                <span
                  aria-label={formatNumber(group.count)}
                  className={countClass}
                  data-testid={`${testIdPrefix}-group-count-${group.channelId}`}
                  title={formatNumber(group.count)}
                >
                  {formatSidebarCount(group.count)}
                </span>
              )}
          </button>
        </div>
      );
    };
    return (
      <>
        <div className="flex flex-col gap-1">
          <button type="button" className={navButtonClass(activityView === "all")} onClick={() => handleViewClick("all")} data-testid={`${testIdPrefix}-nav-all`} title={formatMessage({ id: "thread.filter.all" })}>
            <Inbox size={iconSize} className="shrink-0" />
            <span className={labelClass}>{formatMessage({ id: "thread.filter.all" })}</span>
            <span aria-label={formatNumber(activityGroupTotal || totalCount)} className={countClass} title={formatNumber(activityGroupTotal || totalCount)}>{formatSidebarCount(activityGroupTotal || totalCount)}</span>
          </button>
          <button type="button" className={navButtonClass(activityView === "unread")} onClick={() => handleViewClick("unread")} data-testid={`${testIdPrefix}-nav-unread`} title={formatMessage({ id: "thread.filter.unread" })}>
            <Mail size={iconSize} className="shrink-0" />
            <span className={labelClass}>{formatMessage({ id: "thread.filter.unread" })}</span>
            {totalUnreadCount > 0 ? <span aria-label={formatNumber(totalUnreadCount)} className={countClass} title={formatNumber(totalUnreadCount)}>{formatSidebarCount(totalUnreadCount)}</span> : null}
          </button>
          <button type="button" className={navButtonClass(activityView === "mentions")} onClick={() => handleViewClick("mentions")} data-testid={`${testIdPrefix}-nav-mentions`} title={formatMessage({ id: "thread.filter.mentions" })}>
            <AtSign size={iconSize} className="shrink-0" />
            <span className={labelClass}>{formatMessage({ id: "thread.filter.mentions" })}</span>
          </button>
          <button type="button" className={navButtonClass(activityView === "saved")} onClick={() => handleViewClick("saved")} data-testid={`${testIdPrefix}-nav-saved`} title={formatMessage({ id: "activity.current.saved" })}>
            <Bookmark size={iconSize} className="shrink-0" />
            <span className={labelClass}>{formatMessage({ id: "activity.current.saved" })}</span>
            {savedTotal > 0 ? <span aria-label={formatNumber(savedTotal)} className={countClass} title={formatNumber(savedTotal)}>{formatSidebarCount(savedTotal)}</span> : null}
          </button>
          <button type="button" className={navButtonClass(activityView === "done")} onClick={() => handleViewClick("done")} data-testid={`${testIdPrefix}-nav-done`} title={formatMessage({ id: "activity.current.done" })}>
            <CheckCircle2 size={iconSize} className="shrink-0" />
            <span className={labelClass}>{formatMessage({ id: "activity.current.done" })}</span>
            {doneItems.length > 0 ? <span aria-label={formatNumber(doneItems.length)} className={countClass} title={formatNumber(doneItems.length)}>{formatSidebarCount(doneItems.length)}</span> : null}
          </button>
        </div>

        <div className="mt-5 flex min-h-0 flex-col" data-testid={isDialog ? "activity-switcher-groups" : "activity-current-groups"}>
          <div className={`mb-1 flex items-center gap-2 px-2 ${isDialog ? "" : "justify-center lg:justify-start"}`}>
            <span className={sectionClass} data-testid={isDialog ? "activity-switcher-group-section-label" : "activity-current-group-section-label"}>{formatMessage({ id: "activity.current.dmAndChannels" })}</span>
          </div>
          <div className="flex min-h-0 flex-col gap-1" data-testid={isDialog ? "activity-switcher-group-list" : "activity-current-group-list"}>
            {dmActivityGroups.map((group) => renderGroup(group, dmChannelById.get(group.channelId) ?? null))}
            {channelActivityGroups.map((group) => renderGroup(group))}
          </div>
        </div>
      </>
    );
  };

  const contextMenuPortal = ctxMenu ? createPortal(
    <div
      className="card-brutal fixed z-[60] overflow-y-auto overflow-x-hidden"
      style={{
        left: ctxMenu.x,
        top: ctxMenu.y,
        width: 184,
        maxWidth: ctxMenu.maxWidth,
        maxHeight: ctxMenu.maxHeight,
      }}
      data-testid="activity-context-menu"
    >
      {(ctxMenu.item.kind !== "thread" || ctxMenu.item.isFollowing !== false) && (
        <MenuItem
          icon={ctxMenu.item.unreadCount > 0 ? <MessageSquareCheck size={14} /> : <MessageSquareDot size={14} />}
          onClick={async () => {
            const channelId = itemChannelId(ctxMenu.item);
            if (ctxMenu.item.unreadCount > 0) {
              await markRead(ctxMenu.item);
            } else {
              await api.post(`/channels/${channelId}/unread`).catch(() => {});
            }
            await refreshInbox();
            setCtxMenu(null);
          }}
        >
          {ctxMenu.item.unreadCount > 0 ? formatMessage({ id: "thread.contextMenu.markAsRead" }) : formatMessage({ id: "thread.contextMenu.markAsUnread" })}
        </MenuItem>
      )}
      <MenuItem
        icon={<Check size={14} />}
        onClick={() => {
          void markDone(ctxMenu.item);
          setCtxMenu(null);
        }}
      >
        {formatMessage({ id: "thread.contextMenu.done" })}
      </MenuItem>
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing !== false && (
        <MenuItem
          icon={<BellOff size={14} />}
          onClick={async () => {
            const item = ctxMenu.item;
            setCtxMenu(null);
            if (item.kind === "thread") {
              try {
                await unfollowThread(item.threadChannelId);
                // Unfollow changes future delivery, not Activity history. Keep
                // this exact row and expose its new follow state.
                markThreadUnfollowed(item);
              } catch {
                // Persistence failed; preserve the canonical followed row and
                // reconcile any unrelated concurrent Activity changes.
                await refreshInbox();
              }
            }
          }}
        >
          {formatMessage({ id: "thread.contextMenu.unfollow" })}
        </MenuItem>
      )}
      {ctxMenu.item.kind === "thread" && ctxMenu.item.isFollowing === false && (
        <MenuItem
          icon={<Bell size={14} />}
          onClick={async () => {
            const item = ctxMenu.item;
            setCtxMenu(null);
            if (item.kind === "thread") {
              try {
                await followThread(item.parentMessageId);
                // Refollow preserves this exact row as an active followed
                // thread.
                markThreadRefollowed(item.threadChannelId);
              } catch {
                // Persistence failed; keep the unfollowed row and reconcile the
                // rest of Activity without fabricating a successful refollow.
                await refreshInbox();
              }
            }
          }}
        >
          {formatMessage({ id: "thread.contextMenu.follow" })}
        </MenuItem>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={formatMessage({ id: "thread.header.title" })}
        subtitle={formatMessage({ id: "thread.header.subtitle" }, { activeCount: totalCount, unreadCount: totalUnreadCount })}
        icon={<Activity size={18} />}
        iconBg="bg-soft-signal"
        onMobileBack={onMobileBack}
        containerProps={{
          "data-testid": "inbox-header",
          title: formatMessage({ id: "thread.header.jumpToNextUnread" }),
        }}
        titleClickProps={{
          "data-testid": "inbox-header-title",
          title: formatMessage({ id: "thread.header.jumpToNextUnread" }),
          onClick: handleHeaderTitleClick,
        }}
      />

      <div className="flex min-h-0 flex-1">
        {activitySidebarInboxEnabled && !compactActivitySidebar ? (
          <aside
            className="scrollbar-quiet hidden w-16 shrink-0 flex-col overflow-y-auto border-r-2 border-black bg-white px-2 py-3 md:flex lg:w-56 lg:p-3"
            data-testid="activity-current-sidebar"
            aria-label={formatMessage({ id: "thread.filter.ariaLabel" })}
          >
            {renderActivitySidebarContent({ variant: "sidebar" })}
          </aside>
        ) : null}

        <section className="flex min-w-0 flex-1 flex-col">
          <div
            data-testid="inbox-toolbar"
            className={`shrink-0 border-b-2 border-black bg-white px-4 ${activitySidebarInboxEnabled && compactActivitySidebar
              ? "flex min-h-[88px] flex-col items-stretch justify-center gap-2 py-2"
              : "flex h-[54px] items-center justify-between gap-3"}`}
          >
            {activitySidebarInboxEnabled && compactActivitySidebar ? (
              <>
                <div className="flex min-w-0 items-center" data-testid="activity-master-primary-controls">
                  <button
                    type="button"
                    className="flex h-8 w-full min-w-0 items-center gap-2 border-2 border-black bg-white px-2 text-xs font-bold shadow-brutal-sm"
                    aria-expanded={activitySwitcherOpen}
                    onClick={() => setActivitySwitcherOpen(true)}
                    data-testid="activity-scope-switcher"
                    title={selectedActivityGroup ? compactScopeLabel : activeActivityViewOption.label}
                  >
                    <span className="shrink-0" aria-hidden="true">{activeActivityViewOption.icon}</span>
                    <span className="shrink-0 text-left">{activeActivityViewOption.label}</span>
                    {selectedActivityGroup ? (
                      <>
                        <span className="h-4 w-px shrink-0 bg-black/25" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-left">{compactScopeLabel}</span>
                      </>
                    ) : null}
                    <ChevronDown size={14} className="shrink-0 text-black/55" />
                  </button>
                </div>
                <div className="flex min-w-0 items-center justify-end gap-2" data-testid="activity-master-scope-controls">
                  {(activitySearchVisible || inboxSearchQuery.trim()) ? (
                    <label className="hidden h-8 min-w-[150px] flex-[1.2] items-center gap-2 border-2 border-black bg-white px-2 shadow-brutal-sm md:flex">
                      <Search size={14} className="shrink-0 text-black/55" />
                      <input
                        ref={activitySearchInputRef}
                        value={inboxSearchQuery}
                        onChange={(event) => setInboxSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || inboxSearchQuery) return;
                          setActivitySearchVisible(false);
                        }}
                        className="min-w-0 flex-1 bg-transparent text-xs font-bold outline-none placeholder:text-black/35"
                        placeholder={formatMessage({ id: "activity.current.searchPlaceholder" })}
                        aria-label={formatMessage({ id: "activity.current.searchAria" })}
                        data-testid="activity-search-input"
                      />
                    </label>
                  ) : null}
                  <div className="w-[116px] shrink-0">
                    <Select
                      value={sortDirection}
                      onValueChange={(value) => setSortDirection(value === "asc" ? "asc" : "desc")}
                      items={activitySortOptions}
                    >
                      <SelectTrigger
                        className="h-8 w-full border-2 border-black bg-white px-2 text-xs font-bold shadow-brutal-sm"
                        aria-label={formatMessage({ id: "activity.current.sortAria" })}
                        data-testid="activity-sort-select"
                      >
                        <ArrowDownUp size={14} className="mr-1.5 shrink-0 text-black/55" />
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                          {activitySortOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              <SelectItemText>{option.label}</SelectItemText>
                              <SelectItemIndicator />
                            </SelectItem>
                          ))}
                        </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                  {showMarkAllRead && (
                    <button
                      onClick={() => void markAllRead()}
                      className="btn-brutal-sm inline-flex h-8 shrink-0 items-center whitespace-nowrap bg-white px-2 text-xs font-bold"
                      title={formatMessage({ id: "thread.markAllRead.title" })}
                      data-testid="inbox-mark-all-read"
                    >
                      {formatMessage({ id: "thread.markAllRead.label" })}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
            <div className="flex min-w-0 items-center gap-2">
              {activitySidebarInboxEnabled ? (
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto md:hidden" aria-label={formatMessage({ id: "thread.filter.ariaLabel" })}>
                  {([
                    { value: "all", labelId: "thread.filter.all" },
                    { value: "unread", labelId: "thread.filter.unread" },
                    { value: "mentions", labelId: "thread.filter.mentions" },
                    { value: "saved", labelId: "activity.current.saved" },
                    { value: "done", labelId: "activity.current.done" },
                  ] as const).map((entry) => (
                    <button
                      key={entry.value}
                      type="button"
                      className={`h-8 shrink-0 border-2 px-2 text-xs font-bold ${activityView === entry.value ? "border-black bg-soft-signal shadow-brutal-sm" : "border-black/20 bg-white"}`}
                      onClick={() => setSidebarView(entry.value)}
                      data-testid={`inbox-filter-${entry.value}`}
                    >
                      {formatMessage({ id: entry.labelId })}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="min-w-0">
                  <SegmentedControl
                    value={filter}
                    onValueChange={setFilter}
                    aria-label={formatMessage({ id: "thread.filter.ariaLabel" })}
                  >
                    <SegmentedControlItem value="all" data-testid="inbox-filter-all">
                      <SegmentedControlLabel>{formatMessage({ id: "thread.filter.all" })}</SegmentedControlLabel>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="unread" data-testid="inbox-filter-unread">
                      <SegmentedControlLabel>{formatMessage({ id: "thread.filter.unread" })}</SegmentedControlLabel>
                    </SegmentedControlItem>
                    <SegmentedControlItem value="mentions" data-testid="inbox-filter-mentions">
                      <SegmentedControlLabel>{formatMessage({ id: "thread.filter.mentions" })}</SegmentedControlLabel>
                    </SegmentedControlItem>
                  </SegmentedControl>
                </div>
              )}
              {activitySidebarInboxEnabled && selectedActivityGroup ? (
                <button
                  type="button"
                  className="hidden min-w-0 items-center gap-1.5 text-xs font-bold text-black/60 hover:text-black md:flex"
                  title={formatMessage({ id: "activity.channelFilter.clearTitle" }, { channel: stripActivityTitlePrefix(selectedActivityGroup.channelName) })}
                  onClick={() => setChannelFilterId(null)}
                  data-testid="activity-selected-channel-filter"
                >
                  <ActivityGroupIcon group={selectedActivityGroup} dmChannel={dmChannelById.get(selectedActivityGroup.channelId) ?? null} />
                  <span className="truncate">{stripActivityTitlePrefix(selectedActivityGroup.channelName)}</span>
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {activitySidebarInboxEnabled ? (
                <>
                  {(activitySearchVisible || inboxSearchQuery.trim()) ? (
                    <label className="hidden h-8 w-[min(260px,24vw)] min-w-[180px] items-center gap-2 border-2 border-black bg-white px-2 shadow-brutal-sm md:flex">
                      <Search size={14} className="shrink-0 text-black/55" />
                      <input
                        ref={activitySearchInputRef}
                        value={inboxSearchQuery}
                        onChange={(event) => setInboxSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || inboxSearchQuery) return;
                          setActivitySearchVisible(false);
                        }}
                        className="min-w-0 flex-1 bg-transparent text-xs font-bold outline-none placeholder:text-black/35"
                        placeholder={formatMessage({ id: "activity.current.searchPlaceholder" })}
                        aria-label={formatMessage({ id: "activity.current.searchAria" })}
                        data-testid="activity-search-input"
                      />
                    </label>
                  ) : null}
                  <div className="hidden md:block">
                    <Select
                      value={sortDirection}
                      onValueChange={(value) => setSortDirection(value === "asc" ? "asc" : "desc")}
                      items={activitySortOptions}
                    >
                      <SelectTrigger
                        className="h-8 min-w-[116px] border-2 border-black bg-white px-2 text-xs font-bold shadow-brutal-sm"
                        aria-label={formatMessage({ id: "activity.current.sortAria" })}
                        data-testid="activity-sort-select"
                      >
                        <ArrowDownUp size={14} className="mr-1.5 shrink-0 text-black/55" />
                        <SelectValue />
                        <SelectIcon />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectList>
                          {activitySortOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              <SelectItemText>{option.label}</SelectItemText>
                              <SelectItemIndicator />
                            </SelectItem>
                          ))}
                        </SelectList>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : null}
              {showMarkAllRead && (
                <button
                  onClick={() => void markAllRead()}
                  className="btn-brutal-sm inline-flex h-8 shrink-0 items-center whitespace-nowrap bg-white px-2 text-xs font-bold"
                  title={formatMessage({ id: "thread.markAllRead.title" })}
                  data-testid="inbox-mark-all-read"
                >
                  {formatMessage({ id: "thread.markAllRead.label" })}
                </button>
              )}
            </div>
              </>
            )}
          </div>

          <div
            ref={scrollRef}
            data-testid="inbox-scroll"
            className="scrollbar-quiet relative flex-1 overflow-y-overlay bg-white p-4 safe-bottom"
            onScroll={(e) => handleScroll(e.currentTarget)}
          >
            {newUpdateCount > 0 && (
              <button
                onClick={() => {
                  scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  setNewUpdateCount(0);
                }}
                className="btn-brutal-sm sticky top-0 left-1/2 -translate-x-1/2 z-10 mb-2 flex items-center gap-1.5 bg-white px-3 py-1.5 text-xs font-bold"
              >
                <ArrowUp size={14} />
                {formatMessage({ id: "thread.newUpdates" }, { count: newUpdateCount })}
              </button>
            )}
            {visibleLoading && visibleItems.length === 0 ? (
              <ConversationCardSkeleton />
            ) : visibleItems.length === 0 ? (
              <EmptyState
                className="flex h-full flex-col items-center justify-center"
                icon={activityView === "saved"
                  ? <Bookmark size={36} />
                  : activityView === "done"
                    ? <CheckCircle2 size={36} />
                    : <MessageSquareText size={36} />}
                title={activityView === "saved"
                    ? formatMessage({ id: "activity.current.emptySaved" })
                    : activityView === "done"
                      ? formatMessage({ id: "activity.current.emptyDone" })
                      : effectiveChannelFilterId && selectedActivityGroup
                    ? formatMessage({ id: "activity.channelFilter.emptyTitle" }, { channel: stripActivityTitlePrefix(selectedActivityGroup.channelName) })
                    : filter === "mentions"
                      ? formatMessage({ id: "thread.empty.mentionsTitle" })
                      : activityReadFilter(filter) === "unread"
                        ? formatMessage({ id: "thread.empty.unreadTitle" })
                        : formatMessage({ id: "thread.empty.defaultTitle" })}
                description={activityView === "saved"
                    ? formatMessage({ id: "activity.current.emptySavedDescription" })
                    : activityView === "done"
                      ? formatMessage({ id: "activity.current.emptyDoneDescription" })
                      : effectiveChannelFilterId
                    ? formatMessage({ id: "activity.channelFilter.emptyDescription" })
                    : filter === "mentions"
                      ? formatMessage({ id: "thread.empty.mentionsDescription" })
                      : formatMessage({ id: "thread.empty.defaultDescription" })}
              />
            ) : (
              <div className="flex flex-col gap-2">
                {visibleItems.map((item) => {
                  const key = itemKey(item);
                  const renderKey = itemRenderKey(item, activityView);
                  // `focused` = transient keyboard/permalink flash; `active` =
                  // sticky "open in col 3" highlight, styled the same as an active
                  // search result (stdrc 2026-06-23).
                  const isFocused = key === activeFocusKey;
                  const isActive = key === openItemKey;
                  return (
                    <InboxRow
                      key={renderKey}
                      item={item}
                      filter={filter}
                      searchQuery={inboxSearchQuery}
                      onOpen={(e) => handleActivate(e, item)}
                      onDone={() => {
                        if (activityView === "done") {
                          void restoreDoneItem(item);
                          return;
                        }
                        trackActivityMark("done");
                        void markDone(item);
                      }}
                      onContextMenu={(event) => openCtxMenu(event, item)}
                      onDragStart={onDragItem ? (event) => onDragItem(event, item) : undefined}
                      focused={isFocused}
                      active={isActive}
                      focusRef={isFocused ? focusedRowRef : undefined}
                      doneAction={activityView === "saved" ? "none" : activityView === "done" ? "restore" : "done"}
                    />
                  );
                })}
                {visibleLoadingMore && (
                  <div className="py-3 text-center text-xs font-bold text-black/40">{formatMessage({ id: "thread.loadingMore" })}</div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      {activitySidebarInboxEnabled && activitySwitcherOpen ? (
        <DialogCard
          title={formatMessage({ id: "thread.header.title" })}
          onClose={() => setActivitySwitcherOpen(false)}
          testId="activity-switcher-dialog"
          closeOnBackdrop
        >
          <div className="scrollbar-quiet max-h-[68vh] min-h-0 overflow-y-auto">
            {renderActivitySidebarContent({ variant: "dialog", closeAfterSelect: true })}
          </div>
        </DialogCard>
      ) : null}
      {contextMenuBackdrop}
      {contextMenuPortal}
    </div>
  );
}
