import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  FilesList,
  FilesPanel,
  FilesViewport,
} from "@botiverse/raft-ui";
import { asChannelId } from "@botiverse/raft-shared";

import api from "../../api/client";
import type { Channel } from "../../store/channelStore";
import type { MessageAttachment } from "../../store/messageStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import EmptyState from "../ui/EmptyState";
import {
  isAudioPreviewAttachment,
  isDocumentPreviewAttachment,
  isHtmlPreviewAttachment,
  isVideoPreviewAttachment,
} from "./attachmentPreview";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";
import {
  ChannelFilesPanelFileRow,
  downloadAttachment,
  isPreviewableImage,
} from "./ChannelFilesPanelFileRow";
import { ContentLoading } from "../ui/ContentLoading";
import { COMPACT_LIST_BLEED } from "../task/compactRow";
import { PagePullToRefreshIndicator } from "../ui/PagePullToRefreshIndicator";
import { usePagePullToRefresh } from "../../hooks/usePagePullToRefresh";
import { showToast } from "../toastBridge";
import { useConversationArtifacts } from "../../apps/artifacts";
import { ConversationArtifactsSection } from "./ChannelFilesArtifactRow";
import { HistoryWindowBanner, reachesPastHistoryWindow, useHistoryWindowDays } from "./HistoryWindowNotices";

export interface ChannelFileEntry {
  id: string;
  messageId: string;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string | null;
  createdAt: string;
  uploader: {
    type: "user" | "agent" | "external_projection";
    id: string;
    name: string | null;
    displayName: string | null;
  };
  source: {
    type: "channel" | "thread";
    channelId: string;
    parentMessageId: string | null;
    parentMessageShortId: string | null;
  };
}

interface ChannelFilesResponse {
  files: ChannelFileEntry[];
  nextCursor: string | null;
  /** First page on a plan with a history window: whether the window hides any of the channel's files (absent from older servers). */
  historyLimited?: boolean;
}

const FILES_PAGE_SIZE = 50;

function fileToMessageAttachment(file: ChannelFileEntry): MessageAttachment {
  return {
    id: file.id,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    width: file.width ?? null,
    height: file.height ?? null,
    thumbnailUrl: file.thumbnailUrl ?? null,
  };
}

/**
 * `card` (the legacy Files tab): raft-ui's FileRow cards. `compact` (the Files
 * card beside the conversation, task v2): the compact row the task lists use
 * (raft-design patterns/tasks.md, "Rows in a compact list").
 */
export default function ChannelFilesPanel({ channel, variant = "card" }: { channel: Channel; variant?: "card" | "compact" }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  // On a plan with a history window, when the window hides some of the
  // channel's files (the first page says so), a Banner at the top says so (no
  // count; cindyz, 2026-10-29), as the search page does. An older server
  // doesn't say: then any channel older than the window may have some.
  const historyWindowDays = useHistoryWindowDays();
  const [filesHidden, setFilesHidden] = useState<boolean | null>(null);
  const filesMayBeHidden = historyWindowDays !== null
    && (filesHidden ?? reachesPastHistoryWindow(channel.createdAt, historyWindowDays));
  // Inset to the rows' margin: 20px (16 on a phone) in the compact side card,
  // which adds none of its own; the card list's 12px otherwise.
  const historyBanner = filesMayBeHidden ? (
    <HistoryWindowBanner
      surface="files"
      className={variant === "compact" ? "px-(--surface-inset) pt-3 pb-2 max-md:px-4" : "px-3 pt-3"}
      testId="channel-files-history-hidden"
    >
      {formatMessage({ id: "message.channelFilesPanel.historyHidden" }, { days: historyWindowDays })}
    </HistoryWindowBanner>
  ) : null;
  const loadingMoreRef = useRef(false);
  const [files, setFiles] = useState<ChannelFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the list's first page is replaced (another channel, a pull to
  // refresh): a page that was loading for the old list is dropped.
  const firstPageEpochRef = useRef(0);
  // The Artifacts whose home is this conversation, above its attachments (workspace_artifacts_v0).
  // The files never wait for them; with no files, the list waits so it doesn't flash empty.
  const conversationArtifacts = useConversationArtifacts(asChannelId(channel.id));
  const artifactsView = conversationArtifacts.view;
  const noArtifacts = artifactsView.status === "hidden" || (artifactsView.status === "ready" && artifactsView.cards.length === 0);

  const loadFilesPage = useCallback(async (cursor: string | null, mode: "reset" | "append") => {
    if (mode === "append") {
      if (!cursor || loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true);
      setNextCursor(null);
    }
    setError(null);
    const epoch = firstPageEpochRef.current;
    try {
      const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
        params: { limit: FILES_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      if (epoch !== firstPageEpochRef.current) return;
      const nextFiles = data.files ?? [];
      setFiles((prev) => mode === "append" ? [...prev, ...nextFiles] : nextFiles);
      setNextCursor(data.nextCursor ?? null);
      if (mode !== "append") setFilesHidden(data.historyLimited ?? null);
    } catch {
      if (epoch !== firstPageEpochRef.current) return;
      setError(formatMessage({ id: mode === "append"
        ? "message.channelFilesPanel.loadMoreError"
        : "message.channelFilesPanel.loadError" }));
    } finally {
      if (mode === "append") {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  }, [channel.id, formatMessage]);

  useEffect(() => {
    let cancelled = false;
    firstPageEpochRef.current += 1;
    const loadInitial = async () => {
      setLoading(true);
      setError(null);
      setNextCursor(null);
      setFilesHidden(null);
      try {
        const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
          params: { limit: FILES_PAGE_SIZE },
        });
        if (cancelled) return;
        setFiles(data.files ?? []);
        setNextCursor(data.nextCursor ?? null);
        setFilesHidden(data.historyLimited ?? null);
      } catch {
        if (!cancelled) setError(formatMessage({ id: "message.channelFilesPanel.loadError" }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [channel.id, formatMessage]);

  // A conversation's files are a snapshot (Raft DS › Navigation ›
  // Refreshing): on a phone a pull loads the first page again and swaps it in
  // when it arrives. A failure keeps the files on screen and shows the failed
  // first load's message in a toast.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const refreshFiles = useCallback(async () => {
    const epoch = firstPageEpochRef.current;
    try {
      const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
        params: { limit: FILES_PAGE_SIZE },
      });
      if (epoch !== firstPageEpochRef.current) return;
      firstPageEpochRef.current += 1;
      setFiles(data.files ?? []);
      setNextCursor(data.nextCursor ?? null);
      setFilesHidden(data.historyLimited ?? null);
      setError(null);
    } catch {
      if (epoch !== firstPageEpochRef.current) return;
      showToast({ title: formatMessage({ id: "message.channelFilesPanel.loadError" }), type: "warning" });
    }
  }, [channel.id, formatMessage]);
  const pull = usePagePullToRefresh(viewportRef, { onRefresh: refreshFiles, disabled: loading });

  const handleScroll = useCallback((target: HTMLDivElement) => {
    if (!nextCursor || loading || loadingMore) return;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 320) {
      void loadFilesPage(nextCursor, "append");
    }
  }, [loadFilesPage, loading, loadingMore, nextCursor]);

  const openSource = useCallback((file: ChannelFileEntry) => {
    if (file.source.type === "thread" && file.source.parentMessageId) {
      nav.toThreadMessage(channel.id, file.source.parentMessageId, file.messageId, channel.type === "dm" ? "dm" : "channel");
      return;
    }
    if (channel.type === "dm") nav.toDmMessage(channel.id, file.messageId);
    else nav.toMessage(channel.id, file.messageId);
  }, [channel.id, channel.type, nav]);

  // Row click opens a preview of the file itself (not the source message).
  // Images go through the shared image lightbox, documents through the shared
  // document preview surface, media through the shared media preview surface,
  // and remaining file types keep the signed URL fallback that lets the
  // browser decide whether it can render them inline.
  const openPreview = useCallback(async (file: ChannelFileEntry) => {
    const attachment = fileToMessageAttachment(file);
    if (isPreviewableImage(file)) {
      useImageLightboxStore.getState().open(
        [attachment],
        0,
      );
      return;
    }
    if (isDocumentPreviewAttachment(attachment)) {
      await openDocumentPreview(attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isHtmlPreviewAttachment(attachment)) {
      await openMediaPreview("html", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isVideoPreviewAttachment(attachment)) {
      await openMediaPreview("video", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    if (isAudioPreviewAttachment(attachment)) {
      await openMediaPreview("audio", attachment, {
        onFallbackDownload: () => downloadAttachment(file),
      });
      return;
    }
    // A file Raft can't preview downloads, like the row's own download button:
    // opening its raw address in a new tab left Raft for a bare file
    // (design: Navigation › Links that leave Raft).
    try {
      await downloadAttachment(file);
    } catch {
      // Swallow — the row's icon buttons still offer download / jump-to-message.
    }
  }, []);

  const handleViewportScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    handleScroll(event.currentTarget);
  }, [handleScroll]);

  const handleLoadMore = useCallback(() => {
    void loadFilesPage(nextCursor, "append");
  }, [loadFilesPage, nextCursor]);

  return (
    <FilesPanel>
      <FilesViewport ref={viewportRef} onScroll={handleViewportScroll}>
        <PagePullToRefreshIndicator pull={pull} />
        {loading || (files.length === 0 && artifactsView.status === "loading") ? (
          <ContentLoading className="h-full">{formatMessage({ id: "message.channelFilesPanel.loading" })}</ContentLoading>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-callout font-semibold text-danger-strong">{error}</div>
        ) : files.length === 0 && noArtifacts && filesMayBeHidden ? (
          <div className="flex h-full flex-col">
            {historyBanner}
            <EmptyState
              className="flex-1"
              icon={<Paperclip size={36} />}
              title={formatMessage({ id: "message.channelFilesPanel.noRecentFiles" }, { days: historyWindowDays })}
            />
          </div>
        ) : files.length === 0 && noArtifacts ? (
          <EmptyState
            className="h-full"
            icon={<Paperclip size={36} />}
            title={formatMessage({ id: "emptyState.noFilesTitle" })}
            description={formatMessage({ id: "emptyState.noFilesDesc" })}
          />
        ) : (
          <>
            {historyBanner}
            <FilesList className={variant === "compact" ? `gap-0 p-0 max-md:px-0 ${COMPACT_LIST_BLEED}` : "flex flex-col gap-2 p-3"} data-testid="channel-files-list" data-variant={variant}>
              <ConversationArtifactsSection {...conversationArtifacts} conversationId={channel.id} compact={variant === "compact"} />
              {files.map((file) => (
                <ChannelFilesPanelFileRow
                  key={file.id}
                  file={file}
                  onOpenPreview={openPreview}
                  onOpenSource={openSource}
                  compact={variant === "compact"}
                />
              ))}
            </FilesList>
            {(loadingMore || nextCursor) && (
              <div className="flex justify-center p-4">
                {loadingMore ? (
                  <ContentLoading>{formatMessage({ id: "message.channelFilesPanel.loadingMore" })}</ContentLoading>
                ) : (
                  <Button
                    type="button"
                    onClick={handleLoadMore}
                    size="md"
                    variant="outline"
                  >
                    {formatMessage({ id: "message.channelFilesPanel.loadMore" })}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </FilesViewport>
    </FilesPanel>
  );
}
