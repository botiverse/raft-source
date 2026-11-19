import { parseArtifactId } from "@botiverse/raft-shared";

/**
 * The Artifacts a person recently opened beside each conversation (#proj-workspace:#291): the side card's title
 * lists them, most recent first, to switch back to one (ArtifactRecentTitle). Kept on this device the way the side
 * window's layout memory is (store/besideMemory.ts, docs/frontend/beside-memory.md), and keyed the same way:
 *
 * - One localStorage entry per person and server (`raft:artifact-recent:v1:<userId>:<serverId>`), holding
 *   `conversations[<conversationId>]`, at most ARTIFACT_RECENT_MAX_CONVERSATIONS of them, the least recently
 *   written dropped first. Never synced.
 * - Per conversation at most ARTIFACT_RECENT_MAX entries, most recently opened first: the Artifact as its address
 *   names it (`?artifact=`, the short id), its title and the version shown, and when it was opened (the side card's
 *   opening). Closing the Artifact forgets nothing; opening it again moves it to the front.
 * - Its own entry, not the beside memory's: that one forgets what the person closes, this list keeps it.
 * - Data that doesn't parse, or of another version, reads as nothing; a storage that throws is treated as empty
 *   and never written. Sign-out removes every entry of that person (all servers).
 *
 * Pure (no React, no app stores): the hook over it is artifactRecentConversation.ts.
 */
export const ARTIFACT_RECENT_STORAGE_PREFIX = "raft:artifact-recent:v1:";
export const ARTIFACT_RECENT_MAX = 5;
export const ARTIFACT_RECENT_MAX_CONVERSATIONS = 200;
/** A title is kept to this many characters (a list row shows far less). */
const MAX_TITLE = 300;

const VERSION = 1;
const ID = /^[0-9A-Za-z_-]+$/;

export interface RecentArtifact {
  /** The short id, as `?artifact=` writes it (artifactLinkId). */
  id: string;
  title: string;
  /** The version shown when it was last open here. */
  version: number;
  /** When it was opened (ms), the side card's opening. */
  openedAt: number;
}

interface StoredConversation {
  /** When it was last written (ms): the oldest go first. */
  at: number;
  items: RecentArtifact[];
}

interface Stored {
  v: typeof VERSION;
  conversations: Record<string, StoredConversation>;
}

export const NO_RECENT_ARTIFACTS: readonly RecentArtifact[] = [];

/** The title is the recent Artifacts' menu trigger from two on (one is the Artifact shown: nothing to switch to). */
export function isRecentTitleTrigger(items: readonly RecentArtifact[]): boolean {
  return items.length >= 2;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function recentArtifactsStorageKey(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string | null | undefined): string | null {
  if (!userId || !serverId || !conversationId || !ID.test(userId) || !ID.test(serverId) || !ID.test(conversationId)) return null;
  return `${ARTIFACT_RECENT_STORAGE_PREFIX}${userId}:${serverId}`;
}

function recentOf(value: unknown): RecentArtifact | null {
  if (!value || typeof value !== "object") return null;
  const { id, title, version, openedAt } = value as Record<string, unknown>;
  if (typeof id !== "string" || parseArtifactId(id) === null) return null;
  if (typeof title !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  // Within what a Date holds: the menu says how long ago it was.
  if (typeof openedAt !== "number" || !Number.isFinite(openedAt) || Math.abs(openedAt) > 8.64e15) return null;
  return { id, title: title.slice(0, MAX_TITLE), version, openedAt };
}

/** The entries, most recently opened first, one per Artifact, at most ARTIFACT_RECENT_MAX. */
function normalizeItems(items: readonly RecentArtifact[]): RecentArtifact[] {
  const seen = new Set<string>();
  return [...items]
    .sort((a, b) => b.openedAt - a.openedAt)
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .slice(0, ARTIFACT_RECENT_MAX);
}

function readStored(raw: string | null): Stored {
  const empty: Stored = { v: VERSION, conversations: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const { v, conversations } = parsed as { v?: unknown; conversations?: unknown };
  if (v !== VERSION || !conversations || typeof conversations !== "object" || Array.isArray(conversations)) return empty;
  const kept: Record<string, StoredConversation> = {};
  for (const [id, entry] of Object.entries(conversations as Record<string, unknown>)) {
    if (!ID.test(id) || !entry || typeof entry !== "object") continue;
    const { at, items } = entry as { at?: unknown; items?: unknown };
    const read = Array.isArray(items) ? items.map(recentOf).filter((item): item is RecentArtifact => item !== null) : [];
    if (read.length === 0) continue;
    kept[id] = { at: typeof at === "number" && Number.isFinite(at) ? at : 0, items: normalizeItems(read) };
  }
  return { v: VERSION, conversations: kept };
}

/** The stored text under `key` (the hook's snapshot: equal text, the same list); null for none or no storage. */
export function readRecentArtifactsRaw(key: string | null): string | null {
  const store = storage();
  if (!key || !store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** Told after every write and forget in this tab. */
export function subscribeRecentArtifacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Artifacts recently opened beside `conversationId`, most recent first (none: an empty list). */
export function recallRecentArtifacts(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string): readonly RecentArtifact[] {
  return recentArtifactsOf(readRecentArtifactsRaw(recentArtifactsStorageKey(userId, serverId, conversationId)), conversationId);
}

/** A conversation's list in a stored text (none, or text that doesn't parse: an empty list). */
export function recentArtifactsOf(raw: string | null, conversationId: string): readonly RecentArtifact[] {
  return raw ? readStored(raw).conversations[conversationId]?.items ?? NO_RECENT_ARTIFACTS : NO_RECENT_ARTIFACTS;
}

function sameItems(a: readonly RecentArtifact[], b: readonly RecentArtifact[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index]!;
    return item.id === other.id && item.title === other.title && item.version === other.version && item.openedAt === other.openedAt;
  });
}

/**
 * Remembers an Artifact open beside `conversationId`: in front where its opening is the latest, its title and
 * version replaced where it is listed already; the oldest past ARTIFACT_RECENT_MAX go.
 */
export function rememberRecentArtifact(userId: string | null | undefined, serverId: string | null | undefined, conversationId: string, entry: RecentArtifact, now: number = Date.now()): void {
  const key = recentArtifactsStorageKey(userId, serverId, conversationId);
  const store = storage();
  const item = recentOf(entry);
  if (!key || !store || !item) return;
  try {
    const stored = readStored(store.getItem(key));
    const before = stored.conversations[conversationId]?.items ?? [];
    const items = normalizeItems([item, ...before.filter((other) => other.id !== item.id)]);
    if (sameItems(before, items)) return;
    stored.conversations[conversationId] = { at: now, items };
    const conversations = Object.entries(stored.conversations).length <= ARTIFACT_RECENT_MAX_CONVERSATIONS
      ? stored.conversations
      : Object.fromEntries(Object.entries(stored.conversations).sort(([, a], [, b]) => b.at - a.at).slice(0, ARTIFACT_RECENT_MAX_CONVERSATIONS));
    store.setItem(key, JSON.stringify({ v: VERSION, conversations } satisfies Stored));
  } catch {
    // Storage full or blocked: nothing is remembered; the title stays plain.
    return;
  }
  for (const listener of [...listeners]) listener();
}

/** Sign-out: everything remembered for this person on this device, on every server. */
export function forgetRecentArtifacts(userId: string | null | undefined): void {
  const store = storage();
  if (!userId || !store) return;
  try {
    const prefix = `${ARTIFACT_RECENT_STORAGE_PREFIX}${userId}:`;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
  for (const listener of [...listeners]) listener();
}
