import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { ChevronRight, ChevronUp, Forward, Image as ImageIcon } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import {
  MessageForwardedBundle,
  MessageForwardedBundleFooter,
  MessageForwardedBundleFooterAction,
  MessageForwardedBundleGallery,
  MessageForwardedBundleGalleryTile,
  MessageForwardedBundleHeader,
  MessageForwardedBundleHeaderContent,
  MessageForwardedBundleHeaderCount,
  MessageForwardedBundleHeaderLabel,
  MessageForwardedBundleItem,
  MessageForwardedBundleItemAuthor,
  MessageForwardedBundleItemContent,
  MessageForwardedBundleItemMeta,
  MessageForwardedBundleItems,
  MessageForwardedBundleSource,
  MessageForwardedBundleSourceLabel,
  MessageImageGalleryPreview,
} from "@botiverse/raft-ui";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import MarkdownContent from "../markdown/MarkdownContent";
import AttachmentTooltip from "./attachmentTooltip";
import { fetchInlineAttachmentUrls } from "./inlineAttachmentUrlCache";
import { AttachmentChip } from "./AttachmentChip";
import { isDocumentPreviewAttachment } from "./attachmentPreview";
import type { MessageAttachment } from "../../store/messageStore";
import { getMessageBodyFontSizeClass, getMessageBodyFontSizeStyle, useAppearanceStore } from "../../store/appearanceStore";
import { isHeicImageMimeType } from "../../utils/imageMimeTypes";

export interface ForwardedBundleAttachmentSnapshot {
  id?: string;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number;
  width?: number | null;
  height?: number | null;
}

export interface ForwardedBundleSenderSnapshot {
  type?: "user" | "agent" | string;
  id?: string;
  name?: string;
  uniqueName?: string;
}

export interface ForwardedBundleTargetSnapshot {
  id: string | null;
  type?: string;
  label: string;
  labelVisibility?: "public" | "restricted" | string;
}

export interface ForwardedBundleItem {
  index?: number;
  sourceMessageSeq?: number | null;
  sourceIsThreadParent?: boolean;
  sourceTargetId?: string | null;
  sourceThreadId?: string | null;
  parentChannelId?: string | null;
  /** A task discussion's source (public sources only): the task, its number and title. */
  sourceTaskId?: string | null;
  sourceTaskNumber?: number | null;
  sourceTaskTitle?: string | null;
  sourceMessageId?: string | null;
  sourceAuthorSnapshot?: ForwardedBundleSenderSnapshot;
  sourceCreatedAt?: string;
  sourceTargetSnapshot?: ForwardedBundleTargetSnapshot;
  contentSnapshot: string;
  attachmentSnapshots?: ForwardedBundleAttachmentSnapshot[];
  attachmentPolicy?: "excluded" | string;
  provenanceState?: "available" | "original_unavailable" | string;
}

export interface ForwardedBundleMetadata {
  kind: "forwarded-bundle";
  version?: number;
  forwardedItems?: ForwardedBundleItem[];
}

export function isForwardedBundleMetadata(value: unknown): value is ForwardedBundleMetadata {
  return !!value
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "forwarded-bundle";
}


function isForwardedImagePreview(attachment: ForwardedBundleAttachmentSnapshot) {
  const mimeType = attachment.mimeType?.split(";")[0]?.trim().toLowerCase();
  // The gallery loads the raw file: SVG is active content and HEIC does not
  // decode outside Safari, so both stay file chips.
  if (mimeType === "image/svg+xml" || isHeicImageMimeType(mimeType)) return false;
  if (mimeType?.startsWith("image/")) return true;
  return /\.(?:avif|gif|jpe?g|png|webp)$/i.test(attachment.filename);
}

function authorLabel(item: ForwardedBundleItem, unknownLabel: string) {
  const author = item.sourceAuthorSnapshot;
  if (!author) return unknownLabel;
  return author.uniqueName ? `@${author.uniqueName}` : author.name || unknownLabel;
}

function forwardedTimestamp(item: ForwardedBundleItem, formatShortDateTime: (value: string) => string) {
  if (!item.sourceCreatedAt) return null;
  return formatShortDateTime(item.sourceCreatedAt) || null;
}

function visibleTimeMs(item: ForwardedBundleItem): number | null {
  if (!item.sourceCreatedAt) return null;
  const parsed = Date.parse(item.sourceCreatedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareForwardedItems(
  a: { item: ForwardedBundleItem; position: number },
  b: { item: ForwardedBundleItem; position: number },
) {
  const aTime = visibleTimeMs(a.item);
  const bTime = visibleTimeMs(b.item);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  if (aTime !== null && bTime === null) return -1;
  if (aTime === null && bTime !== null) return 1;

  const aSeq = a.item.sourceMessageSeq;
  const bSeq = b.item.sourceMessageSeq;
  if (typeof aSeq === "number" && typeof bSeq === "number" && aSeq !== bSeq) return aSeq - bSeq;
  if (typeof a.item.index === "number" && typeof b.item.index === "number" && a.item.index !== b.item.index) {
    return a.item.index - b.item.index;
  }
  if (a.item.sourceMessageId && b.item.sourceMessageId && a.item.sourceMessageId !== b.item.sourceMessageId) {
    return a.item.sourceMessageId.localeCompare(b.item.sourceMessageId);
  }
  return a.position - b.position;
}

export function orderForwardedBundleItemsForDisplay(items: ForwardedBundleItem[]): ForwardedBundleItem[] {
  const positioned = items.map((item, position) => ({ item, position }));
  const isThreadBundle = positioned.some(({ item }) => item.sourceTargetSnapshot?.type === "thread");
  if (!isThreadBundle) return positioned.sort(compareForwardedItems).map(({ item }) => item);

  const hasParentMarker = positioned.some(({ item }) => item.sourceIsThreadParent === true);
  const hasCompleteMarkers = positioned.every(({ item }) => typeof item.sourceIsThreadParent === "boolean");
  if (!hasParentMarker && !hasCompleteMarkers) return items;

  const parent = positioned.find(({ item }) => item.sourceIsThreadParent === true);
  const replies = positioned
    .filter(({ item }) => item.sourceIsThreadParent !== true)
    .sort(compareForwardedItems)
    .map(({ item }) => item);
  return parent ? [parent.item, ...replies] : replies;
}

function sourceLabel(item: ForwardedBundleItem | undefined, formatMessage: IntlShape["formatMessage"]) {
  if (item?.provenanceState !== "available") return null;
  const target = item?.sourceTargetSnapshot;
  if (target?.label && target.type !== "dm" && target.labelVisibility === "public") {
    if (target.type === "thread") {
      return target.label.endsWith(" · thread")
        ? formatMessage({ id: "message.forwardedBundle.fromSource" }, { target: target.label })
        : formatMessage({ id: "message.forwardedBundle.fromThread" }, { target: target.label });
    }
    // A task discussion: `from #android:#7 · <task title>`; without the title (older bundles), as today.
    const taskTitle = target.type === "task" ? item?.sourceTaskTitle?.trim() : undefined;
    if (taskTitle) return formatMessage({ id: "message.forwardedBundle.fromTask" }, { target: target.label, title: taskTitle });
    return formatMessage({ id: "message.forwardedBundle.fromSource" }, { target: target.label });
  }
  return null;
}

function canOpenSourceLabel(item: ForwardedBundleItem | undefined) {
  if (!item || item.provenanceState === "original_unavailable") return false;
  if (!item.sourceMessageId) return false;
  const target = item.sourceTargetSnapshot;
  if (!target || target.type === "dm" || target.labelVisibility !== "public") return false;
  if (target.type === "thread") return !!item.sourceThreadId && !!item.parentChannelId;
  return !!item.sourceTargetId;
}

function ForwardedBundleContent({ item }: { item: ForwardedBundleItem }) {
  const content = item.contentSnapshot || "";
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);

  return (
    <MessageForwardedBundleItemContent
      data-testid="forwarded-bundle-content"
      className={getMessageBodyFontSizeClass(messageBodyFontSize)}
      style={getMessageBodyFontSizeStyle(messageBodyFontSize)}
    >
      <MarkdownContent source={content} density="compact" enableMermaid />
    </MessageForwardedBundleItemContent>
  );
}

function ForwardedBundleImageGallery({
  attachments,
  onOpen,
}: {
  attachments: ForwardedBundleAttachmentSnapshot[];
  onOpen?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const [resolvedUrls, setResolvedUrls] = useState<Map<string, string | null>>(new Map());
  const attachmentIdKey = attachments.map((a) => a.id ?? "").join(",");
  // Resolve every image in ONE request: fetching per tile scaled with images
  // rather than messages and tripped the download limiter.
  useEffect(() => {
    let cancelled = false;
    const ids = attachmentIdKey.split(",").filter(Boolean);
    if (ids.length === 0) return;
    void fetchInlineAttachmentUrls(ids).then((urls) => {
      if (cancelled) return;
      setResolvedUrls(new Map(ids.map((id) => [id, urls.get(id) ?? null])));
    });
    return () => { cancelled = true; };
  }, [attachmentIdKey]);

  return (
    <MessageForwardedBundleGallery data-testid="forwarded-bundle-image-gallery">
      {attachments.map((attachment) => (
        <ForwardedBundleImageTile
          key={`${attachment.id}-${attachment.filename}`}
          attachment={attachment}
          resolvedSrc={resolvedUrls.get(attachment.id ?? "")}
          onOpen={onOpen}
        />
      ))}
    </MessageForwardedBundleGallery>
  );
}

function ForwardedBundleImageTile({
  attachment,
  resolvedSrc,
  onOpen,
}: {
  attachment: ForwardedBundleAttachmentSnapshot;
  /** undefined = still resolving, null = failed, string = ready */
  resolvedSrc?: string | null;
  onOpen?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const { formatMessage } = useIntl();
  const canOpen = !!onOpen && !!attachment.id;
  const handleOpen = useCallback(() => {
    onOpen?.(attachment);
  }, [onOpen, attachment]);
  // A source that failed to load shows the placeholder icon, not a broken image.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const handleImageError = useCallback(() => setFailedSrc(resolvedSrc ?? null), [resolvedSrc]);
  return (
    <MessageForwardedBundleGalleryTile data-testid="forwarded-bundle-image">
      {resolvedSrc && resolvedSrc !== failedSrc ? (
        <img src={resolvedSrc} alt={attachment.filename} loading="lazy" onError={handleImageError} />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-fill-muted text-foreground-hint">
          <ImageIcon aria-hidden size={18} />
        </div>
      )}
      {canOpen ? (
        <MessageImageGalleryPreview
          onClick={handleOpen}
          data-testid="forwarded-bundle-attachment"
          aria-label={formatMessage({ id: "message.forwardedBundle.openAttachment" }, { filename: attachment.filename })}
        />
      ) : null}
    </MessageForwardedBundleGalleryTile>
  );
}

function ForwardedBundleAttachmentChip({
  attachment,
  onOpen,
}: {
  attachment: ForwardedBundleAttachmentSnapshot;
  onOpen?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const { formatMessage } = useIntl();
  // Render the SAME chip the chat body uses. The forward card previously drew
  // its own compact chip, which is why every attachment behaviour (preview vs
  // download, cursor, tooltip, styling) had to be re-implemented here and kept
  // drifting. One component means one behaviour by construction.
  const asMessageAttachment = useMemo<MessageAttachment>(() => ({
    id: attachment.id ?? "",
    filename: attachment.filename,
    mimeType: attachment.mimeType || "application/octet-stream",
    sizeBytes: attachment.sizeBytes ?? 0,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
    localPreviewUrl: null,
  }), [attachment]);
  const handleOpen = useCallback(() => onOpen?.(attachment), [attachment, onOpen]);
  const previewable = isDocumentPreviewAttachment(asMessageAttachment);
  return (
    <span data-testid={onOpen && attachment.id ? "forwarded-bundle-attachment" : undefined} className="inline-flex max-w-full">
      <AttachmentChip
        attachment={asMessageAttachment}
        ariaLabel={formatMessage({ id: "message.forwardedBundle.openAttachment" }, { filename: attachment.filename })}
      isOptimistic={false}
      onClick={onOpen && attachment.id ? handleOpen : undefined}
      affordance={previewable ? "preview" : "download"}
      affordanceName={previewable ? "document-preview" : "file-download"}
        meta={(
          <span className="min-w-0 truncate">
            {attachment.mimeType || formatMessage({ id: "message.messageItem.metaFile" })}
          </span>
        )}
      />
    </span>
  );
}

const EMPTY_ATTACHMENT_SNAPSHOTS: ForwardedBundleAttachmentSnapshot[] = [];

function ForwardedBundleAttachments({
  item,
  onOpenAttachment,
}: {
  item: ForwardedBundleItem;
  onOpenAttachment?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const attachments = Array.isArray(item.attachmentSnapshots) ? item.attachmentSnapshots : EMPTY_ATTACHMENT_SNAPSHOTS;
  const projected = item.attachmentPolicy === "projected";
  const imageAttachments = useMemo(
    () => (projected
      ? attachments.filter((attachment) => attachment.id && isForwardedImagePreview(attachment))
      : EMPTY_ATTACHMENT_SNAPSHOTS),
    [attachments, projected],
  );
  if (attachments.length === 0) return null;
  const fileAttachments = imageAttachments.length > 0
    ? attachments.filter((attachment) => !imageAttachments.includes(attachment))
    : attachments;

  return (
    <div className="mt-1.5 stack-y-1.5">
      {imageAttachments.length > 0 ? (
        <ForwardedBundleImageGallery attachments={imageAttachments} onOpen={onOpenAttachment} />
      ) : null}
      {fileAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="forwarded-bundle-file-chips">
          {fileAttachments.map((attachment, index) => (
            <ForwardedBundleAttachmentChip
              key={`${attachment.filename}-${index}`}
              attachment={attachment}
              onOpen={projected && attachment.id ? onOpenAttachment : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ForwardedBundleCard({
  metadata,
  onOpenSource,
  onOpenAttachment,
  onShowAll,
  forceExpanded = false,
  fullWidth = false,
}: {
  metadata: ForwardedBundleMetadata;
  onOpenSource?: (item: ForwardedBundleItem) => void;
  onOpenAttachment?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
  onShowAll?: () => boolean;
  forceExpanded?: boolean;
  fullWidth?: boolean;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const items = Array.isArray(metadata.forwardedItems)
    ? orderForwardedBundleItemsForDisplay(metadata.forwardedItems)
    : [];
  const firstItem = items[0];
  const handleOpenSource = useCallback(() => {
    if (firstItem) onOpenSource?.(firstItem);
  }, [onOpenSource, firstItem]);
  const handleFooterAction = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    // Mobile hands the click to the detail view and stops the toggle
    // (preventDefault); desktop falls through and the component expands in
    // place. Without onShowAll the handler is a no-op and the component
    // toggles.
    if (onShowAll?.()) event.preventDefault();
  }, [onShowAll]);
  if (items.length === 0) return null;
  const label = sourceLabel(firstItem, formatMessage);
  const sourceClickable = !!label && !!onOpenSource && canOpenSourceLabel(firstItem);

  return (
    <MessageForwardedBundle
      fullWidth={fullWidth}
      data-testid="forwarded-bundle-card"
    >
      <MessageForwardedBundleHeader>
        <MessageForwardedBundleHeaderContent>
          <MessageForwardedBundleHeaderLabel>
            <Forward size={12} aria-hidden />
            {formatMessage({ id: "message.forward.badge" })}
          </MessageForwardedBundleHeaderLabel>
          <MessageForwardedBundleHeaderCount>
            {formatMessage({ id: "message.forward.bundleCount" }, { count: items.length })}
          </MessageForwardedBundleHeaderCount>
        </MessageForwardedBundleHeaderContent>
        {sourceClickable ? (
          <AttachmentTooltip content={formatMessage({ id: "message.forward.openSource" })}>
            <MessageForwardedBundleSource
              render={<button type="button" />}
              onClick={handleOpenSource}
              data-testid="forwarded-bundle-source-label"
              aria-label={formatMessage({ id: "message.forward.openSource" })}
            >
              {label}
            </MessageForwardedBundleSource>
          </AttachmentTooltip>
        ) : label ? (
          <MessageForwardedBundleSourceLabel data-testid="forwarded-bundle-source-label">
            {label}
          </MessageForwardedBundleSourceLabel>
        ) : null}
      </MessageForwardedBundleHeader>
      <MessageForwardedBundleItems collapsed={forceExpanded ? false : undefined}>
        {items.map((item, fallbackIndex) => {
          const timestamp = forwardedTimestamp(item, formatShortDateTime);
          const itemKey = item.sourceMessageId || fallbackIndex;
          return (
            <MessageForwardedBundleItem key={itemKey} data-testid="forwarded-bundle-item">
              <MessageForwardedBundleItemMeta>
                <MessageForwardedBundleItemAuthor>
                  {authorLabel(item, formatMessage({ id: "message.forwardedBundle.unknownAuthor" }))}
                </MessageForwardedBundleItemAuthor>
                {timestamp && (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={item.sourceCreatedAt}>{timestamp}</time>
                  </>
                )}
              </MessageForwardedBundleItemMeta>
              <ForwardedBundleContent item={item} />
              <ForwardedBundleAttachments item={item} onOpenAttachment={onOpenAttachment} />
            </MessageForwardedBundleItem>
          );
        })}
      </MessageForwardedBundleItems>
      {forceExpanded ? null : (
        <MessageForwardedBundleFooter>
          <MessageForwardedBundleFooterAction
            render={<button type="button" />}
            data-testid="forwarded-bundle-toggle"
            onClick={handleFooterAction}
            expandedContent={(
              <>
                <ChevronUp size={12} aria-hidden />
                {formatMessage({ id: "message.forwardedBundle.collapse" })}
              </>
            )}
          >
            <ChevronRight size={12} aria-hidden />
            {formatMessage({ id: "message.forwardedBundle.viewAll" }, { count: items.length })}
          </MessageForwardedBundleFooterAction>
        </MessageForwardedBundleFooter>
      )}
    </MessageForwardedBundle>
  );
}
