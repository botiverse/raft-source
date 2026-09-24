import api from "../../api/client";
import type { AttachmentPreview } from "./attachmentPreview";

/**
 * Session cache + in-flight dedupe for attachment preview summaries.
 *
 * Same shape of problem as the inline URL cache: every document chip fetched
 * `/attachments/{id}/preview` on mount, so an attachment-dense channel scaled
 * requests with attachments rather than messages and tripped the 120/min
 * download limiter. Summaries are immutable for a given attachment, so they are
 * cacheable for the session.
 *
 * As with the URL cache, the shared request takes NO caller AbortSignal: in a
 * virtualised list the first unmounting chip would otherwise cancel the fetch
 * for every other subscriber.
 */
const cache = new Map<string, AttachmentPreview>();
const inFlight = new Map<string, Promise<AttachmentPreview | null>>();

export async function fetchAttachmentPreviewSummary(attachmentId: string): Promise<AttachmentPreview | null> {
  const cached = cache.get(attachmentId);
  if (cached) return cached;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const request = api
    .get<AttachmentPreview>(`/attachments/${attachmentId}/preview`)
    .then(({ data }) => {
      cache.set(attachmentId, data);
      return data;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(attachmentId);
    });

  inFlight.set(attachmentId, request);
  return request;
}

/** Clear the session cache; see resetInlineAttachmentUrlCache for why. */
export function resetAttachmentPreviewSummaryCache(): void {
  cache.clear();
  inFlight.clear();
}
