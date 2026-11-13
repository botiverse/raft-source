// The images a comment box holds (#proj-workspace:#146, phase 2): each uploaded as it is attached
// (pasted, dropped, picked), with its progress; one that fails is offered again (Retry) when that
// may help, or removed. × cancels an upload still going. What a comment or a draft sends is the
// uploaded ones' ids, in order.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent } from "react";
import { ARTIFACT_COMMENT_MAX_IMAGES } from "@botiverse/raft-shared";
import type { ArtifactCommentImage, ArtifactId, ArtifactWebErrorDetails, ObjectFileId } from "@botiverse/raft-shared";

import { artifactErrorCode, artifactErrorDetails } from "./artifactApi";
import { materializePastedFile } from "../../utils/clipboardFiles";
import { commentImageFits, pickCommentImages, prepareCommentImage } from "./artifactCommentImageFiles";
import type { CommentImageRefusal } from "./artifactCommentImageFiles";
import { commentImageGone, keepCommentImageBytes } from "./artifactCommentImageUrls";
import { artifactSource } from "./artifactSource";

type RefusedReason = Exclude<ArtifactWebErrorDetails["IMAGE_REFUSED"]["reason"], "server_quota_exceeded" | "uploader_quota_exceeded">;

/**
 * Why an upload failed, as far as the box can say what to do next:
 * - `refused`: the Server won't keep these bytes (`reason`, with its `limit` when it gives one):
 *   another image is needed, Retry can't help;
 * - `quota`: the server's monthly upload quota (`monthly`) or its storage (`storage`) is used up,
 *   or the person's own share of it: images unposted or in drafts at once (`drafts`, freed by
 *   posting or deleting drafts) or all of theirs (`uploads`): Retry can't help either;
 * - `failed`: anything else (offline, a 5xx, the rate limit), which Retry may get past.
 */
export type CommentImageFailure =
  | { kind: "refused"; reason: RefusedReason; limit: number | null }
  | { kind: "quota"; reason: "monthly" | "storage" | "drafts" | "uploads"; limit?: number | null }
  | { kind: "failed" };

interface ItemBase {
  /** This attachment in the box (not the file id: a failed one has none). */
  key: string;
  /** The file's own name (the alt, ×'s and the preview's name); null for one restored from this device. */
  name: string | null;
  /** A `blob:` URL of the bytes attached here; null for a restored one (read by its id). */
  preview: string | null;
}

/**
 * One image in the box: `uploading` (its bytes being made ready, then sent, with `progress`),
 * `ready` (uploaded: `image`), `failed` (`failure`), or `expired`: uploaded, but gone since (an
 * upload no comment took within the hour, restored from this device or refused at send).
 */
export type CommentImageItem =
  | (ItemBase & { status: "uploading"; progress: number })
  | (ItemBase & { status: "ready"; image: ArtifactCommentImage })
  | (ItemBase & { status: "failed"; failure: CommentImageFailure })
  | (ItemBase & { status: "expired"; image: ArtifactCommentImage });

/** An item with the bytes uploaded (for Retry); null for a restored one, or while they are made ready. */
type Held = CommentImageItem & { bytes: Blob | null };

let nextKey = 1;
const newKey = () => `comment-image-${nextKey++}`;

function failureOf(error: unknown): CommentImageFailure {
  const code = artifactErrorCode(error);
  if (code === "FILE_UPLOAD_QUOTA_EXCEEDED") return { kind: "quota", reason: "monthly" };
  if (code !== "IMAGE_REFUSED") return { kind: "failed" };
  const details = artifactErrorDetails(error, "IMAGE_REFUSED");
  if (!details) return { kind: "refused", reason: "unsupported_type", limit: null };
  if (details.reason === "server_quota_exceeded") return { kind: "quota", reason: "storage" };
  if (details.reason === "uploader_quota_exceeded") return { kind: "quota", reason: details.scope === "total" ? "uploads" : "drafts", limit: details.limit ?? null };
  return { kind: "refused", reason: details.reason, limit: details.limit ?? null };
}

const restoredItem = (image: ArtifactCommentImage): Held => ({ key: newKey(), name: null, preview: null, status: "ready", image, bytes: null });

const urlOf = (bytes: Blob) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(bytes) : null);
const revoke = (url: string | null) => { if (url) URL.revokeObjectURL(url); };

export interface CommentImageAttachments {
  items: readonly CommentImageItem[];
  /** The uploaded images, in order: what a comment or draft sends (`images`) and what is kept on this device. */
  ready: ArtifactCommentImage[];
  /** An upload is still going, or a paste's images are still being read (or files wait behind one): Send and Save Draft wait. */
  uploading: boolean;
  /** One failed or expired is still in the box: removed or retried before sending. */
  unresolved: boolean;
  /** Why the last files attached weren't all taken; null once dismissed or the box changes again. */
  refused: ReadonlySet<CommentImageRefusal> | null;
  dismissRefused: () => void;
  /** Attaches what fits (dropped, picked): at once, or after the pastes still being read. */
  add: (files: readonly File[]) => void;
  /**
   * Attaches pasted files: each image the box may take has its bytes copied into memory at once (a
   * clipboard File can become unreadable once the paste event ends), then is added in turn, after
   * the attempts before it; Send waits meanwhile.
   */
  addPasted: (files: readonly File[]) => void;
  retry: (key: string) => void;
  /** Out of the box; an upload still going is cancelled. */
  remove: (key: string) => void;
  /** The Server said this upload is gone (a comment's 400 IMAGE_NOT_FOUND): shown expired. Whether the box holds it. */
  expireFile: (fileId: string | null) => boolean;
  /** Sent or saved: the box is empty again (the uploads are the comment's now). */
  clear: () => void;
}

const readyOf = (items: readonly Held[]) => items.flatMap((item) => (item.status === "ready" ? [item.image] : []));

/**
 * The box's images. `restored`: those kept on this device with its words (artifactLocalDrafts),
 * shown again as uploaded, each read once at mount: one that is gone (core's 404: an upload no
 * comment took within the hour) shows as expired, to remove. `onChange` is told the uploaded ones
 * whenever the person changes them (attached, removed, gone), never at mount; `onCount` how many
 * the box holds whenever that changes (an image alone is the person's own content).
 */
export function useCommentImageAttachments(
  artifactId: ArtifactId | null,
  restored: readonly ArtifactCommentImage[] | null,
  onChange: (ready: ArtifactCommentImage[]) => void,
  onCount: (count: number) => void,
): CommentImageAttachments {
  // The box's images as they stand, changed only through `commit` (async answers build on the latest).
  const [initial] = useState(() => (restored ?? []).slice(0, ARTIFACT_COMMENT_MAX_IMAGES).map(restoredItem));
  const itemsRef = useRef<Held[]>(initial);
  const [items, setItems] = useState<Held[]>(initial);
  const [refused, setRefused] = useState<Set<CommentImageRefusal> | null>(null);
  const tell = useRef({ onChange, onCount });
  tell.current = { onChange, onCount };
  const mounted = useRef(true);
  /** Each upload still going, to cancel it (×, cleared, the box gone). */
  const uploads = useRef(new Map<string, AbortController>());
  const cancel = useCallback((key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
  }, []);
  const commit = useCallback((next: Held[], changed: boolean) => {
    const before = itemsRef.current.length;
    itemsRef.current = next;
    if (!mounted.current) return;
    setItems(next);
    if (changed) tell.current.onChange(readyOf(next));
    if (next.length !== before) tell.current.onCount(next.length);
  }, []);
  const replace = useCallback((key: string, make: (item: Held) => Held, changed = false) => {
    commit(itemsRef.current.map((item) => (item.key === key ? make(item) : item)), changed);
  }, [commit]);
  const expire = useCallback((key: string) => replace(key, (item) => (item.status === "ready" ? { key: item.key, name: item.name, preview: item.preview, bytes: item.bytes, status: "expired", image: item.image } : item), true), [replace]);

  // The previews this box made: revoked once their image leaves it, or the box goes; its uploads
  // still going are cancelled then. The restored ones are read once: gone, expired.
  useEffect(() => {
    mounted.current = true;
    const going = uploads.current;
    if (artifactId) {
      for (const item of itemsRef.current) {
        if (item.status !== "ready" || item.bytes) continue;
        const { key } = item;
        void commentImageGone(artifactId, item.image.fileId).then((gone) => {
          if (gone && itemsRef.current.some((i) => i.key === key && i.status === "ready")) expire(key);
        });
      }
    }
    return () => {
      mounted.current = false;
      for (const controller of going.values()) controller.abort();
      going.clear();
      for (const item of itemsRef.current) revoke(item.preview);
    };
    // Once, at mount: what the box started with.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upload = useCallback((key: string, bytes: Blob) => {
    if (!artifactId) return;
    cancel(key);
    const controller = new AbortController();
    uploads.current.set(key, controller);
    replace(key, (item) => ({ key: item.key, name: item.name, preview: item.preview, bytes, status: "uploading", progress: 0 }));
    const progress = (value: number) => replace(key, (item) => (item.status === "uploading" ? { ...item, progress: value } : item));
    artifactSource().uploadCommentImage(artifactId, bytes, { onProgress: progress, signal: controller.signal }).then((image) => {
      if (controller.signal.aborted) return;
      uploads.current.delete(key);
      // Shown at once, from these bytes, once the comment that carries it is posted.
      keepCommentImageBytes(artifactId, image.fileId, bytes);
      replace(key, (item) => ({ key: item.key, name: item.name, preview: item.preview, bytes, status: "ready", image }), true);
    }, (error: unknown) => {
      // Cancelled (× while it uploaded, the box gone): nothing happened.
      if (controller.signal.aborted) return;
      uploads.current.delete(key);
      replace(key, (item) => ({ key: item.key, name: item.name, preview: item.preview, bytes, status: "failed", failure: failureOf(error) }));
    });
  }, [artifactId, cancel, replace]);

  // Each attempt (a paste, a drop, a pick) its own refusal set: only the latest attempt's is shown,
  // and a refusal found later (a JPEG still too large once its bytes are ready) joins its own
  // attempt's, never a later one's.
  const attempts = useRef(0);
  const place = useCallback((files: readonly File[], extraRefusals: readonly CommentImageRefusal[] = []) => {
    // The box gone (a paste read after it closed): nothing is drawn, so no preview is left unrevoked.
    if (!mounted.current) return;
    const attempt = ++attempts.current;
    const { taken, refused: notTaken } = pickCommentImages(files, ARTIFACT_COMMENT_MAX_IMAGES - itemsRef.current.length);
    for (const reason of extraRefusals) notTaken.add(reason);
    setRefused(notTaken.size > 0 ? new Set(notTaken) : null);
    if (taken.length === 0) return;
    // Each is in the box at once, drawn from its own file, uploading; its bytes made ready (a JPEG
    // drawn again) before they go, then drawn from those.
    const placed = taken.map((file): Held => ({ key: newKey(), name: file.name || null, preview: urlOf(file), status: "uploading", progress: 0, bytes: null }));
    commit([...itemsRef.current, ...placed], false);
    taken.forEach((file, index) => {
      const { key } = placed[index]!;
      void prepareCommentImage(file).then((bytes) => {
        // Removed while its bytes were made ready, or the box gone: nothing goes.
        if (!mounted.current || !itemsRef.current.some((item) => item.key === key)) return;
        if (!commentImageFits(bytes)) {
          revoke(itemsRef.current.find((item) => item.key === key)?.preview ?? null);
          commit(itemsRef.current.filter((item) => item.key !== key), false);
          // Said with its own attempt's refusals while that is still the latest (shown again if
          // dismissed meanwhile: this one is news); a later attempt's stand as they are.
          notTaken.add("size");
          if (attempts.current === attempt) setRefused(new Set(notTaken));
          return;
        }
        if (bytes !== file) {
          replace(key, (item) => {
            revoke(item.preview);
            return { ...item, preview: urlOf(bytes) };
          });
        }
        upload(key, bytes);
      });
    });
  }, [commit, replace, upload]);

  const retry = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item?.status === "failed" && item.failure.kind === "failed" && item.bytes) upload(key, item.bytes);
  }, [upload]);
  const remove = useCallback((key: string) => {
    cancel(key);
    revoke(itemsRef.current.find((i) => i.key === key)?.preview ?? null);
    commit(itemsRef.current.filter((i) => i.key !== key), true);
    setRefused(null);
  }, [cancel, commit]);
  const expireFile = useCallback((fileId: string | null) => {
    const item = fileId === null ? undefined : itemsRef.current.find((i) => i.status === "ready" && i.image.fileId === fileId);
    if (!item) return false;
    expire(item.key);
    return true;
  }, [expire]);
  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      cancel(item.key);
      revoke(item.preview);
    }
    commit([], false);
    setRefused(null);
  }, [cancel, commit]);

  // Attempts waiting their turn (a paste whose images are still being read, a drop or pick behind
  // one), and their application in order: each paste's read starts at paste time, each attempt is
  // applied only after those before it, so none takes the room of one before it or clears its
  // refusal. `queued` is the count as it stands (read at once); `reading` the one drawn.
  const [reading, setReading] = useState(0);
  const queued = useRef(0);
  const turns = useRef<Promise<void>>(Promise.resolve());
  const after = useCallback(<T>(ready: Promise<T>, apply: (value: T) => void) => {
    queued.current += 1;
    setReading((count) => count + 1);
    turns.current = turns.current
      .then(() => ready)
      .then(apply)
      // A mistake in applying one (a bug, not a file): said, and the next attempts still go.
      .catch((error: unknown) => { console.error("[artifact comment images] attaching failed", error); })
      .finally(() => {
        queued.current -= 1;
        if (mounted.current) setReading((count) => count - 1);
      });
  }, []);

  const add = useCallback((files: readonly File[]) => {
    if (queued.current === 0) place(files);
    else after(Promise.resolve(), () => place(files));
  }, [after, place]);

  const addPasted = useCallback((files: readonly File[]) => {
    // Only an image the box may take is read: one refused by its type, a PNG or GIF over the size
    // cap (its size is its file's), or one with no room left for it is refused unread. Room is the
    // box's now; what the pastes before it take is checked as it is applied.
    const { taken, refused: unread } = pickCommentImages(files, ARTIFACT_COMMENT_MAX_IMAGES - itemsRef.current.length);
    after(Promise.all(taken.map((file) => materializePastedFile(file))), (copies) => {
      const kept = copies.filter((file): file is File => file !== null);
      place(kept, [...unread, ...(kept.length < copies.length ? ["unreadable" as const] : [])]);
    });
  }, [after, place]);

  const dismissRefused = useCallback(() => setRefused(null), []);
  const ready = useMemo(() => readyOf(items), [items]);
  return useMemo(() => ({
    items,
    ready,
    uploading: reading > 0 || items.some((item) => item.status === "uploading"),
    unresolved: items.some((item) => item.status === "failed" || item.status === "expired"),
    refused,
    dismissRefused,
    add,
    addPasted,
    retry,
    remove,
    expireFile,
    clear,
  }), [items, ready, reading, refused, dismissRefused, add, addPasted, retry, remove, expireFile, clear]);
}

/** The ids a comment or draft sends for `ready` (absent when none: older Servers ignore the field anyway). */
export const imagesInput = (ready: readonly ArtifactCommentImage[]): { images?: ObjectFileId[] } => (ready.length > 0 ? { images: ready.map((image) => image.fileId) } : {});

/** Files dragged over the box: the overlay while they are, and the files when dropped. Text drags pass by. */
export function useCommentImageDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const isFileDrag = (event: DragEvent) => !!event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files");
  const onDragEnter = useCallback((event: DragEvent) => {
    if (!enabled || !isFileDrag(event)) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, [enabled]);
  const onDragLeave = useCallback((event: DragEvent) => {
    if (!enabled || !isFileDrag(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, [enabled]);
  // Without preventDefault here the browser opens a dropped file in place of the page.
  const onDragOver = useCallback((event: DragEvent) => {
    if (!enabled || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, [enabled]);
  const onDrop = useCallback((event: DragEvent) => {
    if (!enabled || !isFileDrag(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  }, [enabled, onFiles]);
  return { dragging: enabled && dragging, handlers: { onDragEnter, onDragLeave, onDragOver, onDrop } };
}
