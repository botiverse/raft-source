import api from "../../api/client";

/**
 * Session cache + in-flight dedupe for inline attachment URLs.
 *
 * Every image tile used to fetch `/attachments/{id}/url?disposition=inline`
 * on its own, with no sharing across components or remounts. A message with
 * 6 images costs 6 requests; the same attachments rendered again inside a
 * forward preview cost 6 more; scrolling back remounts and pays again. The
 * download limiter is 120/min, so an attachment-dense channel trips it and the
 * images render as broken files (observed: dozens of 429s).
 *
 * Signed URLs carry an expiry, so they are cacheable by construction — this
 * just stops us re-asking for a URL we already hold.
 */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function readFresh(attachmentId: string): string | null {
  return cache.get(attachmentId) ?? null;
}

/** Drop a cached URL that failed to load, so the next render refetches it. */
export function invalidateInlineAttachmentUrl(attachmentId: string): void {
  cache.delete(attachmentId);
}

export function getCachedInlineAttachmentUrl(attachmentId: string): string | null {
  return readFresh(attachmentId);
}

/**
 * NOTE ON ABORT: callers deliberately cannot cancel the shared request.
 *
 * An earlier version forwarded each caller's AbortSignal into the shared
 * promise. In a virtualised message list tiles unmount constantly, so the first
 * unmount aborted the in-flight fetch for EVERY other caller waiting on it, and
 * images fell back permanently to file chips. A shared request must outlive any
 * single subscriber; callers drop the result themselves if they are gone.
 */
/**
 * Resolve many attachment URLs in ONE request.
 *
 * Per-attachment resolution scales with images, not messages: a dense channel
 * blows past the 120/min download limiter and renders broken files. Callers
 * that know their whole set (a message's gallery) should use this; the single
 * form remains for one-off opens.
 */
export async function fetchInlineAttachmentUrls(attachmentIds: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const id of attachmentIds) {
    const hit = readFresh(id);
    if (hit) resolved.set(id, hit);
    else missing.push(id);
  }
  if (missing.length === 0) return resolved;

  try {
    const { data } = await api.post<{ urls?: Array<{ id: string; url: string; expiresAt?: string | null }> }>(
      "/attachments/urls",
      { attachmentIds: missing },
    );
    for (const entry of data.urls ?? []) {
      cache.set(entry.id, entry.url);
      resolved.set(entry.id, entry.url);
    }
  } catch {
    // Fall through: callers still render what resolved, and a later open can
    // retry the single form.
  }
  return resolved;
}

export async function fetchInlineAttachmentUrl(attachmentId: string): Promise<string | null> {
  const cached = readFresh(attachmentId);
  if (cached) return cached;

  const pending = inFlight.get(attachmentId);
  if (pending) return pending;

  const request = api
    .get<{ url: string; expiresAt?: string | null }>(
      `/attachments/${attachmentId}/url?disposition=inline`,
    )
    .then(({ data }) => {
      cache.set(attachmentId, data.url);
      return data.url;
    })
    .finally(() => {
      inFlight.delete(attachmentId);
    });

  inFlight.set(attachmentId, request.catch(() => null));
  return request;
}

/**
 * Clear the session cache. Exported for tests: the cache is module-level, so
 * one test's resolved URLs would otherwise satisfy the next test's expectations
 * and hide a missing request.
 */
export function resetInlineAttachmentUrlCache(): void {
  cache.clear();
  inFlight.clear();
}
