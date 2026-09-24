import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { Archive, Clock3, Download, EllipsisVertical, File, FileText, Image, MapPin, Paperclip, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "raft-ui";
import api from "../../api/client";
import type { Channel } from "../../store/channelStore";
import type { MessageAttachment } from "../../store/messageStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { imageGalleryBackgroundClass } from "../../utils/imagePreviewStyles";
import AvatarListRow from "../ui/AvatarListRow";
import Button from "../ui/Button";
import EmptyState from "../ui/EmptyState";
import AttachmentTooltip from "./attachmentTooltip";
import {
  formatChannelFileSize,
  getChannelFileType,
} from "../../utils/channelFiles";
import type {
  ChannelFileTypeFilter,
} from "../../utils/channelFiles";
import {
  isAudioPreviewAttachment,
  isDocumentPreviewAttachment,
  isHtmlPreviewAttachment,
  isVideoPreviewAttachment,
} from "./attachmentPreview";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";

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
}

interface AttachmentUrlResponse {
  url: string;
  expiresAt: string | null;
}

const FILES_PAGE_SIZE = 50;

function fileTypeIcon(type: Exclude<ChannelFileTypeFilter, "all">) {
  if (type === "image") return Image;
  if (type === "video") return Video;
  if (type === "pdf") return FileText;
  if (type === "archive") return Archive;
  return File;
}

function isPreviewableImage(file: ChannelFileEntry): boolean {
  const mimeType = file.mimeType.split(";")[0]?.trim().toLowerCase();
  if (mimeType === "image/svg+xml") return Boolean(file.thumbnailUrl);
  return mimeType?.startsWith("image/") ?? false;
}

function imageFitClass(file: ChannelFileEntry): string {
  if (!file.width || !file.height || file.width <= 0 || file.height <= 0) return "object-cover";
  const ratio = file.width / file.height;
  return ratio >= 2.2 || ratio <= 0.55 ? "object-contain" : "object-cover";
}

function ChannelFileVisual({
  file,
  canPreview,
  icon: Icon,
}: {
  file: ChannelFileEntry;
  canPreview: boolean;
  icon: ReturnType<typeof fileTypeIcon>;
}) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const src = file.thumbnailUrl || fallbackUrl;

  // Async-loader pattern: when `file.id` or `canPreview` changes, reset the
  // fallback URL and (if the file lacks a `thumbnailUrl`) async-fetch a
  // presigned URL. The cascading reset+fetch is intended — a different file
  // needs a different presigned URL. Same family as PR #2530's async-loader
  // FPs. Listed all 3 sister rules per @铁根 msg=2e922c7d broaden strategy.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackUrl(null);
    if (!canPreview || file.thumbnailUrl) return () => {
      cancelled = true;
    };

    api
      .get<AttachmentUrlResponse>(`/attachments/${file.id}/url`)
      .then(({ data }) => {
        if (!cancelled) setFallbackUrl(data.url);
      })
      .catch(() => {
        if (!cancelled) setFallbackUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [canPreview, file.id, file.thumbnailUrl]);

  return (
    <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden border-2 border-black bg-white">
      {canPreview && src ? (
        <img
          src={src}
          alt=""
          className={`block h-full w-full ${imageFitClass(file)} ${imageGalleryBackgroundClass}`}
          loading="lazy"
        />
      ) : (
        <Icon size={18} />
      )}
    </span>
  );
}

async function downloadAttachment(file: ChannelFileEntry) {
  const { data } = await api.get(`/attachments/${file.id}/url?disposition=attachment`);
  const link = document.createElement("a");
  link.href = data.url;
  link.download = file.filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

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

function ChannelFileOverflowMenu({
  file,
  onOpenSource,
  onDownload,
}: {
  file: ChannelFileEntry;
  onOpenSource: () => void;
  onDownload: () => void;
}) {
  const { formatMessage } = useIntl();
  const menuLabel = formatMessage(
    { id: "message.channelFilesPanel.fileActions" },
    { filename: file.filename },
  );

  return (
    <DropdownMenu>
      <AttachmentTooltip content={menuLabel}>
        <DropdownMenuTrigger
          render={(
            <Button
              shape="icon"
              aria-label={menuLabel}
              data-testid="channel-file-overflow-trigger"
              data-file-id={file.id}
            >
              <EllipsisVertical size={14} />
            </Button>
          )}
        />
      </AttachmentTooltip>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={4}
        aria-label={menuLabel}
        data-testid="channel-file-overflow-menu"
      >
        <DropdownMenuItem
          onClick={onOpenSource}
          data-testid="channel-file-overflow-jump"
        >
          <MapPin />
          {formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onDownload}
          data-testid="channel-file-overflow-download"
        >
          <Download />
          {formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function ChannelFilesPanel({ channel }: { channel: Channel }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const { formatShortDateTime } = useTimeFormatter();
  const topbarOverflowEnabled = useServerFeatureFlag(
    TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
  ).enabled;
  const loadingMoreRef = useRef(false);
  const [files, setFiles] = useState<ChannelFileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    try {
      const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
        params: { limit: FILES_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      });
      const nextFiles = data.files ?? [];
      setFiles((prev) => mode === "append" ? [...prev, ...nextFiles] : nextFiles);
      setNextCursor(data.nextCursor ?? null);
    } catch {
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
    const loadInitial = async () => {
      setLoading(true);
      setError(null);
      setNextCursor(null);
      try {
        const { data } = await api.get<ChannelFilesResponse>(`/channels/${channel.id}/files`, {
          params: { limit: FILES_PAGE_SIZE },
        });
        if (cancelled) return;
        setFiles(data.files ?? []);
        setNextCursor(data.nextCursor ?? null);
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
    try {
      const { data } = await api.get<AttachmentUrlResponse>(`/attachments/${file.id}/url`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      // Swallow — the row's icon buttons still offer download / jump-to-message.
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={(event) => handleScroll(event.currentTarget)}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm font-mono text-black/40">{formatMessage({ id: "message.channelFilesPanel.loading" })}</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-sm font-bold text-brutal-red">{error}</div>
        ) : files.length === 0 ? (
          <EmptyState
            className="h-full"
            icon={<Paperclip size={36} />}
            title={formatMessage({ id: "emptyState.noFilesTitle" })}
            description={formatMessage({ id: "emptyState.noFilesDesc" })}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2 p-3">
              {files.map((file) => {
                const type = getChannelFileType(file);
                const Icon = fileTypeIcon(type);
                const canPreview = isPreviewableImage(file);
                return (
                  <AvatarListRow
                    key={file.id}
                    align="start"
                    avatar={<ChannelFileVisual file={file} canPreview={canPreview} icon={Icon} />}
                    name={file.filename}
                    subtitle={
                      <>
                        <span>{formatChannelFileSize(file.sizeBytes, formatMessage)}</span>
                        <span className="inline-flex items-center gap-1">
                          <Clock3 size={12} />
                          {formatShortDateTime(file.createdAt)}
                        </span>
                      </>
                    }
                    onClick={() => void openPreview(file)}
                    buttonProps={{ "aria-label": formatMessage({ id: "message.channelFilesPanel.previewFile" }) }}
                    actionContent={
                      topbarOverflowEnabled ? (
                        <div className="channel-file-responsive-actions" data-testid="channel-file-responsive-actions">
                          <div className="channel-file-inline-actions" data-testid="channel-file-inline-actions">
                            <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}>
                              <button
                                onClick={() => openSource(file)}
                                className="btn-brutal-sm flex size-7 items-center justify-center p-0"
                                aria-label={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
                                data-testid="channel-file-inline-jump"
                              >
                                <MapPin size={14} />
                              </button>
                            </AttachmentTooltip>
                            <AttachmentTooltip content={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}>
                              <button
                                onClick={() => void downloadAttachment(file)}
                                className="btn-brutal-sm flex size-7 items-center justify-center p-0"
                                aria-label={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
                                data-testid="channel-file-inline-download"
                              >
                                <Download size={14} />
                              </button>
                            </AttachmentTooltip>
                          </div>
                          <div className="channel-file-overflow-actions">
                            <ChannelFileOverflowMenu
                              file={file}
                              onOpenSource={() => openSource(file)}
                              onDownload={() => void downloadAttachment(file)}
                            />
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            onClick={() => openSource(file)}
                            className="btn-brutal-sm flex size-7 items-center justify-center p-0"
                            title={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
                            aria-label={formatMessage({ id: "message.channelFilesPanel.jumpToMessage" })}
                          >
                            <MapPin size={14} />
                          </button>
                          <button
                            onClick={() => downloadAttachment(file)}
                            className="btn-brutal-sm flex size-7 items-center justify-center p-0"
                            title={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
                            aria-label={formatMessage({ id: "message.channelFilesPanel.downloadFile" })}
                          >
                            <Download size={14} />
                          </button>
                        </>
                      )
                    }
                    className={topbarOverflowEnabled ? "channel-file-row" : ""}
                  />
                );
              })}
            </div>
            {(loadingMore || nextCursor) && (
              <div className="flex justify-center p-4">
                {loadingMore ? (
                  <div className="font-mono text-xs text-black/45">{formatMessage({ id: "message.channelFilesPanel.loadingMore" })}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void loadFilesPage(nextCursor, "append")}
                    className="btn-brutal-sm bg-white px-4 py-1.5 text-xs"
                  >
                    {formatMessage({ id: "message.channelFilesPanel.loadMore" })}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
