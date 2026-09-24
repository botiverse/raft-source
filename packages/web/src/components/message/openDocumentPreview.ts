import api from "../../api/client";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import type { DocumentPreviewCommentContext } from "../../store/documentPreviewStore";
import type { MessageAttachment } from "../../store/messageStore";
import { fetchAttachmentPreviewSummary } from "./attachmentPreviewSummaryCache";
import { isAttachmentPreviewUnifiedEnabled } from "../../store/attachmentPreviewGate";

/**
 * Shared opener for document (text/markdown/csv/xlsx/pdf) attachment previews.
 *
 * Lives outside any component so every surface — message flow, forward
 * composer, file panels — opens the SAME preview instead of reimplementing it.
 * The forward composer previously had no way to reach this and silently fell
 * back to downloading; that asymmetry is what this removes.
 *
 * `commentContext` is optional: callers that have a host message pass it and
 * get the comment surface; callers showing a snapshot (forwards) omit it.
 */
const inFlight = new Map<string, Promise<void>>();

export async function openDocumentPreview(
  attachment: MessageAttachment,
  options?: {
    commentContext?: DocumentPreviewCommentContext;
    /** Fallback when the payload turns out not to be previewable after all. */
    onFallbackDownload?: (attachment: MessageAttachment) => void | Promise<void>;
  },
): Promise<void> {
  if (!isAttachmentPreviewUnifiedEnabled()) {
    await options?.onFallbackDownload?.(attachment);
    return;
  }
  if (inFlight.has(attachment.id)) return;
  const store = useDocumentPreviewStore.getState();
  store.setLoadingId(attachment.id);

  const request = (async () => {
    const previewResponse = await fetchAttachmentPreviewSummary(attachment.id);
    if (!previewResponse || previewResponse.status !== "ok") {
      await options?.onFallbackDownload?.(attachment);
      return;
    }
    const preview = previewResponse.data;
    if (!(preview.kind === "csv" || preview.kind === "xlsx" || preview.kind === "markdown" || preview.kind === "pdf" || preview.kind === "text")) {
      await options?.onFallbackDownload?.(attachment);
      return;
    }
    const url = preview.kind === "pdf"
      ? (await api.get<{ url: string }>(`/attachments/${attachment.id}/url?disposition=inline`)).data.url
      : null;
    useDocumentPreviewStore.getState().open({
      attachment,
      preview,
      truncated: previewResponse.truncated === true,
      url,
      commentContext: options?.commentContext,
    });
  })();

  inFlight.set(attachment.id, request);
  try {
    await request;
  } catch (err) {
    console.error("Failed to open document attachment preview:", err);
    await options?.onFallbackDownload?.(attachment);
  } finally {
    inFlight.delete(attachment.id);
    const current = useDocumentPreviewStore.getState();
    if (current.loadingId === attachment.id) current.setLoadingId(null);
  }
}
