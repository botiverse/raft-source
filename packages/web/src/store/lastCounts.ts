import type { ServerUnreadSummary } from "../utils/serverUnreadSummary";
import type { InboxGroupCount, InboxItem } from "./inboxStore";
import type { FollowedThread } from "./threadStore";

// Task #164: the last unread counts and Activity first page this person saw on
// a server, kept in localStorage so a page opened (or a server switched to)
// while RisingWave is unavailable shows them instead of nothing. They are shown
// as possibly out of date until the server answers (store/rwFreshness.ts).
//
// - One entry per (user, server): `raft.lastCounts.v1:{userId}:{serverId}`.
//   Only the signed-in user's own entries are read or evicted; one server's
//   entry is never shown on another server.
// - Written only after a clean (not stale) 200, at most once per
//   LAST_COUNTS_WRITE_THROTTLE_MS per entry (the latest values win).
// - At most LAST_COUNTS_MAX_BYTES per entry: the Activity rows are cut first.
//   At most LAST_COUNTS_MAX_SERVERS per user: the least recently saved go.
// - Dropped when the schema does not match or it is older than
//   LAST_COUNTS_MAX_AGE_MS; entries of an older schema are also swept on first
//   use. Every entry is deleted on sign-out and when the session ends (401).
// - No message text is ever stored (Tenny, #164 review): Activity rows and
//   followed threads keep only an allowlist of fields (ids, conversation and
//   sender names, counts, times, kinds). Previews, the parent message of a
//   thread and task titles come back empty; the rows render without them.

export const LAST_COUNTS_PREFIX = "raft.lastCounts.v1:";
/** 2: rows without message text. Entries of schema 1 carried previews and are deleted. */
export const LAST_COUNTS_SCHEMA = 2;
export const LAST_COUNTS_MAX_BYTES = 64 * 1024;
export const LAST_COUNTS_MAX_SERVERS = 5;
export const LAST_COUNTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LAST_COUNTS_WRITE_THROTTLE_MS = 5_000;
/** The Activity rows kept: the first page of the All list. */
export const LAST_COUNTS_ACTIVITY_ROWS = 30;

export type LastUnreadCounts = {
  unreadCounts: Record<string, number>;
  mentionFlags: Record<string, boolean>;
  newFlags: Record<string, boolean>;
};

export type LastActivityPage = {
  items: InboxItem[];
  groups: InboxGroupCount[];
  totalCount: number;
  totalUnreadCount: number;
  activeUnreadCount: number;
  hasMore: boolean;
};

export type LastCountsParts = {
  /** The cross-server unread summary (the rail's dots) as seen from this server. */
  summary?: Record<string, ServerUnreadSummary>;
  unread?: LastUnreadCounts;
  followed?: FollowedThread[];
  activity?: LastActivityPage;
};

export type LastCounts = LastCountsParts & {
  schema: typeof LAST_COUNTS_SCHEMA;
  savedAt: number;
};

type ChannelRow = Extract<InboxItem, { kind: "channel" | "dm" }>;
type ThreadRow = Extract<InboxItem, { kind: "thread" }>;

// Allowlists, not denylists: a field added to a row later is not stored until
// someone decides it carries no message text.
const CHANNEL_ROW_FIELDS = [
  "kind", "channelId", "channelName", "channelType", "lastMessageId", "latestActivitySeq",
  "doneFrontierSeq", "firstUnreadMessageId", "firstMentionMessageId", "lastMessageAt",
  "lastMessageSenderType", "lastMessageSenderId", "lastMessageSenderName", "latestDelegatedBy",
  "latestRetracted", "senderAvatarUrl", "unreadCount", "hasMention", "readStateLatestActivitySeq", "doneAt",
] as const satisfies readonly (keyof ChannelRow)[];

const THREAD_ROW_FIELDS = [
  "kind", "threadChannelId", "parentMessageId", "parentChannelId", "parentChannelName",
  "parentChannelType", "parentMessageSenderType", "parentMessageSenderId", "latestActivitySenderType",
  "latestActivitySenderId", "latestActivitySenderName", "latestDelegatedBy", "latestRetracted",
  "senderAvatarUrl", "parentRetracted", "latestActivityMessageId", "latestActivitySeq",
  "doneFrontierSeq", "firstUnreadMessageId", "firstMentionMessageId", "replyCount", "lastActivityAt",
  "lastReplyAt", "unreadCount", "hasMention", "taskNumber", "taskStatus", "taskClaimedByName",
  "readStateLatestActivitySeq", "doneAt", "isFollowing", "unfollowedAt", "conversationKind", "taskId",
] as const satisfies readonly (keyof ThreadRow)[];

const FOLLOWED_FIELDS = [
  "threadChannelId", "parentMessageId", "parentChannelId", "parentChannelName", "parentChannelType",
  "parentMessageSenderType", "parentMessageSenderId", "parentMessageCreatedAt", "parentInHistory", "repliesInHistory", "latestActivitySeq",
  "replyCount", "lastReplyAt", "unreadCount", "hasMention", "firstUnreadMessageId", "taskId",
  "taskNumber", "taskStatus", "taskClaimedByType", "taskClaimedById", "taskClaimedByName", "conversationKind",
] as const satisfies readonly (keyof FollowedThread)[];

function pick<T extends object>(source: T, fields: readonly (keyof T)[]): Partial<T> {
  const picked: Partial<T> = {};
  for (const field of fields) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  return picked;
}

/** An Activity row as stored: no message text. Mention-action rows (about one message) are not stored. */
function storedActivityRow(item: InboxItem): Partial<InboxItem> | null {
  if (item.kind === "thread") return pick<ThreadRow>(item, THREAD_ROW_FIELDS);
  if (item.kind === "channel" || item.kind === "dm") return pick<ChannelRow>(item, CHANNEL_ROW_FIELDS);
  return null;
}

/** A stored row back in the store's shape, its text fields empty. */
function restoredActivityRow(row: unknown): InboxItem | null {
  if (!isRecord(row)) return null;
  if (row.kind === "thread") {
    return { ...pick(row as unknown as ThreadRow, THREAD_ROW_FIELDS), parentMessagePreview: "", latestActivityPreview: "", taskTitle: null } as ThreadRow;
  }
  if (row.kind === "channel" || row.kind === "dm") {
    return { ...pick(row as unknown as ChannelRow, CHANNEL_ROW_FIELDS), lastMessagePreview: "" } as ChannelRow;
  }
  return null;
}

function restoredFollowedThread(row: unknown): FollowedThread | null {
  if (!isRecord(row) || typeof row.threadChannelId !== "string") return null;
  return { ...pick(row as unknown as FollowedThread, FOLLOWED_FIELDS), parentMessagePreview: "", taskTitle: null } as FollowedThread;
}

/** The entry exactly as written: allowlisted row fields only. */
function storedEntry(entry: LastCounts): unknown {
  return {
    ...entry,
    ...(entry.followed ? { followed: entry.followed.map((thread) => pick(thread, FOLLOWED_FIELDS)) } : {}),
    ...(entry.activity
      ? {
        activity: {
          ...entry.activity,
          items: entry.activity.items.map(storedActivityRow).filter((row) => row !== null),
        },
      }
      : {}),
  };
}

/** A read entry in the store's shapes. */
function restoredEntry(entry: LastCounts): LastCounts {
  return {
    ...entry,
    ...(entry.followed ? { followed: entry.followed.map(restoredFollowedThread).filter((thread) => thread !== null) } : {}),
    ...(entry.activity
      ? { activity: { ...entry.activity, items: entry.activity.items.map(restoredActivityRow).filter((row) => row !== null) } }
      : {}),
  };
}

export function lastCountsKey(userId: string, serverId: string): string {
  return `${LAST_COUNTS_PREFIX}${userId}:${serverId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isValidEntry(value: unknown, nowMs: number): value is LastCounts {
  if (!isRecord(value) || value.schema !== LAST_COUNTS_SCHEMA) return false;
  const savedAt = value.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return false;
  if (nowMs - savedAt > LAST_COUNTS_MAX_AGE_MS) return false;
  if (value.summary !== undefined && !isRecord(value.summary)) return false;
  if (value.unread !== undefined) {
    const unread = value.unread;
    if (!isRecord(unread) || !isRecord(unread.unreadCounts) || !isRecord(unread.mentionFlags) || !isRecord(unread.newFlags)) return false;
  }
  if (value.followed !== undefined && !Array.isArray(value.followed)) return false;
  if (value.activity !== undefined) {
    const activity = value.activity;
    if (!isRecord(activity) || !Array.isArray(activity.items) || !Array.isArray(activity.groups)) return false;
    if (typeof activity.totalCount !== "number" || typeof activity.totalUnreadCount !== "number") return false;
  }
  return true;
}

function readKey(store: Storage, key: string, nowMs: number): LastCounts | null {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (isValidEntry(parsed, nowMs)) return restoredEntry(parsed);
  // A schema mismatch, an expired or a corrupt entry is never shown: drop it.
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
  return null;
}

let sweptOutdated = false;

/**
 * Delete every entry of another schema, any user's: schema 1 entries carried
 * message previews. Once per page load, on first use.
 */
export function sweepOutdatedLastCounts(): void {
  if (sweptOutdated) return;
  sweptOutdated = true;
  const store = storage();
  if (!store) return;
  for (const key of keysWithPrefix(store, LAST_COUNTS_PREFIX)) {
    let schema: unknown;
    try {
      schema = (JSON.parse(store.getItem(key) ?? "null") as { schema?: unknown } | null)?.schema;
    } catch {
      schema = undefined;
    }
    if (schema === LAST_COUNTS_SCHEMA) continue;
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

/** TEST-ONLY: sweep again on the next use. */
export function __resetLastCountsSweepForTests(): void {
  sweptOutdated = false;
}

/** The saved counts of this user on this server, or null (none, too old, another schema). */
export function readLastCounts(userId: string | null | undefined, serverId: string | null | undefined, nowMs = Date.now()): LastCounts | null {
  if (!userId || !serverId) return null;
  sweepOutdatedLastCounts();
  const store = storage();
  if (!store) return null;
  return readKey(store, lastCountsKey(userId, serverId), nowMs);
}

function keysWithPrefix(store: Storage, prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    // ignore
  }
  return keys;
}

/** Fit the entry in LAST_COUNTS_MAX_BYTES: fewer Activity rows, then no Activity, then no followed threads. */
export function serializeWithinCap(entry: LastCounts): string | null {
  let candidate: LastCounts = entry;
  let json = JSON.stringify(storedEntry(candidate));
  while (json.length > LAST_COUNTS_MAX_BYTES && candidate.activity && candidate.activity.items.length > 0) {
    const keep = Math.floor(candidate.activity.items.length / 2);
    candidate = {
      ...candidate,
      activity: { ...candidate.activity, items: candidate.activity.items.slice(0, keep), hasMore: true },
    };
    json = JSON.stringify(storedEntry(candidate));
  }
  if (json.length > LAST_COUNTS_MAX_BYTES && candidate.activity) {
    const { activity: _activity, ...rest } = candidate;
    candidate = rest as LastCounts;
    json = JSON.stringify(storedEntry(candidate));
  }
  if (json.length > LAST_COUNTS_MAX_BYTES && candidate.followed) {
    const { followed: _followed, ...rest } = candidate;
    candidate = rest as LastCounts;
    json = JSON.stringify(storedEntry(candidate));
  }
  return json.length > LAST_COUNTS_MAX_BYTES ? null : json;
}

/** Keep the user's LAST_COUNTS_MAX_SERVERS most recently saved entries. Other users' entries are left alone. */
function evictLeastRecent(store: Storage, userId: string, keepKey: string, nowMs: number): void {
  const entries = keysWithPrefix(store, `${LAST_COUNTS_PREFIX}${userId}:`)
    .map((key) => ({ key, entry: readKey(store, key, nowMs) }))
    .filter((candidate): candidate is { key: string; entry: LastCounts } => candidate.entry !== null)
    .sort((left, right) => {
      if (left.key === keepKey) return -1;
      if (right.key === keepKey) return 1;
      return right.entry.savedAt - left.entry.savedAt;
    });
  for (const { key } of entries.slice(LAST_COUNTS_MAX_SERVERS)) {
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

function writeNow(userId: string, serverId: string, parts: LastCountsParts, nowMs: number): void {
  sweepOutdatedLastCounts();
  const store = storage();
  if (!store) return;
  const key = lastCountsKey(userId, serverId);
  const previous = readKey(store, key, nowMs);
  const entry: LastCounts = { ...previous, ...parts, schema: LAST_COUNTS_SCHEMA, savedAt: nowMs };
  const json = serializeWithinCap(entry);
  try {
    if (json === null) store.removeItem(key);
    else store.setItem(key, json);
  } catch {
    // Quota: leave the previous copy; the next clean answer tries again.
  }
  evictLeastRecent(store, userId, key, nowMs);
}

type PendingWrite = { userId: string; serverId: string; parts: LastCountsParts; timer: ReturnType<typeof setTimeout> | null };
const pending = new Map<string, PendingWrite>();
const lastWriteAt = new Map<string, number>();

function flush(key: string): void {
  const write = pending.get(key);
  if (!write) return;
  pending.delete(key);
  if (write.timer) clearTimeout(write.timer);
  const nowMs = Date.now();
  lastWriteAt.set(key, nowMs);
  writeNow(write.userId, write.serverId, write.parts, nowMs);
}

/**
 * Save parts of this user's counts on this server. Call only with values from
 * a clean (not stale) answer. Leading and trailing throttle per entry: the
 * first save writes at once, later ones within the window merge into one
 * write at its end.
 */
export function saveLastCounts(userId: string | null | undefined, serverId: string | null | undefined, parts: LastCountsParts): void {
  if (!userId || !serverId) return;
  const key = lastCountsKey(userId, serverId);
  const existing = pending.get(key);
  if (existing) {
    existing.parts = { ...existing.parts, ...parts };
    return;
  }
  const write: PendingWrite = { userId, serverId, parts, timer: null };
  pending.set(key, write);
  const sinceLastMs = Date.now() - (lastWriteAt.get(key) ?? Number.NEGATIVE_INFINITY);
  if (sinceLastMs >= LAST_COUNTS_WRITE_THROTTLE_MS) {
    flush(key);
    return;
  }
  write.timer = setTimeout(() => flush(key), LAST_COUNTS_WRITE_THROTTLE_MS - sinceLastMs);
}

/** Write every pending save now (page hide; tests). */
export function flushLastCounts(): void {
  for (const key of [...pending.keys()]) flush(key);
}

// A trailing write still waiting when the page goes (reload, navigation, tab
// closed or backgrounded) would be lost: write it now.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushLastCounts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushLastCounts();
  });
}

/** Sign-out: delete every saved entry (any user) and drop pending writes. */
export function clearAllLastCounts(): void {
  for (const write of pending.values()) {
    if (write.timer) clearTimeout(write.timer);
  }
  pending.clear();
  lastWriteAt.clear();
  const store = storage();
  if (!store) return;
  for (const key of keysWithPrefix(store, LAST_COUNTS_PREFIX)) {
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

/**
 * Activity rows worth saving: the first page of the All list's conversation
 * rows. Object rows (Artifacts) are not saved: their unread and Done are
 * their app's, which the saved counts don't carry.
 */
export function activityRowsToSave(items: readonly InboxItem[]): InboxItem[] {
  return items.filter((item) => item.kind !== "object").slice(0, LAST_COUNTS_ACTIVITY_ROWS);
}
