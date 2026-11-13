import { summarizeAttachmentPreviewResponse } from "@botiverse/raft-shared";
import type { AttachmentPreviewSummaryResponse } from "@botiverse/raft-shared";
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
/**
 * Two reads share this shape. The card read (`?view=summary`) is what every
 * document chip makes on mount: kind and stats line only. The full read is
 * made once, when the user opens the preview (task #164: cards used to fetch
 * the full payload — now up to 512 KB of markdown each — to print a label).
 */
type PreviewReadCache<T> = { cache: Map<string, T>; inFlight: Map<string, Promise<T | null>> };

const fullReads: PreviewReadCache<AttachmentPreview> = { cache: new Map(), inFlight: new Map() };
const cardReads: PreviewReadCache<AttachmentPreviewSummaryResponse> = { cache: new Map(), inFlight: new Map() };

/** The full preview payload, for the opened preview. */
export function fetchAttachmentPreviewSummary(attachmentId: string): Promise<AttachmentPreview | null> {
  return cachedPreviewRead(fullReads, attachmentId, `/attachments/${attachmentId}/preview`);
}

/** The attachment card's summary: never the document body. */
export function fetchAttachmentPreviewCardSummary(attachmentId: string): Promise<AttachmentPreviewSummaryResponse | null> {
  return cachedPreviewRead(cardReads, attachmentId, `/attachments/${attachmentId}/preview?view=summary`, toCardSummary);
}

/**
 * Version skew: a server older than `?view=summary` ignores it and answers
 * the full payload (frontend-only releases, backend rollbacks, the desktop's
 * bundled web, preview deploys against prod). Summarize it here so the card
 * reads one shape — a full CSV has `rows`, not `rowsShown` ("First NaN
 * rows") — and the session cache never holds a document body for a card.
 */
function toCardSummary(response: AttachmentPreviewSummaryResponse | AttachmentPreview): AttachmentPreviewSummaryResponse {
  if (response.status !== "ok") return response;
  const { data } = response;
  if (data.kind === "csv" && "rowsShown" in data && typeof data.rowsShown === "number") return response as AttachmentPreviewSummaryResponse;
  // Every other summary kind is a subset of its full shape, so summarizing
  // either one is safe.
  return summarizeAttachmentPreviewResponse(response as AttachmentPreview);
}

async function cachedPreviewRead<T extends AttachmentPreview | AttachmentPreviewSummaryResponse>(
  { cache, inFlight }: PreviewReadCache<T>,
  attachmentId: string,
  url: string,
  normalize: (data: T) => T = (data) => data,
): Promise<T | null> {
  const cached = cache.get(attachmentId);
  if (cached) return cached;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const request = api
    .get<T>(url)
    .then(({ data: raw }) => {
      const data = normalize(raw);
      // reason "unavailable" is transient (server compute capacity, not the
      // file): the server never caches it, and pinning it for the session here
      // would hide the preview until reload after the pool recovers.
      if (data.status !== "unsupported" || data.reason !== "unavailable") {
        cache.set(attachmentId, data);
      }
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
  for (const reads of [fullReads, cardReads]) {
    reads.cache.clear();
    reads.inFlight.clear();
  }
}
