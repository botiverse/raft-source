import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronUp, FileText, Image as ImageIcon } from "lucide-react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import MarkdownContent from "../markdown/MarkdownContent";
import ShowMoreToggle from "../ui/ShowMoreToggle";
import AttachmentTooltip from "./attachmentTooltip";
import { fetchInlineAttachmentUrls } from "./inlineAttachmentUrlCache";
import { AttachmentChip } from "./AttachmentChip";
import { isDocumentPreviewAttachment } from "./attachmentPreview";
import type { MessageAttachment } from "../../store/messageStore";

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
  if (mimeType === "image/svg+xml") return false;
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

function isLongForwardedContent(content: string) {
  return content.length > 420 || content.split(/\r?\n/).length > 8;
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

function needsWholeCardExpansion(items: ForwardedBundleItem[]) {
  return items.length > 3 || items.some((item) => isLongForwardedContent(item.contentSnapshot || ""));
}

function ForwardedBundleContent({ item }: { item: ForwardedBundleItem }) {
  const content = item.contentSnapshot || "";

  return (
    <div
      className="min-w-0 max-w-full break-words text-sm text-black"
      data-testid="forwarded-bundle-content"
    >
      <MarkdownContent source={content} density="compact" enableMermaid />
    </div>
  );
}

type ForwardedImagePreviewState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "error" };

function ForwardedBundleImageTile({
  attachment,
  onOpen,
  resolvedSrc,
}: {
  attachment: ForwardedBundleAttachmentSnapshot;
  onOpen?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
  /** undefined = still resolving, null = failed, string = ready */
  resolvedSrc?: string | null;
}) {
  const { formatMessage } = useIntl();
  // The strip resolves every URL in ONE request and passes it down. Fetching
  // per tile scaled with images rather than messages and tripped the download
  // limiter, which is what made forwarded images render as broken files.
  const [imgFailed, setImgFailed] = useState(false);
  const preview: ForwardedImagePreviewState = imgFailed
    ? { status: "error" }
    : resolvedSrc === undefined
    ? { status: "loading" }
    : resolvedSrc
      ? { status: "ready", src: resolvedSrc }
      : { status: "error" };

  return (
    <AttachmentTooltip content={attachment.filename}>
      <div
        className={`group/img relative aspect-square w-full min-w-0 overflow-hidden border-2 border-black bg-brutal-cream/60 text-left ${onOpen ? "hover:brightness-95" : ""}`}
        data-testid="forwarded-bundle-image"
      >
      {preview.status === "ready" ? (
        <img
          src={preview.src}
          alt=""
          width={attachment.width ?? undefined}
          height={attachment.height ?? undefined}
          loading="lazy"
          className="block h-full w-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-brutal-cream/60 px-1 text-center text-black/45">
          {preview.status === "loading" ? <ImageIcon aria-hidden size={18} /> : <FileText aria-hidden size={18} />}
          <span className="line-clamp-2 text-[10px] font-bold leading-tight">{attachment.filename}</span>
        </div>
      )}
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(attachment)}
            className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-black"
            data-testid="forwarded-bundle-attachment"
            aria-label={formatMessage({ id: "message.forwardedBundle.openAttachment" }, { filename: attachment.filename })}
          />
        ) : null}
      </div>
    </AttachmentTooltip>
  );
}

function ForwardedBundleImageStrip({
  attachments,
  onOpen,
}: {
  attachments: ForwardedBundleAttachmentSnapshot[];
  onOpen?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const { formatMessage } = useIntl();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: attachments.length > 3 });
  // Resolve every tile's URL in ONE request. Per-tile fetching scaled with
  // images rather than messages and tripped the download limiter, which is what
  // made forwarded images render as broken files.
  const [resolvedUrls, setResolvedUrls] = useState<Map<string, string | null>>(new Map());
  const attachmentIdKey = attachments.map((a) => a.id ?? "").join(",");
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

  // Wheel-to-horizontal must be a NON-passive listener: React's onWheel is
  // passive, so preventDefault() there is ignored and the page scrolls along
  // with the strip. Bind it manually and only claim the gesture while the strip
  // can still move, handing it back at either edge.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const atStart = el.scrollLeft <= 0;
      const atEnd = el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
      if ((delta < 0 && atStart) || (delta > 0 && atEnd)) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    // Deliberately non-passive: the handler calls preventDefault() so a wheel over
    // the strip does not also scroll the page, and it only does so while the strip
    // itself can still scroll. A passive listener would silently drop that.
    // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- see above
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const next = {
      left: scroller.scrollLeft > 2,
      right: scroller.scrollLeft < maxScrollLeft - 2,
    };
    setOverflow((current) => current.left === next.left && current.right === next.right ? current : next);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    updateOverflow();
    scroller.addEventListener("scroll", updateOverflow, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateOverflow);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", updateOverflow);
      observer?.disconnect();
    };
  }, [attachments.length, updateOverflow]);

  return (
    <div className="relative" data-testid="forwarded-bundle-image-strip">
      <div
        ref={scrollerRef}
        // A vertical wheel over a horizontal strip does nothing by default, so
        // the images look stuck. Translate wheel delta to horizontal scroll,
        // but only while the strip can actually scroll — otherwise the page
        // would stop scrolling whenever the pointer crossed the images.
        role="region"
        aria-label={formatMessage({ id: "message.forwardedBundle.imagePreviews" })}
        className="scrollbar-none grid grid-flow-col auto-cols-[calc((100%_-_1rem)/3)] snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain scroll-smooth"
        data-testid="forwarded-bundle-image-scroller"
      >
        {attachments.map((attachment, index) => (
          <div className="min-w-0 snap-start" key={`${attachment.id}-${attachment.filename}-${index}`}>
            <ForwardedBundleImageTile attachment={attachment} onOpen={onOpen} resolvedSrc={resolvedUrls.get(attachment.id ?? "")} />
          </div>
        ))}
      </div>
      {overflow.left ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-5 shadow-overflow-cue-left"
          data-testid="forwarded-bundle-image-shadow-left"
        />
      ) : null}
      {overflow.right ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-5 shadow-overflow-cue-right"
          data-testid="forwarded-bundle-image-shadow-right"
        />
      ) : null}
    </div>
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
  const asMessageAttachment: MessageAttachment = {
    id: attachment.id ?? "",
    filename: attachment.filename,
    mimeType: attachment.mimeType || "application/octet-stream",
    sizeBytes: attachment.sizeBytes ?? 0,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
    localPreviewUrl: null,
  };
  const previewable = isDocumentPreviewAttachment(asMessageAttachment);
  return (
    <span data-testid={onOpen && attachment.id ? "forwarded-bundle-attachment" : undefined} className="inline-flex max-w-full">
      <AttachmentChip
        attachment={asMessageAttachment}
        ariaLabel={formatMessage({ id: "message.forwardedBundle.openAttachment" }, { filename: attachment.filename })}
      variant="compact"
      isOptimistic={false}
      onClick={onOpen && attachment.id ? () => onOpen(attachment) : undefined}
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

function ForwardedBundleAttachments({
  item,
  onOpenAttachment,
}: {
  item: ForwardedBundleItem;
  onOpenAttachment?: (attachment: ForwardedBundleAttachmentSnapshot) => void;
}) {
  const attachments = Array.isArray(item.attachmentSnapshots) ? item.attachmentSnapshots : [];
  if (attachments.length === 0) return null;
  const projected = item.attachmentPolicy === "projected";
  const imageAttachments = projected
    ? attachments.filter((attachment) => attachment.id && isForwardedImagePreview(attachment))
    : [];
  const fileAttachments = imageAttachments.length > 0
    ? attachments.filter((attachment) => !imageAttachments.includes(attachment))
    : attachments;

  return (
    <div className="mt-1.5 space-y-1.5">
      {imageAttachments.length > 0 ? (
        <ForwardedBundleImageStrip attachments={imageAttachments} onOpen={onOpenAttachment} />
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
  const canExpand = needsWholeCardExpansion(items);
  const [expanded, setExpanded] = useState(forceExpanded || !canExpand);
  if (items.length === 0) return null;
  const firstItem = items[0];
  const label = sourceLabel(firstItem, formatMessage);
  const sourceClickable = !!label && !!onOpenSource && canOpenSourceLabel(firstItem);

  return (
    <div
      className={`mt-1 border border-black/20 bg-white ${fullWidth ? "w-full max-w-none" : "max-w-[min(34rem,100%)]"}`}
      data-testid="forwarded-bundle-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/10 bg-white px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex shrink-0 text-[11px] font-black leading-none text-black/70">
            {formatMessage({ id: "message.forward.badge" })}
          </span>
          <span className="shrink-0 text-[11px] font-bold text-black/55">
            {formatMessage({ id: "message.forward.bundleCount" }, { count: items.length })}
          </span>
        </div>
        {sourceClickable ? (
          <AttachmentTooltip content={formatMessage({ id: "message.forward.openSource" })}>
            <button
              type="button"
              onClick={() => onOpenSource(firstItem)}
              className="min-w-0 truncate text-[11px] font-bold text-black/50 underline-offset-2 transition-colors hover:text-black hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
              data-testid="forwarded-bundle-source-label"
              aria-label={formatMessage({ id: "message.forward.openSource" })}
            >
              {label}
            </button>
          </AttachmentTooltip>
        ) : label ? (
          <span className="min-w-0 truncate text-[11px] font-bold text-black/45" data-testid="forwarded-bundle-source-label">
            {label}
          </span>
        ) : null}
      </div>
      <div className={`relative ${!expanded ? "max-h-[144px] overflow-clip sm:max-h-[180px]" : ""}`}>
        {items.map((item, fallbackIndex) => {
          const timestamp = forwardedTimestamp(item, formatShortDateTime);
          const itemKey = item.sourceMessageId || fallbackIndex;
          return (
            <article
              key={itemKey}
              className="bg-white px-3 py-2"
              data-testid="forwarded-bundle-item"
            >
              <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-mono text-black/55">
                <span className="font-bold text-black/75">{authorLabel(item, formatMessage({ id: "message.forwardedBundle.unknownAuthor" }))}</span>
                {timestamp && (
                  <>
                    <span aria-hidden>·</span>
                    <time dateTime={item.sourceCreatedAt}>{timestamp}</time>
                  </>
                )}
              </div>
              <ForwardedBundleContent item={item} />
              <ForwardedBundleAttachments item={item} onOpenAttachment={onOpenAttachment} />
            </article>
          );
        })}
        {!expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white via-white/80 to-white/0"
            data-testid="forwarded-bundle-fade"
          />
        )}
      </div>
      {canExpand && !forceExpanded && (
        <div className="border-t border-black/10 bg-white px-3 py-1.5">
          <ShowMoreToggle
            onClick={() => {
              if (!expanded && onShowAll?.()) return;
              setExpanded((current) => !current);
            }}
            expanded={expanded}
            collapsedLabel={(
              <span className="inline-flex items-center gap-1">
                {formatMessage({ id: "message.forwardedBundle.viewAll" }, { count: items.length })}
                <ChevronRight size={14} aria-hidden />
              </span>
            )}
            expandedLabel={(
              <span className="inline-flex items-center gap-1">
                {formatMessage({ id: "message.forwardedBundle.collapse" })}
                <ChevronUp size={14} aria-hidden />
              </span>
            )}
            data-testid="forwarded-bundle-toggle"
          />
        </div>
      )}
    </div>
  );
}
