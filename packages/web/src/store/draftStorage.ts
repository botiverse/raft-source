import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { accessTokenSubject } from "../utils/hostAccessTokenSync";

/**
 * Composer drafts on this device, one localStorage entry per signed-in person
 * (`slock_drafts:<userId>`), so the next account on the same browser never has
 * the previous one's unsent text pre-filled. With no one signed in,
 * nothing is read or written.
 */
export const DRAFTS_STORAGE_KEY_PREFIX = "slock_drafts:";
/**
 * The unscoped entry every account used to share. Nothing in it says whose
 * text it is, so it is deleted unread, never migrated.
 */
export const LEGACY_DRAFTS_STORAGE_KEY = "slock_drafts";
// Draft edits are kept synchronous in Zustand, while durable storage is
// coalesced. The maxWait is deliberately independent of the debounce timer:
// mobile browsers are not guaranteed to deliver a lifecycle event before a
// process is killed.
export const DRAFT_PERSISTENCE_DEBOUNCE_MS = 250;
export const DRAFT_PERSISTENCE_MAX_WAIT_MS = 3_000;

export type Drafts = Record<string, string>;
/**
 * When each draft was last edited (epoch ms), for the Drafts page's order and
 * times (#triage:#127). Its own entry beside the drafts', so the drafts'
 * format never changes: an entry written before it, or by an older tab, has
 * no time, and those drafts sort last without one.
 */
export type DraftTimes = Record<string, number>;
export const DRAFT_TIMES_STORAGE_KEY_PREFIX = "slock_draft_times:";
/**
 * Unsent Artifact comment text (apps/artifacts/artifactLocalDrafts.ts), one entry per signed-in
 * person, as the composer drafts are. Named here so sign-out takes it away with them, whether or
 * not the Artifacts code was ever loaded.
 */
export const ARTIFACT_COMMENT_DRAFTS_STORAGE_KEY_PREFIX = "raft_artifact_comment_drafts:";

export function draftsStorageKey(userId: string): string {
  return `${DRAFTS_STORAGE_KEY_PREFIX}${userId}`;
}

export function draftTimesStorageKey(userId: string): string {
  return `${DRAFT_TIMES_STORAGE_KEY_PREFIX}${userId}`;
}

/** This person's draft times; anything unreadable is no time at all. */
export function loadDraftTimes(userId: string | null): DraftTimes {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(draftTimesStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const times: DraftTimes = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) times[key] = value;
    }
    return times;
  } catch {
    return {};
  }
}

function removeLegacyDrafts() {
  try {
    if (localStorage.getItem(LEGACY_DRAFTS_STORAGE_KEY) !== null) localStorage.removeItem(LEGACY_DRAFTS_STORAGE_KEY);
  } catch {
    // storage unavailable
  }
}

export function loadDrafts(userId: string | null): Drafts {
  removeLegacyDrafts();
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(draftsStorageKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Drafts = {};
    for (const [channelId, content] of Object.entries(parsed)) {
      if (typeof content === "string") drafts[channelId] = content;
    }
    return drafts;
  } catch {
    return {};
  }
}

/**
 * Whether this browser's stored session is still this person's. Another tab
 * that signed out (tokens gone) or signed in as someone else (a different
 * token subject) has ended it; this tab must then not write the drafts back.
 */
export function storedSessionBelongsTo(userId: string): boolean {
  const accessToken = localStorage.getItem("slock_access_token");
  if (!accessToken) return false;
  const subject = accessTokenSubject(accessToken);
  return subject === null || subject === userId;
}

function saveDrafts(userId: string, drafts: Drafts, times?: DraftTimes) {
  try {
    const key = draftsStorageKey(userId);
    if (Object.keys(drafts).length === 0) {
      localStorage.removeItem(key);
      localStorage.removeItem(draftTimesStorageKey(userId));
      return;
    }
    if (!storedSessionBelongsTo(userId)) return;
    localStorage.setItem(key, JSON.stringify(drafts));
    if (times) {
      // Only the drafts still there keep a time.
      const kept: DraftTimes = {};
      for (const draftKey of Object.keys(drafts)) {
        if (times[draftKey] !== undefined) kept[draftKey] = times[draftKey];
      }
      if (Object.keys(kept).length === 0) localStorage.removeItem(draftTimesStorageKey(userId));
      else localStorage.setItem(draftTimesStorageKey(userId), JSON.stringify(kept));
    }
  } catch {
    // ignore quota errors
  }
}

let pendingDraftSnapshot: { userId: string; drafts: Drafts; times?: DraftTimes } | null = null;
let draftDebounceTimer: unknown = null;
let draftMaxWaitTimer: unknown = null;
let draftPersistenceGeneration = 0;
let draftDebounceToken = 0;

function cancelDraftPersistenceTimers() {
  if (draftDebounceTimer !== null) {
    clearClockTimeout(draftDebounceTimer);
    draftDebounceTimer = null;
  }
  if (draftMaxWaitTimer !== null) {
    clearClockTimeout(draftMaxWaitTimer);
    draftMaxWaitTimer = null;
  }
}

export function flushPendingDraftSnapshot() {
  const snapshot = pendingDraftSnapshot;
  if (snapshot === null) return;
  pendingDraftSnapshot = null;
  draftPersistenceGeneration += 1;
  draftDebounceToken += 1;
  cancelDraftPersistenceTimers();
  saveDrafts(snapshot.userId, snapshot.drafts, snapshot.times);
}

function dropPendingDraftSnapshot() {
  pendingDraftSnapshot = null;
  draftPersistenceGeneration += 1;
  draftDebounceToken += 1;
  cancelDraftPersistenceTimers();
}

export function persistDraftSnapshotImmediately(userId: string | null, drafts: Drafts, times?: DraftTimes) {
  // clear/adopt are durability boundaries: a stale trailing timer must not be
  // able to restore a sent or migrated draft after this synchronous write.
  if (pendingDraftSnapshot && pendingDraftSnapshot.userId !== userId) flushPendingDraftSnapshot();
  dropPendingDraftSnapshot();
  if (!userId) return;
  pendingDraftSnapshot = { userId, drafts: { ...drafts }, times: times ? { ...times } : undefined };
  flushPendingDraftSnapshot();
}

export function scheduleDraftSnapshot(userId: string | null, drafts: Drafts, times?: DraftTimes) {
  if (pendingDraftSnapshot && pendingDraftSnapshot.userId !== userId) flushPendingDraftSnapshot();
  if (!userId) return;
  // `drafts` is a fresh Zustand snapshot and is never mutated after the
  // transition, so retaining it avoids another full-map clone per keystroke.
  pendingDraftSnapshot = { userId, drafts, times };
  draftDebounceToken += 1;
  const debounceToken = draftDebounceToken;
  if (draftDebounceTimer !== null) clearClockTimeout(draftDebounceTimer);
  draftDebounceTimer = setClockTimeout(() => {
    if (debounceToken !== draftDebounceToken) return;
    flushPendingDraftSnapshot();
  }, DRAFT_PERSISTENCE_DEBOUNCE_MS);

  if (draftMaxWaitTimer === null) {
    const generation = draftPersistenceGeneration;
    draftMaxWaitTimer = setClockTimeout(() => {
      draftMaxWaitTimer = null;
      if (generation !== draftPersistenceGeneration) return;
      flushPendingDraftSnapshot();
    }, DRAFT_PERSISTENCE_MAX_WAIT_MS);
  }
}

const forgetListeners = new Set<(userId: string | null) => void>();

/** The in-memory side (messageStore) drops its copy when the session's drafts are forgotten. */
export function onDraftsForgotten(listener: (userId: string | null) => void): () => void {
  forgetListeners.add(listener);
  return () => forgetListeners.delete(listener);
}

/**
 * Sign-out: this person's drafts leave the device. A pending write is dropped,
 * not flushed, so neither a trailing timer nor the pagehide flush can put
 * them back.
 */
export function forgetDrafts(userId: string | null) {
  dropPendingDraftSnapshot();
  removeLegacyDrafts();
  if (userId) {
    try {
      localStorage.removeItem(draftsStorageKey(userId));
      localStorage.removeItem(draftTimesStorageKey(userId));
      localStorage.removeItem(`${ARTIFACT_COMMENT_DRAFTS_STORAGE_KEY_PREFIX}${userId}`);
    } catch {
      // storage unavailable
    }
  }
  for (const listener of forgetListeners) listener(userId);
}

function installDraftPersistenceLifecycle() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.addEventListener("pagehide", flushPendingDraftSnapshot);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingDraftSnapshot();
  });
}

installDraftPersistenceLifecycle();
