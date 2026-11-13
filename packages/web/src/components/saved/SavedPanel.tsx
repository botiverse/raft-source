import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Bookmark, BookmarkMinus, Copy, Link } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  PanelToggleAction,
  ListRow,
  Skeleton,
  ScrollArea,
} from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import { PLAN_CONFIG } from "@botiverse/raft-shared";
import { useSavedStore } from "../../store/savedStore";
import type { SavedEntry } from "../../store/savedStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useAppNavigate, useMobileBack, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import { formatRelativeTime } from "../../utils/relativeTime";
import AvatarSlot from "../ui/AvatarSlot";
import PanelHeader from "../ui/PanelHeader";
import EmptyState from "../ui/EmptyState";
import { SkeletonTextBar } from "../ui/Skeleton";
import { useListSkeletonShown } from "../ui/useListSkeletonShown";
import { ContentLoading } from "../ui/ContentLoading";
import { PagePullToRefreshIndicator } from "../ui/PagePullToRefreshIndicator";
import { usePagePullToRefresh } from "../../hooks/usePagePullToRefresh";
import { showToast } from "../toastBridge";
import { HistoryWindowBanner } from "../message/HistoryWindowNotices";

const FREE_HISTORY_DAYS = PLAN_CONFIG.free.limits.messageHistoryDays;

function stopKeyPropagation(event: React.KeyboardEvent) {
  event.stopPropagation();
}

// Raft Design System › ListRow: a saved message is a content row on the
// paper — no card frame. raft-ui's `plain` ListRow draws the hairline between
// consecutive rows from the 16px edge, the pressed overlay on hover and while
// its context menu is open, and an inset ink ring for keyboard focus. It is a
// div with the button role, since the row holds its own remove button.

// The row's two parts, shared with its skeleton (SavedRowSkeleton): the
// meta line (where, who, when) over the message, up to three lines of it.
const SAVED_ROW_META_CLASS = "mb-1 flex min-w-0 items-center gap-2 text-caption";
const SAVED_ROW_BODY_CLASS = "line-clamp-3 text-callout text-foreground wrap-break-word";
// The unsave toggle at the row's end, and its box in the skeleton row.
const SAVED_ROW_TOGGLE_SLOT_CLASS = "ml-auto shrink-0 self-center";
const SAVED_ROW_TOGGLE_CLASS = "data-pressed:border-transparent data-pressed:bg-transparent data-pressed:text-foreground data-pressed:hover:bg-fill-medium";

const SavedItem = memo(function SavedItem({ entry, onOpenEntry, onRemoveMessage, serverSlug }: {
  entry: SavedEntry;
  onOpenEntry: (entry: SavedEntry) => void;
  onRemoveMessage: (messageId: string) => void;
  serverSlug: string | undefined;
}) {
  const { formatMessage, locale } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  const isThread = entry.channelType === "thread";
  const isDm = isThread
    ? entry.parentChannelType === "dm"
    : entry.channelType === "dm";
  const sourceChannelName = isThread
    ? entry.parentChannelName
    : entry.channelName;
  const channelLabel = isDm
    ? `@${entry.senderName || entry.senderId}`
    : `#${sourceChannelName}`;

  const senderAgent = entry.senderType === "agent"
    ? agents.find((a) => a.id === entry.senderId)
    : null;
  const senderMember = entry.senderType === "user"
    ? resolveMessageSenderMemberFromList({ senderType: "user", senderId: entry.senderId }, members, currentUser) ?? null
    : null;
  const senderName = senderAgent?.displayName ?? senderAgent?.name ?? senderMember?.displayName ?? senderMember?.name ?? entry.senderName;

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    const channelForLink = isThread ? entry.parentChannelId || entry.channelId : entry.channelId;
    const routeKind = isDm ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, entry.messageId, {
      routeKind,
      threadParentMessageId: isThread ? entry.parentMessageId : null,
    });
    navigator.clipboard.writeText(url);
  }, [serverSlug, isDm, isThread, entry.parentChannelId, entry.parentMessageId, entry.channelId, entry.messageId]);

  const handleCopyMarkdown = useCallback(() => {
    navigator.clipboard.writeText(entry.content);
  }, [entry.content]);

  const handleRemove = useCallback(() => {
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleRemoveButtonClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleOpen = useCallback(() => {
    onOpenEntry(entry);
  }, [entry, onOpenEntry]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleOpen();
    }
  }, [handleOpen]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          // A list cell (raft-design patterns/lists.md): no line between
          // saved messages, every state on the row's 8px-inset shape.
          <ListRow
            variant="plain"
            cell
            render={<div />}
            role="button"
            tabIndex={0}
            data-saved-row=""
            onClick={handleOpen}
            onKeyDown={handleKeyDown}
          />
        }
      >
        <div className="min-w-0 flex-1">
          <div className={SAVED_ROW_META_CLASS}>
            {/* A long channel name truncates with the sender, so the thread
                mark and the time stay whole in a narrow column. */}
            <span className="min-w-0 truncate text-foreground-hint">{channelLabel}</span>
            {isThread && (
              <span className="inline-flex shrink-0 items-center gap-1 text-foreground-hint">
                <ThreadIcon width={12} height={12} />
                {formatMessage({ id: "saved.threadLabel" })}
              </span>
            )}
            {senderName && (
              <span className="inline-flex min-w-0 items-center gap-1 font-semibold text-foreground">
                {senderAgent ? (
                  <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={senderAgent.avatarUrl ?? null} />
                ) : entry.senderType === "external_projection" ? (
                  <AvatarSlot context="preview-mini" type="app" appAvatarUrl={entry.senderAvatarUrl} appInitials={senderName} />
                ) : (
                  <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={senderMember?.avatarUrl} />
                )}
                <span className="truncate">{senderName}</span>
              </span>
            )}
            <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">
              {formatRelativeTime(entry.createdAt, locale) ?? ""}
            </span>
          </div>
          <p className={SAVED_ROW_BODY_CLASS}>
            {entry.content}
          </p>
        </div>
        <div className={SAVED_ROW_TOGGLE_SLOT_CLASS}>
          {/* Every row here is saved, so the toggle is the remove action, drawn
              as the message menu draws it (BookmarkMinus, icon standard v4: no
              filled icon for a state), and stays a quiet icon button: a yellow
              sticker on each row would paint the list yellow (Raft DS: yellow
              is for where you are, and content stays on white paper). */}
          <PanelToggleAction
            pressed
            onKeyDown={stopKeyPropagation}
            onClick={handleRemoveButtonClick}
            aria-label={formatMessage({ id: "saved.remove" })}
            className={SAVED_ROW_TOGGLE_CLASS}
          >
            <BookmarkMinus size={14} aria-hidden />
          </PanelToggleAction>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopyLink}>
          <Link size={14} />
          <span>{formatMessage({ id: "saved.copyLink" })}</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyMarkdown}>
          <Copy size={14} />
          <span>{formatMessage({ id: "saved.copyMarkdown" })}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleRemove}>
          <BookmarkMinus size={14} />
          <span>{formatMessage({ id: "saved.remove" })}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * A saved message while the list loads: SavedItem's own row (a plain ListRow
 * cell) and its meta and message lines with bars in them, so it is the loaded
 * row's height: the meta line and one line of the message with a mouse on a
 * desktop, two on a phone, where most messages wrap. The unsave toggle's box
 * is kept (the toggle itself, invisible and inert), so the text column is the
 * loaded row's width and the message wraps where it will (skeleton-vs-layout
 * audit round 2: 350 vs 294px on a phone).
 */
export function SavedRowSkeleton() {
  return (
    <ListRow variant="plain" cell interactive={false} render={<div />} aria-hidden="true" data-skeleton="">
      <div className="min-w-0 flex-1">
        <div className={SAVED_ROW_META_CLASS}>
          <span><SkeletonTextBar className="w-16" /></span>
          <span className="inline-flex items-center gap-1">
            <Skeleton className="size-3.5" />
            <span><SkeletonTextBar className="w-20" /></span>
          </span>
          <span className="font-mono text-mono-meta"><SkeletonTextBar className="w-10" /></span>
        </div>
        {/* A div where the row has a p: a skeleton bar is a div. */}
        <div className={SAVED_ROW_BODY_CLASS}>
          <div><SkeletonTextBar className="w-3/4" /></div>
          <div className="md:pointer-fine:hidden"><SkeletonTextBar className="w-1/2" /></div>
        </div>
      </div>
      <div className={`${SAVED_ROW_TOGGLE_SLOT_CLASS} invisible`} data-saved-toggle-reserved="">
        <PanelToggleAction pressed disabled tabIndex={-1} className={SAVED_ROW_TOGGLE_CLASS}>
          <BookmarkMinus size={14} aria-hidden />
        </PanelToggleAction>
      </div>
    </ListRow>
  );
}

function SavedListSkeleton() {
  const shown = useListSkeletonShown();
  if (!shown) return null;
  return Array.from({ length: 8 }, (_, index) => <SavedRowSkeleton key={index} />);
}

export default function SavedPanel({ embedded = false }: {
  /** Embedded hosts own the surrounding panel header and navigation. */
  embedded?: boolean;
} = {}) {
  const { formatMessage } = useIntl();
  const saved = useSavedStore((s) => s.saved);
  // True total (server count), not the loaded-so-far page length — the panel
  // header has room for the exact number (the sidebar badge caps at 99+).
  const savedTotal = useSavedStore((s) => s.total);
  const loadSaved = useSavedStore((s) => s.loadSaved);
  const loadMore = useSavedStore((s) => s.loadMore);
  const hasMore = useSavedStore((s) => s.hasMore);
  const loading = useSavedStore((s) => s.loading);
  const unsaveMessage = useSavedStore((s) => s.unsaveMessage);
  // Saved messages behind the plan's 30-day window are not listed; a card
  // counts them (cindyz, task #8, frame 16). A plan change reloads the list
  // (socketBridge, server:plan-updated).
  const historyHiddenCount = useSavedStore((s) => s.historyHiddenCount);
  const openThread = useThreadStore((s) => s.openThread);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const serverId = useServerStore((s) => s.current?.id);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const nav = useAppNavigate();
  // A raft-ui ScrollArea: its overlay scrollbar takes no width, so the rows'
  // shapes sit 8px from both of its edges on every platform.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  const openSavedEntry = useCallback((entry: SavedEntry) => {
    if (entry.channelType === "thread" && entry.parentChannelId && entry.parentMessageId) {
      nav.toMessage(entry.parentChannelId, entry.parentMessageId);
      // Stryker disable all: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: entry.parentChannelId,
        parentMessageId: entry.parentMessageId,
        focusedMessageId: entry.messageId,
      });
      // Stryker restore all
    } else {
      nav.toMessage(entry.channelId, entry.messageId);
    }
  }, [nav, openThread]);

  const removeSavedMessage = useCallback((messageId: string) => {
    void unsaveMessage(messageId);
  }, [unsaveMessage]);

  useEffect(() => {
    // The route can mount one render before ServerResolver selects the URL's
    // server.  An early request has no X-Server-Id and is rejected/empty;
    // retry when the authoritative server context arrives so a refresh cannot
    // make an existing Saved row appear to disappear permanently.
    if (!serverId) return;
    void loadSaved({ query: "", sortDirection: "desc" });
  }, [loadSaved, serverId]);

  useEffect(() => {
    if (!hasMore || loading || saved.length === 0) return;
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: scrollerRef.current,
        rootMargin: "240px 0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loading, saved.length]);

  // Saved is a snapshot (Raft DS › Navigation › Refreshing): on a phone a pull
  // loads it again, under the pull's own spinner rather than the skeleton. A
  // failure keeps the rows and says so in a toast.
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = loading && saved.length === 0 && historyHiddenCount === 0 && !refreshing;
  const refreshSaved = useCallback(async () => {
    setRefreshing(true);
    const loaded = await loadSaved({ query: "", sortDirection: "desc" });
    setRefreshing(false);
    if (loaded === false) {
      showToast({ title: formatMessage({ id: "saved.loadError" }), type: "warning" });
    }
  }, [formatMessage, loadSaved]);
  const pull = usePagePullToRefresh(scrollerRef, {
    onRefresh: refreshSaved,
    disabled: !serverId || firstLoad,
  });
  // Saved messages older than the plan's window aren't listed; one line at
  // the top says how many (cindyz, 2026-10-29: a Banner, as on search).
  const historyCard = historyHiddenCount > 0 ? (
    <HistoryWindowBanner surface="saved" className="px-(--column-margin) pb-1 pt-2" testId="saved-history-hidden">
      {formatMessage(
        { id: saved.length === 0 ? "saved.historyHidden.bannerAll" : "saved.historyHidden.banner" },
        { count: historyHiddenCount, days: FREE_HISTORY_DAYS },
      )}
    </HistoryWindowBanner>
  ) : null;

  return (
    // A column of list cells: its head and rows share one edge, 20px at every
    // width (raft-ui --column-margin; raft-design patterns/lists.md).
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas [--column-margin:20px]">
      {!embedded ? (
        <PanelHeader
          title={formatMessage({ id: "saved.header.title" })}
          // No count before the list is read ("0 saved items" while it
          // loads): the line's box stays, empty.
          subtitle={firstLoad ? "\u00a0" : formatMessage({ id: "saved.header.subtitle" }, { count: savedTotal })}
          onMobileBack={onMobileBack}
        />
      ) : null}

      {/* Saved list */}
      <ScrollArea
        ref={scrollerRef}
        data-testid="saved-list-scroller"
        className="flex-1 bg-layer-canvas"
        // The content fills the area, so the empty state stays centred in it.
        contentClassName="flex min-h-full flex-col py-1 safe-bottom"
        // The scroller stays when the rows arrive, so it carries the busy state.
        aria-busy={firstLoad || undefined}
      >
        <PagePullToRefreshIndicator pull={pull} />
        {firstLoad ? (
          // Rows in the shape of SavedItem, after the 1s wait (task #154).
          <div className="flex flex-col gap-0.5 py-1" data-testid="saved-loading-skeleton">
            <SavedListSkeleton />
          </div>
        ) : saved.length === 0 && historyCard ? (
          historyCard
        ) : saved.length === 0 ? (
          <EmptyState
            className="flex flex-1 flex-col items-center justify-center"
            icon={<Bookmark size={36} />}
            title={formatMessage({ id: "emptyState.noSavedTitle" })}
            description={formatMessage({ id: "saved.emptyDescription" })}
          />
        ) : (
          // A list of cells: 2px between rows, 8px at its ends with the
          // scroller's own 4px.
          <div className="flex flex-col gap-0.5 py-1">
            {historyCard}
            {saved.map((entry) => (
              <SavedItem
                key={entry.messageId}
                entry={entry}
                serverSlug={serverSlug}
                onOpenEntry={openSavedEntry}
                onRemoveMessage={removeSavedMessage}
              />
            ))}
            {hasMore && (
              <div
                ref={loadMoreSentinelRef}
                data-testid="saved-infinite-scroll-sentinel"
                className="flex min-h-10 items-center justify-center py-3"
              >
                {loading ? (
                  <ContentLoading>{formatMessage({ id: "common.loading" })}</ContentLoading>
                ) : (
                  <span role="status" className="sr-only">{formatMessage({ id: "saved.loadingMore" })}</span>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
