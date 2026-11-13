// A comment image shown on the page (#proj-workspace:#146, phase 2): its bytes read through the
// Artifact source (core's object file route needs the session and X-Server-Id, so a bare
// `<img src>` can't load it), drawn from a `blob:` URL. Kept per reader for the page's life, the
// newest MAX_KEPT besides those on screen (an older one's URL is revoked once nothing shows it),
// read at most MAX_READING at a time.
import { useEffect, useRef, useState } from "react";
import type { ArtifactId, ObjectFileId } from "@botiverse/raft-shared";

import type { ArtifactApiError } from "./artifactApi";
import { artifactReaderScope } from "./artifactReaderScope";
import { artifactSource } from "./artifactSource";

/** What a comment image shows: loading, its `blob:` URL, gone (the one 404), or a read that failed (read again on Retry or the next mount). */
export type CommentImageView =
  | { status: "loading" }
  | { status: "ok"; url: string }
  | { status: "missing" }
  | { status: "failed" };

const MAX_KEPT = 64;
const MAX_READING = 4;

type Kept = { status: "ok"; url: string } | { status: "missing" };

const kept = new Map<string, Kept>();
/** How many mounted views show each image: never revoked while one does. */
const held = new Map<string, number>();
const retain = (key: string) => held.set(key, (held.get(key) ?? 0) + 1);
function release(key: string) {
  const left = (held.get(key) ?? 1) - 1;
  if (left > 0) held.set(key, left);
  else held.delete(key);
}
const reading = new Map<string, Promise<Kept | null>>();
const waiting: Array<() => void> = [];
let inFlight = 0;

const keyOf = (artifactId: ArtifactId, fileId: ObjectFileId) => `${artifactReaderScope() ?? "-"}|${artifactId}|${fileId}`;

const canMakeUrls = () => typeof URL !== "undefined" && typeof URL.createObjectURL === "function";

function keep(key: string, value: Kept) {
  const before = kept.get(key);
  if (before?.status === "ok" && (value.status !== "ok" || value.url !== before.url)) URL.revokeObjectURL(before.url);
  kept.delete(key);
  kept.set(key, value);
  // The oldest go first, never one a view on screen draws (its URL would break under it, in the lightbox too).
  for (const [oldest, entry] of [...kept]) {
    if (kept.size <= MAX_KEPT) break;
    if (held.has(oldest)) continue;
    kept.delete(oldest);
    if (entry.status === "ok") URL.revokeObjectURL(entry.url);
  }
}

/** The bytes the person just uploaded, shown at once once a comment carries them (no read again). */
export function keepCommentImageBytes(artifactId: ArtifactId, fileId: ObjectFileId, bytes: Blob) {
  if (!canMakeUrls()) return;
  keep(keyOf(artifactId, fileId), { status: "ok", url: URL.createObjectURL(bytes) });
}

/** What is kept for this image now, if anything (`kept` order: the newest last). */
function peek(key: string): Kept | null {
  const value = kept.get(key);
  if (!value) return null;
  kept.delete(key);
  kept.set(key, value);
  return value;
}

async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_READING) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

/** Reads the image once, however many ask at a time (one kept already answers at once); null: the read failed (not kept). */
function read(key: string, artifactId: ArtifactId, fileId: ObjectFileId): Promise<Kept | null> {
  const have = peek(key);
  if (have) return Promise.resolve(have);
  const known = reading.get(key);
  if (known) return known;
  const answer = turn(() => artifactSource().readCommentImage(artifactId, fileId)).then(
    (bytes): Kept | null => (canMakeUrls() ? { status: "ok", url: URL.createObjectURL(bytes) } : null),
    // Core's object file route answers one 404 for every reason: gone, for this reader.
    (error: unknown): Kept | null => ((error as Partial<ArtifactApiError> | null)?.status === 404 ? { status: "missing" } : null),
  ).then((value) => {
    if (value) keep(key, value);
    return value;
  }).finally(() => reading.delete(key));
  reading.set(key, answer);
  return answer;
}

/** Whether a comment image is gone (core's 404), read as useCommentImageUrls reads it (and kept for it). */
export async function commentImageGone(artifactId: ArtifactId, fileId: ObjectFileId): Promise<boolean> {
  const key = keyOf(artifactId, fileId);
  const value = await read(key, artifactId, fileId);
  return value?.status === "missing";
}

const LOADING: CommentImageView = { status: "loading" };
const FAILED: CommentImageView = { status: "failed" };

/**
 * Comment images as `blob:` URLs, one view per id in order, read through the Artifact source;
 * `missing` for one that is gone (a 404: deleted with its comment, or an upload no comment took
 * within the hour), `failed` for a read that failed (`attempt` changed: read again). An image shown
 * is held, so the cache never revokes its URL under it. No Artifact: nothing read, each loading.
 */
export function useCommentImageUrls(artifactId: ArtifactId | null, fileIds: readonly ObjectFileId[], attempt = 0): CommentImageView[] {
  // What reads answered that isn't a URL (gone, failed), by the attempt that asked; a URL is always the cache's.
  const [answered, setAnswered] = useState<ReadonlyMap<string, { view: CommentImageView; attempt: number }>>(() => new Map());
  // The ids decide when to read; the array itself is new on every render of its owner.
  const idsKey = fileIds.join(",");
  const idsRef = useRef(fileIds);
  idsRef.current = fileIds;
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    const reads = idsRef.current.map((fileId) => ({ fileId, key: keyOf(artifactId, fileId) }));
    for (const { key } of reads) retain(key);
    for (const { fileId, key } of reads) {
      void read(key, artifactId, fileId).then((value) => {
        if (!cancelled) setAnswered((current) => new Map(current).set(key, { view: value ?? FAILED, attempt }));
      });
    }
    return () => {
      cancelled = true;
      for (const { key } of reads) release(key);
    };
  }, [artifactId, idsKey, attempt]);
  if (!artifactId) return fileIds.map(() => LOADING);
  return fileIds.map((fileId) => {
    const key = keyOf(artifactId, fileId);
    const known = kept.get(key);
    if (known) return known;
    const said = answered.get(key);
    return said && said.view.status !== "ok" && said.attempt === attempt ? said.view : LOADING;
  });
}

/** For tests: nothing kept, nothing waiting. */
export function resetCommentImageUrlsForTests() {
  for (const value of kept.values()) if (value.status === "ok" && canMakeUrls()) URL.revokeObjectURL(value.url);
  kept.clear();
  held.clear();
  reading.clear();
  waiting.length = 0;
  inFlight = 0;
}
