import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { createPortal } from "react-dom";
import { Bookmark, Copy, Link, MessageSquare } from "lucide-react";
import { useSavedStore } from "../../store/savedStore";
import type { SavedEntry } from "../../store/savedStore";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useThreadStore } from "../../store/threadStore";
import { useAppNavigate, useMobileBack, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import { formatRelativeTime } from "../../utils/relativeTime";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import AvatarSlot from "../ui/AvatarSlot";
import PanelHeader from "../ui/PanelHeader";
import DismissBackdrop from "../ui/DismissBackdrop";
import EmptyState from "../ui/EmptyState";
import { ConversationCardSkeleton } from "../ui/Skeleton";

const SavedItem = memo(function SavedItem({ entry, onOpenEntry, onRemoveMessage, onDragEntry, serverSlug }: {
  entry: SavedEntry;
  onOpenEntry: (entry: SavedEntry) => void;
  onRemoveMessage: (messageId: string) => void;
  onDragEntry?: (event: React.DragEvent<HTMLButtonElement>, entry: SavedEntry) => void;
  serverSlug: string | undefined;
}) {
  const { formatMessage, locale } = useIntl();
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 100),
    });
  }, []);

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    const channelForLink = isThread ? entry.parentChannelId || entry.channelId : entry.channelId;
    const routeKind = isDm ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, entry.messageId, {
      routeKind,
      threadParentMessageId: isThread ? entry.parentMessageId : null,
    });
    navigator.clipboard.writeText(url).then(() => setCtxMenu(null));
  }, [serverSlug, isDm, isThread, entry.parentChannelId, entry.parentMessageId, entry.channelId, entry.messageId]);

  const handleCopyMarkdown = useCallback(() => {
    navigator.clipboard.writeText(entry.content).then(() => setCtxMenu(null));
  }, [entry.content]);

  const handleRemove = useCallback(() => {
    setCtxMenu(null);
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleRemoveButtonClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onRemoveMessage(entry.messageId);
  }, [entry.messageId, onRemoveMessage]);

  const handleOpen = useCallback(() => {
    onOpenEntry(entry);
  }, [entry, onOpenEntry]);

  const handleDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    onDragEntry?.(event, entry);
  }, [entry, onDragEntry]);

  const handleCloseCtx = useCallback(() => setCtxMenu(null), []);

  return (
    <>
      <button
        onClick={handleOpen}
        draggable={!!onDragEntry}
        onDragStart={onDragEntry ? handleDragStart : undefined}
        onContextMenu={handleContextMenu}
        className={`relative flex items-start gap-3 border-2 transition-colors p-3 bg-white text-left w-full ${
          ctxMenu
            ? "border-black shadow-brutal-sm"
            : "border-black/30 hover:border-black hover:shadow-brutal-sm active:border-black active:shadow-brutal-sm"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="font-bold text-black/50">{channelLabel}</span>
            {isThread && (
              <span className="inline-flex items-center gap-1 font-bold text-black/40">
                <MessageSquare size={10} />
                {formatMessage({ id: "saved.threadLabel" })}
              </span>
            )}
            {senderName && (
              <span className="inline-flex items-center gap-1 font-bold text-black">
                {senderAgent ? (
                  <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={senderAgent.avatarUrl ?? null} />
                ) : entry.senderType === "external_projection" ? (
                  <AvatarSlot context="preview-mini" type="app" appAvatarUrl={entry.senderAvatarUrl} appInitials={senderName} />
                ) : (
                  <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={senderMember?.avatarUrl} gravatarHash={senderMember?.gravatarHash} />
                )}
                <span>{senderName}</span>
              </span>
            )}
            <span className="text-xs text-black/40 font-mono">
              {formatRelativeTime(entry.createdAt, locale) ?? ""}
            </span>
          </div>
          <p className="text-sm line-clamp-3">
            {entry.content}
          </p>
        </div>
        <div className="group relative shrink-0">
          <div
            onClick={handleRemoveButtonClick}
            className="btn-brutal-sm inline-flex size-7 items-center justify-center bg-brutal-orange/15 p-0 text-brutal-orange transition-[filter] duration-100 hover:brightness-90"
            title={formatMessage({ id: "saved.remove" })}
            aria-label={formatMessage({ id: "saved.remove" })}
            role="button"
          >
            <Bookmark size={14} fill="currentColor" />
          </div>
          <span className="pointer-events-none absolute right-full top-1/2 mr-2 hidden -translate-y-1/2 whitespace-nowrap border-2 border-black bg-brutal-orange/15 px-2 py-1 text-xs font-bold text-black shadow-brutal-sm group-hover:inline">
            {formatMessage({ id: "saved.remove" })}
          </span>
        </div>
      </button>
      {ctxMenu && createPortal(
        <>
          <DismissBackdrop onDismiss={handleCloseCtx} trapContextMenu />
          <div
            className="fixed z-50 card-brutal overflow-hidden"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
          >
            <MenuItem
              icon={<Link size={14} />}
              onClick={handleCopyLink}
            >
              {formatMessage({ id: "saved.copyLink" })}
            </MenuItem>
            <MenuItem
              icon={<Copy size={14} />}
              onClick={handleCopyMarkdown}
            >
              {formatMessage({ id: "saved.copyMarkdown" })}
            </MenuItem>
            <ContextMenuDivider />
            <MenuItem
              icon={<Bookmark size={14} fill="currentColor" className="text-brutal-orange" />}
              onClick={handleRemove}
            >
              {formatMessage({ id: "saved.remove" })}
            </MenuItem>
          </div>
        </>,
        document.body
      )}
    </>
  );
});

export default function SavedPanel({ onOpenEntry, onDragEntry, embedded = false }: {
  onOpenEntry?: (entry: SavedEntry) => void;
  onDragEntry?: (event: React.DragEvent<HTMLButtonElement>, entry: SavedEntry) => void;
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
  const openThread = useThreadStore((s) => s.openThread);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const nav = useAppNavigate();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

  const openSavedEntry = useCallback((entry: SavedEntry) => {
    if (onOpenEntry) {
      onOpenEntry(entry);
      return;
    }
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
  }, [nav, onOpenEntry, openThread]);

  const removeSavedMessage = useCallback((messageId: string) => {
    void unsaveMessage(messageId);
  }, [unsaveMessage]);

  useEffect(() => {
    void loadSaved({ query: "", sortDirection: "desc" });
  }, [loadSaved]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!embedded ? (
        <PanelHeader
          title={formatMessage({ id: "saved.header.title" })}
          subtitle={formatMessage({ id: "saved.header.subtitle" }, { count: savedTotal })}
          icon={<Bookmark size={18} />}
          iconBg="bg-soft-signal"
          onMobileBack={onMobileBack}
        />
      ) : null}

      {/* Saved list */}
      <div
        ref={scrollerRef}
        data-testid="saved-list-scroller"
        className="flex-1 overflow-y-auto bg-white p-4 safe-bottom"
      >
        {loading && saved.length === 0 ? (
          <ConversationCardSkeleton />
        ) : saved.length === 0 ? (
          <EmptyState
            className="flex h-full flex-col items-center justify-center"
            icon={<Bookmark size={36} />}
            title={formatMessage({ id: "emptyState.noSavedTitle" })}
            description={formatMessage({ id: "saved.emptyDescription" })}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {saved.map((entry) => (
              <SavedItem
                key={entry.messageId}
                entry={entry}
                serverSlug={serverSlug}
                onOpenEntry={openSavedEntry}
                onRemoveMessage={removeSavedMessage}
                onDragEntry={onDragEntry}
              />
            ))}
            {hasMore && (
              <div
                ref={loadMoreSentinelRef}
                data-testid="saved-infinite-scroll-sentinel"
                className="flex min-h-10 items-center justify-center py-3"
                aria-live="polite"
              >
                {loading ? (
                  <span className="text-xs font-bold text-black/50">{formatMessage({ id: "common.loading" })}</span>
                ) : (
                  <span className="sr-only">{formatMessage({ id: "saved.loadingMore" })}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
