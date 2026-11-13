// Unsent comment text on this device (#proj-workspace:#144, xxchan): a comment written by voice on
// a phone was lost when the page was replaced before it was sent. Each comment box keeps what the
// person writes here, as the message composer keeps its drafts (store/draftStorage.ts), and starts
// with it again when it opens empty at the same place. Not a server draft: comment mode's batch
// drafts are those (artifactReviewDrafts.ts); this is only the text not yet sent or added. Images
// attached (#proj-workspace:#146) are kept as references only, never their bytes: the upload stays
// on the Server, unclaimed, for an hour; restored after that, it reads as gone (the box says so).
import { useMemo } from "react";
import { ARTIFACT_COMMENT_IMAGE_TYPES, ARTIFACT_COMMENT_MAX_IMAGES, asObjectFileId, clearClockTimeout, currentTimeMs, setClockTimeout } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactCommentDraftId, ArtifactCommentId, ArtifactCommentImage } from "@botiverse/raft-shared";

import { useSignedInPersonId } from "../../store/signedInPerson";
import { ARTIFACT_COMMENT_DRAFTS_STORAGE_KEY_PREFIX, onDraftsForgotten, storedSessionBelongsTo } from "../../store/appLocalDrafts";
import { useServerStore } from "../../store/serverStore";
import type { ArtifactCommentTarget } from "./ArtifactCommentsContext";

/** A draft not changed for this long is dropped (read or written). */
export const ARTIFACT_LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The words kept of one draft at most (the rest is not kept). */
export const ARTIFACT_LOCAL_DRAFT_MAX_TEXT = 20_000;
/** The drafts kept per person at most, the newest. */
export const ARTIFACT_LOCAL_DRAFT_MAX_ENTRIES = 50;
/** The stored entry's size at most (characters of JSON): the oldest drafts go first. */
const MAX_STORED_CHARS = 200_000;
/** Typing is written this long after the last change, and at least every MAX_WAIT_MS while it goes on. */
export const ARTIFACT_LOCAL_DRAFT_SAVE_MS = 400;
const MAX_WAIT_MS = 2_000;

/**
 * Which box a draft belongs to: a new comment at its target (the whole Artifact, a file, a place
 * in it), a reply to a comment, an edit of one's comment, or an edit of a draft. (Until #148 comment
 * mode's own boxes were kept apart, as `batch-new:` / `batch-reply:`; every box now both sends and
 * saves drafts, and those keys simply expire.)
 */
export type ArtifactLocalDraftPlace =
  | { kind: "new"; target: ArtifactCommentTarget }
  | { kind: "reply"; replyTo: ArtifactCommentId }
  | { kind: "edit"; comment: ArtifactCommentId }
  | { kind: "editDraft"; draft: ArtifactCommentDraftId };

/** Whose drafts and where: the signed-in person, the server open, the Artifact. */
export interface ArtifactLocalDraftScope {
  userId: string;
  server: string;
  artifact: string;
}

export interface ArtifactLocalDraft {
  text: string;
  /** The people and agents picked from the @ list (they become mentions when sent). */
  picked: ArtifactActor[];
  /** The images uploaded for it, as the upload answered (references, never bytes); absent: none. */
  images?: ArtifactCommentImage[];
  savedAt: number;
}

interface StoredDraft extends ArtifactLocalDraft {
  server: string;
  artifact: string;
  /** A new comment's target, posted at once (the one a reload offers back: useUnsentCommentOffer). */
  target?: ArtifactCommentTarget;
}

type StoredDrafts = Record<string, StoredDraft>;

export const artifactLocalDraftsStorageKey = (userId: string) => `${ARTIFACT_COMMENT_DRAFTS_STORAGE_KEY_PREFIX}${userId}`;

/** JSON with every object's keys sorted: the same anchor always makes the same key. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The place's part of a draft's key: `new:artifact`, `new:file:["a.md",{…}]`, `reply:<id>`, `edit:<id>`, … */
export function localDraftPlaceKey(place: ArtifactLocalDraftPlace): string {
  switch (place.kind) {
    case "new": {
      const target = place.target.scope === "artifact" ? "artifact" : `file:${stableJson([place.target.path, place.target.anchor])}`;
      return `new:${target}`;
    }
    case "reply": return `reply:${place.replyTo}`;
    case "edit": return `edit:${place.comment}`;
    case "editDraft": return `edit-draft:${place.draft}`;
  }
}

/** A draft's key in its person's entry: `<server>|<artifact>|<place>`. */
export function localDraftKey(scope: ArtifactLocalDraftScope, place: ArtifactLocalDraftPlace): string {
  return `${scope.server}|${scope.artifact}|${localDraftPlaceKey(place)}`;
}

const isString = (value: unknown): value is string => typeof value === "string";

function readActor(value: unknown): ArtifactActor | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if ((a.type !== "user" && a.type !== "agent") || !isString(a.id) || !isString(a.name) || !isString(a.displayName)) return null;
  return { type: a.type, id: a.id, name: a.name, displayName: a.displayName, avatarUrl: isString(a.avatarUrl) ? a.avatarUrl : null };
}

/** A stored target, as far as it reads as one (anything else is no target: the draft still restores in its own box). */
function readTarget(value: unknown): ArtifactCommentTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const t = value as Record<string, unknown>;
  if (t.scope === "artifact") return { scope: "artifact" };
  if (t.scope !== "file" || !isString(t.path)) return undefined;
  const anchor = t.anchor;
  if (anchor === null) return { scope: "file", path: t.path, anchor: null };
  if (!anchor || typeof anchor !== "object" || !isString((anchor as { type?: unknown }).type)) return undefined;
  // Lines and rows are what a card opens at again (useUnsentCommentOffer): only whole ones.
  const { type, data } = anchor as { type: string; data?: { start?: unknown; end?: unknown; quote?: unknown } };
  if ((type === "lines" || type === "csv-rows") && !(Number.isInteger(data?.start) && Number.isInteger(data?.end) && (data?.quote === undefined || isString(data.quote)))) return undefined;
  return { scope: "file", path: t.path, anchor: anchor as NonNullable<Extract<ArtifactCommentTarget, { scope: "file" }>["anchor"]> };
}

const IMAGE_TYPES: ReadonlySet<string> = new Set(ARTIFACT_COMMENT_IMAGE_TYPES);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A stored image reference, as far as it reads as one (anything else is left out). */
function readImage(value: unknown): ArtifactCommentImage | null {
  if (!value || typeof value !== "object") return null;
  const i = value as Record<string, unknown>;
  if (!isString(i.fileId) || i.fileId === "" || !isString(i.contentType) || !IMAGE_TYPES.has(i.contentType)) return null;
  if (!isCount(i.sizeBytes) || !isCount(i.width) || !isCount(i.height)) return null;
  // Read back from this device's own storage: the ids the upload answered, kept as they were.
  return { fileId: asObjectFileId(i.fileId), contentType: i.contentType as ArtifactCommentImage["contentType"], sizeBytes: i.sizeBytes, width: i.width, height: i.height };
}

/** At most ARTIFACT_COMMENT_MAX_IMAGES, as an optional field: absent when there are none. */
const imagesField = (images: readonly ArtifactCommentImage[] | undefined): { images?: ArtifactCommentImage[] } => (
  images && images.length > 0 ? { images: images.slice(0, ARTIFACT_COMMENT_MAX_IMAGES) } : {}
);

function readEntry(value: unknown, now: number): StoredDraft | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Record<string, unknown>;
  if (!isString(e.text) || !isString(e.server) || !isString(e.artifact)) return null;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt) || now - e.savedAt > ARTIFACT_LOCAL_DRAFT_TTL_MS) return null;
  const images = Array.isArray(e.images) ? e.images.map(readImage).filter((i): i is ArtifactCommentImage => i !== null) : [];
  // Words, or at least one image: a draft of nothing is none.
  if (e.text.trim() === "" && images.length === 0) return null;
  const picked = Array.isArray(e.picked) ? e.picked.map(readActor).filter((a): a is ArtifactActor => a !== null) : [];
  const target = readTarget(e.target);
  return { text: e.text, picked, ...imagesField(images), savedAt: e.savedAt, server: e.server, artifact: e.artifact, ...(target ? { target } : {}) };
}

/** This person's drafts still in date; anything unreadable is no draft. */
function readAll(userId: string): StoredDrafts {
  try {
    const raw = localStorage.getItem(artifactLocalDraftsStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const now = currentTimeMs();
    const drafts: StoredDrafts = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = readEntry(value, now);
      if (entry) drafts[key] = entry;
    }
    return drafts;
  } catch {
    return {};
  }
}

/** Written back within the caps (the newest kept); nothing left, the entry goes. Never for a session that ended. */
function writeAll(userId: string, drafts: StoredDrafts) {
  try {
    const key = artifactLocalDraftsStorageKey(userId);
    const now = currentTimeMs();
    let kept = Object.entries(drafts)
      .filter(([, d]) => now - d.savedAt <= ARTIFACT_LOCAL_DRAFT_TTL_MS)
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .slice(0, ARTIFACT_LOCAL_DRAFT_MAX_ENTRIES);
    let json = JSON.stringify(Object.fromEntries(kept));
    while (kept.length > 0 && json.length > MAX_STORED_CHARS) {
      kept = kept.slice(0, -1);
      json = JSON.stringify(Object.fromEntries(kept));
    }
    if (kept.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    if (!storedSessionBelongsTo(userId)) return;
    localStorage.setItem(key, json);
  } catch {
    // storage unavailable (private mode) or full: the words stay in the box only
  }
}

// Writes waiting for the debounce, newest per key (null: remove it).
const pending = new Map<string, { userId: string; key: string; draft: StoredDraft | null }>();
let debounceTimer: unknown = null;
let maxWaitTimer: unknown = null;
const pendingId = (userId: string, key: string) => `${userId}\u0000${key}`;

function cancelTimers() {
  if (debounceTimer !== null) clearClockTimeout(debounceTimer);
  if (maxWaitTimer !== null) clearClockTimeout(maxWaitTimer);
  debounceTimer = null;
  maxWaitTimer = null;
}

/** Every write still waiting, now (a box's blur and unmount, the page hidden or going). */
export function flushArtifactLocalDrafts() {
  cancelTimers();
  if (pending.size === 0) return;
  const byUser = new Map<string, Array<{ key: string; draft: StoredDraft | null }>>();
  for (const write of pending.values()) byUser.set(write.userId, [...(byUser.get(write.userId) ?? []), write]);
  pending.clear();
  for (const [userId, writes] of byUser) {
    const drafts = readAll(userId);
    for (const { key, draft } of writes) {
      if (draft) drafts[key] = draft;
      else delete drafts[key];
    }
    writeAll(userId, drafts);
  }
}

function stored(scope: ArtifactLocalDraftScope, place: ArtifactLocalDraftPlace, draft: Pick<ArtifactLocalDraft, "text" | "picked" | "images">): StoredDraft {
  return {
    text: draft.text.slice(0, ARTIFACT_LOCAL_DRAFT_MAX_TEXT),
    picked: draft.picked,
    ...imagesField(draft.images),
    savedAt: currentTimeMs(),
    server: scope.server,
    artifact: scope.artifact,
    ...(place.kind === "new" ? { target: place.target } : {}),
  };
}

/**
 * Keep (or, with null, drop) a box's words, written after ARTIFACT_LOCAL_DRAFT_SAVE_MS without a
 * change (MAX_WAIT_MS at most while typing goes on: a phone may kill the page without a word).
 */
export function scheduleArtifactLocalDraft(scope: ArtifactLocalDraftScope, place: ArtifactLocalDraftPlace, draft: Pick<ArtifactLocalDraft, "text" | "picked" | "images"> | null) {
  const key = localDraftKey(scope, place);
  pending.set(pendingId(scope.userId, key), { userId: scope.userId, key, draft: draft ? stored(scope, place, draft) : null });
  if (debounceTimer !== null) clearClockTimeout(debounceTimer);
  debounceTimer = setClockTimeout(flushArtifactLocalDrafts, ARTIFACT_LOCAL_DRAFT_SAVE_MS);
  if (maxWaitTimer === null) maxWaitTimer = setClockTimeout(flushArtifactLocalDrafts, MAX_WAIT_MS);
}

/** Drop a draft now, by its key: sent, cancelled, emptied, or moved into another box. */
export function discardArtifactLocalDraftKey(userId: string, key: string) {
  pending.delete(pendingId(userId, key));
  const drafts = readAll(userId);
  if (!(key in drafts)) return;
  delete drafts[key];
  writeAll(userId, drafts);
}

export function discardArtifactLocalDraft(scope: ArtifactLocalDraftScope, place: ArtifactLocalDraftPlace) {
  discardArtifactLocalDraftKey(scope.userId, localDraftKey(scope, place));
}

/** This person's drafts as they stand, the writes still waiting included (they are the newest). */
function currentDrafts(userId: string): StoredDrafts {
  const drafts = readAll(userId);
  for (const write of pending.values()) {
    if (write.userId !== userId) continue;
    if (write.draft) drafts[write.key] = write.draft;
    else delete drafts[write.key];
  }
  return drafts;
}

const asDraft = (d: StoredDraft): ArtifactLocalDraft => ({ text: d.text, picked: d.picked, ...imagesField(d.images), savedAt: d.savedAt });

/** The words kept under a draft's key, if any. */
export function readArtifactLocalDraftKey(userId: string, key: string): ArtifactLocalDraft | null {
  const draft = currentDrafts(userId)[key];
  return draft ? asDraft(draft) : null;
}

/** The box's kept words, if any. */
export function readArtifactLocalDraft(scope: ArtifactLocalDraftScope, place: ArtifactLocalDraftPlace): ArtifactLocalDraft | null {
  return readArtifactLocalDraftKey(scope.userId, localDraftKey(scope, place));
}

/** The newest new comment (posted at once, not comment mode's) left unsent on this Artifact here, with its key and target. */
export function newestUnsentComment(scope: ArtifactLocalDraftScope): { key: string; target: ArtifactCommentTarget; draft: ArtifactLocalDraft } | null {
  let newest: { key: string; target: ArtifactCommentTarget; draft: ArtifactLocalDraft } | null = null;
  for (const [key, d] of Object.entries(currentDrafts(scope.userId))) {
    if (d.server !== scope.server || d.artifact !== scope.artifact || !d.target || (newest && newest.draft.savedAt >= d.savedAt)) continue;
    newest = { key, target: d.target, draft: asDraft(d) };
  }
  return newest;
}

/**
 * Two boxes' words as one (a box taking another's): the first's, a blank line, the second's, the
 * picks of both, the images of both (the first's first, ARTIFACT_COMMENT_MAX_IMAGES at most).
 */
export function joinArtifactLocalDrafts(first: ArtifactLocalDraft | null, second: ArtifactLocalDraft | null): ArtifactLocalDraft | null {
  if (!first || !second) return first ?? second;
  const picked = [...first.picked, ...second.picked.filter((a) => !first.picked.some((b) => b.type === a.type && b.id === a.id))];
  const text = [first.text, second.text].filter((t) => t.trim() !== "").join("\n\n");
  const images = [...(first.images ?? []), ...(second.images ?? []).filter((i) => !first.images?.some((j) => j.fileId === i.fileId))];
  return { text, picked, ...imagesField(images), savedAt: Math.max(first.savedAt, second.savedAt) };
}

/** For tests: nothing waiting, no timers. */
export function resetArtifactLocalDraftsForTests() {
  pending.clear();
  cancelTimers();
}

/** Whose drafts a box reads and writes: none with no one signed in (nothing is kept then). */
export function useArtifactLocalDraftScope(artifactId: string | null): ArtifactLocalDraftScope | null {
  const userId = useSignedInPersonId();
  const server = useServerStore((s) => s.current?.id ?? null);
  return useMemo(() => (userId && artifactId ? { userId, server: server ?? "-", artifact: artifactId } : null), [userId, server, artifactId]);
}

function installLifecycle() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.addEventListener("pagehide", flushArtifactLocalDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushArtifactLocalDrafts();
  });
  // Sign-out takes the stored entry away (forgetDrafts); what is waiting goes too, unwritten.
  onDraftsForgotten((userId) => {
    for (const [id, write] of pending) if (userId === null || write.userId === userId) pending.delete(id);
  });
}

installLifecycle();
