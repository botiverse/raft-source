import { useCallback, useMemo } from "react";
import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import {
  AudioAttachmentPreviewModal,
  HtmlAttachmentPreviewModal,
  VideoAttachmentPreviewModal,
} from "./attachmentPreviewChunk";
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
  // Hooks stay above the !entry early return; entry identity is stable from
  // the store selector, so these memoize on it directly.
  const comments = useMemo(
    () => (entry?.commentContext ? {
      attachmentId: entry.attachment.id,
      filename: entry.attachment.filename,
      commentCount: entry.attachment.commentCount ?? 0,
      parentMessage: entry.commentContext.parentMessage,
    } : undefined),
    [entry],
  );
  const onDownload = useCallback(() => {
    if (entry) void downloadAttachmentById(entry.attachment);
  }, [entry]);

  if (!entry) return null;

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
