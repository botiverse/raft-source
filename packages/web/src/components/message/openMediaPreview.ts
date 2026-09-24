import api from "../../api/client";
import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import type { MediaPreviewCommentContext, MediaPreviewKind } from "../../store/mediaPreviewStore";
import type { MessageAttachment } from "../../store/messageStore";
import { isAttachmentPreviewUnifiedEnabled } from "../../store/attachmentPreviewGate";

/**
 * Shared opener for html / video / audio previews — the same contract as
 * `openDocumentPreview`: any surface can open them, and `commentContext` is
 * optional so a snapshot-only surface (forward preview) explicitly has none.
 */
const ENDPOINT: Record<MediaPreviewKind, (id: string) => string> = {
  html: (id) => `/attachments/${id}/html-preview-url`,
  video: (id) => `/attachments/${id}/url?disposition=inline`,
  audio: (id) => `/attachments/${id}/url?disposition=inline`,
};

export async function openMediaPreview(
  kind: MediaPreviewKind,
  attachment: MessageAttachment,
  options?: { commentContext?: MediaPreviewCommentContext; onFallbackDownload?: (a: MessageAttachment) => void | Promise<void> },
): Promise<void> {
  if (!isAttachmentPreviewUnifiedEnabled()) {
    await options?.onFallbackDownload?.(attachment);
    return;
  }
  const store = useMediaPreviewStore.getState();
  store.setLoadingId(attachment.id);
  try {
    const { data } = await api.get<{ url: string }>(ENDPOINT[kind](attachment.id));
    useMediaPreviewStore.getState().open({ kind, attachment, url: data.url, commentContext: options?.commentContext });
  } catch (err) {
    console.error(`Failed to open ${kind} attachment preview:`, err);
    await options?.onFallbackDownload?.(attachment);
  } finally {
    const current = useMediaPreviewStore.getState();
    if (current.loadingId === attachment.id) current.setLoadingId(null);
  }
}
