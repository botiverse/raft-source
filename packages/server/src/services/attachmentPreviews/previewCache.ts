import type { AttachmentPreviewResponse } from "@botiverse/raft-shared";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../db";
import { attachmentPreviewCache } from "../../db/schema";
import { buildAttachmentPreviewResponse, getAttachmentPreviewProvider, type AttachmentPreviewBuildTimings } from "./registry";
import type { ResolvedAttachment } from "../attachmentRecord";

type Attachment = ResolvedAttachment;

/**
 * Bump when any provider's output shape or limits change, so cached rows built
 * by an older server are recomputed instead of served.
 */
// 2: markdown limit 64 KB payload -> 512 KB line-cut prefix (task #164), so
// rows that pinned "too_large" for a mid-size markdown file are rebuilt.
export const ATTACHMENT_PREVIEW_CACHE_VERSION = 2;
/** Previews whose parse (not download) took at least this long are cached whatever their kind. */
export const ATTACHMENT_PREVIEW_CACHE_MIN_COMPUTE_MS = 200;
/** Parsing these is CPU-heavy (zip inflate + SheetJS), so they are always cached. */
const ALWAYS_CACHED_KINDS: ReadonlySet<string> = new Set(["xlsx"]);
/** A hit refreshes `last_hit_at` at most this often (keeps hits read-only). */
const LAST_HIT_REFRESH_MS = 60 * 60 * 1000;

export type AttachmentPreviewCacheOutcome = "hit" | "miss_stored" | "miss_not_stored" | "shared" | "uncacheable";

export interface AttachmentPreviewCacheRow {
  contentKey: string;
  providerVersion: number;
  preview: AttachmentPreviewResponse;
  lastHitAt: Date;
}

export interface AttachmentPreviewCacheStore {
  read(attachmentId: string): Promise<AttachmentPreviewCacheRow | null>;
  write(attachmentId: string, row: { contentKey: string; providerVersion: number; preview: AttachmentPreviewResponse; computeMs: number }): Promise<void>;
  touch(attachmentId: string, olderThan: Date): Promise<void>;
}

export const dbAttachmentPreviewCacheStore: AttachmentPreviewCacheStore = {
  async read(attachmentId) {
    const [row] = await getDb()
      .select({
        contentKey: attachmentPreviewCache.contentKey,
        providerVersion: attachmentPreviewCache.providerVersion,
        preview: attachmentPreviewCache.preview,
        lastHitAt: attachmentPreviewCache.lastHitAt,
      })
      .from(attachmentPreviewCache)
      .where(eq(attachmentPreviewCache.attachmentId, attachmentId))
      .limit(1);
    // jsonb comes back untyped; only this module writes the column.
    return row ? { ...row, preview: row.preview as AttachmentPreviewResponse } : null;
  },
  async write(attachmentId, row) {
    const values = { ...row, createdAt: new Date(), lastHitAt: new Date() };
    await getDb()
      .insert(attachmentPreviewCache)
      .values({ attachmentId, ...values })
      .onConflictDoUpdate({ target: attachmentPreviewCache.attachmentId, set: values });
  },
  async touch(attachmentId, olderThan) {
    await getDb()
      .update(attachmentPreviewCache)
      .set({ lastHitAt: new Date() })
      .where(and(eq(attachmentPreviewCache.attachmentId, attachmentId), lt(attachmentPreviewCache.lastHitAt, olderThan)));
  },
};

/**
 * Storage identity of the original. Storage keys are minted per attachment and
 * object, so a re-upload or transfer that changes the bytes changes this key.
 */
export function attachmentPreviewContentKey(attachment: Attachment): string {
  return `${attachment.objectId ?? "-"}:${attachment.storageKey}:${attachment.sizeBytes}`;
}

type AttachmentPreviewCacheResult = {
  response: AttachmentPreviewResponse;
  cache: AttachmentPreviewCacheOutcome;
  computeMs: number | null;
  /** Storage download and preview parse; set only when this request built it. */
  fetchMs?: number;
  parseMs?: number;
};
type AttachmentPreviewCacheOptions = {
  store?: AttachmentPreviewCacheStore;
  build?: (attachment: Attachment, timings: AttachmentPreviewBuildTimings) => Promise<AttachmentPreviewResponse>;
  now?: () => number;
  onCacheError?: (err: unknown) => void;
};

const inflight = new Map<string, Promise<AttachmentPreviewCacheResult>>();

/**
 * Build (or reuse) the preview for an attachment the caller has ALREADY been
 * authorized to read: the cache only saves CPU and grants no access. Cache
 * failures fall back to computing, so the preview never fails because of them.
 * Concurrent requests for one attachment share the whole lookup-build-store
 * sequence; it is registered before the first await so none of them slips past.
 */
export function getAttachmentPreviewWithCache(
  attachment: Attachment,
  options: AttachmentPreviewCacheOptions = {},
): Promise<AttachmentPreviewCacheResult> {
  const pending = inflight.get(attachment.id);
  if (pending) return pending.then((result) => ({ response: result.response, cache: "shared", computeMs: null }));
  const work = lookupBuildAndStore(attachment, options);
  inflight.set(attachment.id, work);
  const clear = () => { if (inflight.get(attachment.id) === work) inflight.delete(attachment.id); };
  work.then(clear, clear);
  return work;
}

async function lookupBuildAndStore(attachment: Attachment, options: AttachmentPreviewCacheOptions): Promise<AttachmentPreviewCacheResult> {
  const store = options.store ?? dbAttachmentPreviewCacheStore;
  const build = options.build ?? ((target: Attachment, timings: AttachmentPreviewBuildTimings) => buildAttachmentPreviewResponse(target, { timings }));
  const now = options.now ?? (() => performance.now());
  const onCacheError = options.onCacheError ?? ((err) => console.warn("[AttachmentPreviewCache] cache unavailable:", err));

  const provider = getAttachmentPreviewProvider(attachment);
  if (!provider) return { response: await build(attachment, {}), cache: "uncacheable", computeMs: null };

  const contentKey = attachmentPreviewContentKey(attachment);
  try {
    const row = await store.read(attachment.id);
    if (row && row.contentKey === contentKey && row.providerVersion === ATTACHMENT_PREVIEW_CACHE_VERSION) {
      const staleBefore = new Date(Date.now() - LAST_HIT_REFRESH_MS);
      if (row.lastHitAt < staleBefore) void store.touch(attachment.id, staleBefore).catch(onCacheError);
      return { response: row.preview, cache: "hit", computeMs: null };
    }
  } catch (err) {
    onCacheError(err);
  }

  const started = now();
  const timings: AttachmentPreviewBuildTimings = {};
  const response = await build(attachment, timings);
  const computeMs = Math.round(now() - started);
  // Only synchronous parsing earns a cache row: the storage download is async
  // I/O that never stalls the event loop (Tenny, task #17 follow-up). A build
  // that reports no split counts as all parse.
  const parseMs = timings.parseMs ?? computeMs;
  const split = { ...(timings.fetchMs === undefined ? {} : { fetchMs: timings.fetchMs }), parseMs };

  // reason "unavailable" is transient pool degradation, not a property of the
  // file: storing it (xlsx is ALWAYS_CACHED_KINDS) would pin the outage.
  const transient = response.status === "unsupported" && response.reason === "unavailable";
  const worthStoring = !transient
    && (ALWAYS_CACHED_KINDS.has(provider.kind) || parseMs >= ATTACHMENT_PREVIEW_CACHE_MIN_COMPUTE_MS);
  if (!worthStoring) return { response, cache: "miss_not_stored", computeMs, ...split };
  try {
    await store.write(attachment.id, { contentKey, providerVersion: ATTACHMENT_PREVIEW_CACHE_VERSION, preview: response, computeMs });
  } catch (err) {
    onCacheError(err);
  }
  return { response, cache: "miss_stored", computeMs, ...split };
}
