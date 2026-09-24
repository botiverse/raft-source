import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import {
  AudioAttachmentPreviewModal,
  HtmlAttachmentPreviewModal,
  VideoAttachmentPreviewModal,
} from "./attachmentPreviewSurfaces";
import { downloadAttachmentById } from "./downloadAttachment";

/**
 * App-level host for html / video / audio previews, mounted beside the image
 * lightbox and the document preview. Any surface opens them via
 * `openMediaPreview`; comments appear only when the opener supplied a host
 * message, so a forward snapshot explicitly has none.
 */
export default function MediaPreviewHost() {
  const entry = useMediaPreviewStore((s) => s.entry);
  const close = useMediaPreviewStore((s) => s.close);
  if (!entry) return null;

  const comments = entry.commentContext ? {
    attachmentId: entry.attachment.id,
    filename: entry.attachment.filename,
    commentCount: entry.attachment.commentCount ?? 0,
    parentMessage: entry.commentContext.parentMessage,
  } : undefined;
  const onDownload = () => void downloadAttachmentById(entry.attachment);

  if (entry.kind === "html") {
    return (
      <HtmlAttachmentPreviewModal
        filename={entry.attachment.filename}
        url={entry.url}
        onClose={close}
        onDownload={onDownload}
        comments={comments}
      />
    );
  }
  if (entry.kind === "video") {
    return (
      <VideoAttachmentPreviewModal
        filename={entry.attachment.filename}
        url={entry.url}
        onClose={close}
        onDownload={onDownload}
        comments={comments}
      />
    );
  }
  return (
    <AudioAttachmentPreviewModal
      filename={entry.attachment.filename}
      url={entry.url}
      onClose={close}
      onDownload={onDownload}
    />
  );
}
