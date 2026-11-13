import { useCallback, useEffect, useMemo } from "react";
import { useIntl } from "react-intl";
import { showToast } from "../toastBridge";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DocumentAttachmentPreviewModal } from "./attachmentPreviewChunk";
import { downloadAttachmentById } from "./downloadAttachment";
import type { DocumentPreviewUnavailableReason } from "../../store/documentPreviewStore";

const UNAVAILABLE_NOTICE_TITLE_ID = {
  too_large: "message.messageItem.previewUnavailableTooLarge",
  unavailable: "message.messageItem.previewUnavailableTemporarily",
  unsupported: "message.messageItem.previewUnavailable",
} as const satisfies Record<DocumentPreviewUnavailableReason, string>;

/**
 * Single app-level host for the document preview, mounted beside
 * <ImageLightbox />. Surfaces open it through `openDocumentPreview`; none of
 * them own the modal, so none of them can drift from it.
 *
 * Comments render only when the opener supplied a host message. A forward
 * preview shows a snapshot with no host, so it deliberately supplies none —
 * an explicit absence rather than an accident of which surface opened it.
 */
export default function DocumentPreviewHost() {
  const { formatMessage } = useIntl();
  const entry = useDocumentPreviewStore((s) => s.entry);
  const close = useDocumentPreviewStore((s) => s.close);
  const unavailableNotice = useDocumentPreviewStore((s) => s.unavailableNotice);
  const clearUnavailableNotice = useDocumentPreviewStore((s) => s.clearUnavailableNotice);
  // A preview that cannot open says so before its download starts (task
  // #164); the opener records the notice, this host owns the localized copy.
  useEffect(() => {
    if (!unavailableNotice) return;
    showToast({
      title: formatMessage({ id: UNAVAILABLE_NOTICE_TITLE_ID[unavailableNotice.reason] }, { filename: unavailableNotice.filename }),
      description: formatMessage({ id: "message.messageItem.previewUnavailableDownloading" }),
      type: "warning",
    });
    clearUnavailableNotice();
  }, [unavailableNotice, clearUnavailableNotice, formatMessage]);
  // Hooks stay above the !entry early return; entry identity is stable from
  // the store selector, so these memoize on it directly.
  const onDownload = useCallback(() => {
    if (entry) void downloadAttachmentById(entry.attachment);
  }, [entry]);
  // A failed copy is reported rather than swallowed; the toast bridge keeps
  // this host renderable without a provider (its tests do exactly that).
  const onCopyError = useCallback(() => {
    showToast({ title: formatMessage({ id: "common.lightbox.copyFailed" }), type: "error" });
  }, [formatMessage]);
  const comments = useMemo(
    () => (entry?.commentContext ? {
      attachmentId: entry.attachment.id,
      filename: entry.attachment.filename,
      commentCount: entry.attachment.commentCount ?? 0,
      parentMessage: entry.commentContext.parentMessage,
    } : undefined),
    [entry],
  );
  if (!entry) return null;
  return (
    <DocumentAttachmentPreviewModal
      filename={entry.attachment.filename}
      preview={entry.preview}
      truncated={entry.truncated}
      url={entry.url}
      onClose={close}
      onDownload={onDownload}
      onCopyError={onCopyError}
      comments={comments}
    />
  );
}
