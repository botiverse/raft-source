import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Download } from "lucide-react";
import { MARKDOWN_PREVIEW_BYTE_LIMIT, previewPrefixAtLineBoundary, TEXT_PREVIEW_BYTE_LIMIT } from "@botiverse/raft-shared";
import {
  buildMessageImageGalleryRows,
  MessageAttachmentGroup,
  MessageImageGallery,
  MessageImageGalleryAction,
  MessageImageGalleryItem,
  MessageImageGalleryPreview,
  MessageImageGalleryRow,
} from "@botiverse/raft-ui";
import type { MessageAttachment } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import Tooltip from "../ui/Tooltip";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentMetaText } from "./AttachmentMetaText";
import {
  isCsvAttachment,
  isHtmlPreviewAttachment,
  isMarkdownAttachment,
  isPdfAttachment,
  isTextAttachment,
} from "./attachmentPreview";
import type { DocumentAttachmentPreview } from "./attachmentPreview";
import { DocumentAttachmentPreviewModal } from "./attachmentPreviewChunk";
import { showToast } from "../toastBridge";

/**
 * Where a read-only (public) projection's attachment bytes live. The host page
 * supplies plain URLs it is allowed to hand to `<img>`, links, `fetch` and the
 * PDF frame; nothing here calls the member attachment API
 * (`/attachments/:id/url`, previews, comments), which needs a session and
 * server membership. Previews reuse the member preview surfaces, fed from these
 * URLs instead.
 */
export interface ReadOnlyAttachmentUrls {
  inline: (attachmentId: string) => string;
  download: (attachmentId: string) => string;
  /** A PDF served inline for the preview frame. */
  pdfPreview: (attachmentId: string) => string;
}

export const ReadOnlyAttachmentUrlContext = createContext<ReadOnlyAttachmentUrls | null>(null);

// Raster types a browser renders in <img>; mirrors the server's inline
// allowlist for the public attachment route. Everything else is a file chip.
const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function normalizedMimeType(attachment: Pick<MessageAttachment, "mimeType">): string {
  return attachment.mimeType.split(";")[0]!.trim().toLowerCase();
}

function isInlineImage(attachment: MessageAttachment): boolean {
  return INLINE_IMAGE_MIME_TYPES.has(normalizedMimeType(attachment));
}

type ReadOnlyPreviewKind = "markdown" | "text" | "pdf";

/**
 * Which read-only preview a file chip opens, or null for download-only.
 * Active content (HTML, SVG) is never previewed, even when its MIME claims to
 * be text. Text uses the member preview cap; a larger text file is a download
 * rather than a silently truncated preview. Markdown of any size previews: like
 * the member preview (task #164), a file over the cap shows its first
 * MARKDOWN_PREVIEW_BYTE_LIMIT bytes, cut at a whole line, under a notice.
 */
export function readOnlyPreviewKind(attachment: Pick<MessageAttachment, "filename" | "mimeType" | "sizeBytes">): ReadOnlyPreviewKind | null {
  const filename = attachment.filename.toLowerCase();
  const mimeType = normalizedMimeType(attachment);
  if (isHtmlPreviewAttachment(attachment) || filename.endsWith(".xhtml") || mimeType.includes("html")) return null;
  if (filename.endsWith(".svg") || filename.endsWith(".svgz") || mimeType === "image/svg+xml") return null;
  if (isPdfAttachment(attachment)) return "pdf";
  if (isMarkdownAttachment(attachment)) return "markdown";
  if (isTextAttachment(attachment) || isCsvAttachment(attachment)) return attachment.sizeBytes <= TEXT_PREVIEW_BYTE_LIMIT ? "text" : null;
  return null;
}

/** Fetches a public attachment as UTF-8 text, refusing anything not valid
 *  UTF-8 (null). Over `maxBytes` it refuses too ("too_large"), unless `truncate` is
 *  set: then it stops reading and keeps the whole lines within `maxBytes`.
 *  Anonymous: no cookies or credentials are sent. */
async function fetchReadOnlyText(
  url: string,
  maxBytes: number,
  { truncate = false }: { truncate?: boolean } = {},
): Promise<{ text: string; truncated: boolean; byteLength: number } | "too_large" | null> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) return null;
  const declaredLength = Number(response.headers.get("content-length"));
  if (!truncate && Number.isFinite(declaredLength) && declaredLength > maxBytes) return "too_large";
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        void reader.cancel();
        if (!truncate) return "too_large";
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      if (!truncate) return "too_large";
      truncated = true;
    }
    total = Math.min(buffer.byteLength, maxBytes);
    chunks.push(buffer.subarray(0, total));
  }
  let bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (truncated) bytes = previewPrefixAtLineBoundary(bytes);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), truncated, byteLength: bytes.byteLength };
  } catch {
    return null;
  }
}

function startDownload(url: string, filename: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

interface ReadOnlyPreviewEntry {
  attachment: MessageAttachment;
  preview: DocumentAttachmentPreview;
  truncated: boolean;
  url: string | null;
}

function ReadOnlyFileChip({
  attachment,
  urls,
  onOpenPreview,
}: {
  attachment: MessageAttachment;
  urls: ReadOnlyAttachmentUrls;
  onOpenPreview: (entry: ReadOnlyPreviewEntry) => void;
}) {
  const { formatMessage } = useIntl();
  const [loading, setLoading] = useState(false);
  const previewKind = readOnlyPreviewKind(attachment);
  const download = useCallback(() => startDownload(urls.download(attachment.id), attachment.filename), [attachment.filename, attachment.id, urls]);
  // A chip that promised a preview never downloads silently (task #164):
  // say why first, as the member opener does.
  const explainAndDownload = useCallback((reason: "too_large" | "unsupported") => {
    showToast({
      title: formatMessage(
        { id: reason === "too_large" ? "message.messageItem.previewUnavailableTooLarge" : "message.messageItem.previewUnavailable" },
        { filename: attachment.filename },
      ),
      description: formatMessage({ id: "message.messageItem.previewUnavailableDownloading" }),
      type: "warning",
    });
    download();
  }, [attachment.filename, download, formatMessage]);
  // Same shape as the member opener: the chip shows "Opening preview…" while
  // the bytes load, and anything that turns out not to be previewable falls
  // back to the download it would have been before.
  const handleClick = useCallback(async () => {
    if (previewKind === null) {
      download();
      return;
    }
    if (previewKind === "pdf") {
      onOpenPreview({ attachment, preview: { kind: "pdf" }, truncated: false, url: urls.pdfPreview(attachment.id) });
      return;
    }
    setLoading(true);
    try {
      const read = previewKind === "markdown"
        ? await fetchReadOnlyText(urls.inline(attachment.id), MARKDOWN_PREVIEW_BYTE_LIMIT, { truncate: true })
        : await fetchReadOnlyText(urls.inline(attachment.id), TEXT_PREVIEW_BYTE_LIMIT);
      if (read === null || read === "too_large" || read.text.trim().length === 0) {
        explainAndDownload(read === "too_large" ? "too_large" : "unsupported");
        return;
      }
      const { text, truncated, byteLength } = read;
      onOpenPreview({
        attachment,
        preview: previewKind === "markdown"
          ? {
            kind: "markdown",
            markdown: text.trim(),
            ...(truncated ? { previewByteLength: byteLength, sourceByteLength: Math.max(attachment.sizeBytes, byteLength) } : {}),
          }
          : { kind: "text", text },
        truncated,
        url: null,
      });
    } catch {
      explainAndDownload("unsupported");
    } finally {
      setLoading(false);
    }
  }, [attachment, download, explainAndDownload, onOpenPreview, previewKind, urls]);
  const onClick = useCallback(() => void handleClick(), [handleClick]);
  return (
    <AttachmentChip
      attachment={attachment}
      isOptimistic={false}
      loading={loading}
      onClick={onClick}
      affordance={previewKind === null ? "download" : "preview"}
      affordanceName={previewKind === null ? "file-download" : "file-preview"}
      meta={<AttachmentMetaText label={attachment.mimeType || formatMessage({ id: "message.messageItem.metaFile" })} sizeBytes={attachment.sizeBytes} />}
    />
  );
}

function ReadOnlyImagePreviewButton({ index, filename, onOpen }: { index: number; filename: string; onOpen: (index: number) => void }) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onOpen(index), [index, onOpen]);
  return (
    <MessageImageGalleryPreview
      onClick={handleClick}
      aria-label={formatMessage({ id: "message.messageItem.previewFile" }, { filename })}
    />
  );
}

/** Attachments of a read-only message: inline images, previewable documents
 *  and downloadable files.
 *  Renders nothing without a URL source, so a host that has not opted in can
 *  never fall back to member endpoints. */
export default function ReadOnlyMessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const urls = useContext(ReadOnlyAttachmentUrlContext);
  const { formatMessage } = useIntl();
  const images = useMemo(() => attachments.filter(isInlineImage), [attachments]);
  const files = useMemo(() => attachments.filter((attachment) => !isInlineImage(attachment)), [attachments]);
  const imageRows = useMemo(() => buildMessageImageGalleryRows(images), [images]);
  const [previewEntry, setPreviewEntry] = useState<ReadOnlyPreviewEntry | null>(null);
  const closePreview = useCallback(() => setPreviewEntry(null), []);
  const downloadPreview = useCallback(() => {
    if (previewEntry && urls) startDownload(urls.download(previewEntry.attachment.id), previewEntry.attachment.filename);
  }, [previewEntry, urls]);
  const onCopyError = useCallback(() => {
    showToast({ title: formatMessage({ id: "common.lightbox.copyFailed" }), type: "error" });
  }, [formatMessage]);
  // The shared lightbox renders a `directUrl` as-is and never resolves it
  // through the member attachment API; no comment context is supplied.
  const openImage = useCallback((index: number) => {
    if (!urls) return;
    useImageLightboxStore.getState().open(
      images.map((attachment) => ({ ...attachment, directUrl: urls.inline(attachment.id), directDownloadUrl: urls.download(attachment.id) })),
      index,
    );
  }, [images, urls]);
  if (!urls) return null;

  return (
    <div className="mt-1 stack-y-2" data-testid="read-only-message-attachments">
      {imageRows.length > 0 ? (
        <MessageImageGallery className="group-data-[followed-by]/message:mb-px">
          {imageRows.map((row) => (
            <MessageImageGalleryRow key={row.items.map((item) => images[item.index]!.id).join("-")} row={row}>
              {row.items.map((item) => {
                const attachment = images[item.index]!;
                return (
                  <Tooltip key={attachment.id} content={attachment.filename}>
                    <MessageImageGalleryItem layout={item}>
                      <img
                        src={urls.inline(attachment.id)}
                        alt={attachment.filename}
                        width={attachment.width ?? undefined}
                        height={attachment.height ?? undefined}
                        loading="lazy"
                      />
                      <ReadOnlyImagePreviewButton index={item.index} filename={attachment.filename} onOpen={openImage} />
                      <MessageImageGalleryAction
                        render={(
                          <a
                            href={urls.download(attachment.id)}
                            download={attachment.filename}
                            rel="noopener"
                            aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
                          />
                        )}
                        data-message-affordance="image-download"
                      >
                        <Download size={12} />
                      </MessageImageGalleryAction>
                    </MessageImageGalleryItem>
                  </Tooltip>
                );
              })}
            </MessageImageGalleryRow>
          ))}
        </MessageImageGallery>
      ) : null}
      {files.length > 0 ? (
        <MessageAttachmentGroup className="max-w-[22.5rem] group-data-[followed-by]/message:mb-px">
          {files.map((attachment) => (
            <ReadOnlyFileChip key={attachment.id} attachment={attachment} urls={urls} onOpenPreview={setPreviewEntry} />
          ))}
        </MessageAttachmentGroup>
      ) : null}
      {previewEntry ? (
        // The member document preview, minus everything that needs a session:
        // no comments, and Download goes to the public route.
        <DocumentAttachmentPreviewModal
          filename={previewEntry.attachment.filename}
          preview={previewEntry.preview}
          truncated={previewEntry.truncated}
          url={previewEntry.url}
          onClose={closePreview}
          onDownload={downloadPreview}
          onCopyError={onCopyError}
        />
      ) : null}
    </div>
  );
}
