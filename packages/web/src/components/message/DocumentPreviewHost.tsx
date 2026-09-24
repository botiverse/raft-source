import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DocumentAttachmentPreviewModal } from "./attachmentPreviewSurfaces";
import { downloadAttachmentById } from "./downloadAttachment";

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
  const entry = useDocumentPreviewStore((s) => s.entry);
  const close = useDocumentPreviewStore((s) => s.close);
  if (!entry) return null;
  return (
    <DocumentAttachmentPreviewModal
      filename={entry.attachment.filename}
      preview={entry.preview}
      truncated={entry.truncated}
      url={entry.url}
      onClose={close}
      onDownload={() => void downloadAttachmentById(entry.attachment)}
      comments={entry.commentContext ? {
        attachmentId: entry.attachment.id,
        filename: entry.attachment.filename,
        commentCount: entry.attachment.commentCount ?? 0,
        parentMessage: entry.commentContext.parentMessage,
      } : undefined}
    />
  );
}
