// The hover toolbar's reaction button shows the person's most-used reaction
// (Feishu-style; cindyz and Jasper, 2026-11-10): a click adds it, resting on
// the button opens every reaction. Usage is counted per user, per device, in
// localStorage, best effort: a storage failure only falls back to 👍.

export const DEFAULT_FAVORITE_REACTION = "👍";
/** Kept emoji; past it the least-used (then oldest) is dropped. */
export const REACTION_USAGE_LIMIT = 32;

const STORAGE_PREFIX = "raft:reaction-usage:";

export interface ReactionUsageEntry {
  count: number;
  /** Order of the last use, higher is more recent. */
  lastUsedAt: number;
}
export type ReactionUsage = Record<string, ReactionUsageEntry>;

export function reactionUsageStorageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function isEntry(value: unknown): value is ReactionUsageEntry {
  if (!value || typeof value !== "object") return false;
  const { count, lastUsedAt } = value as Record<string, unknown>;
  return typeof count === "number" && count > 0 && typeof lastUsedAt === "number";
}

export function readReactionUsage(userId: string): ReactionUsage {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(reactionUsageStorageKey(userId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => isEntry(entry))) as ReactionUsage;
  } catch {
    return {};
  }
}

/** Most count wins; a tie goes to the most recent; no usage means 👍. */
export function pickFavoriteReaction(usage: ReactionUsage): string {
  let favorite = DEFAULT_FAVORITE_REACTION;
  let best: ReactionUsageEntry | null = null;
  for (const [emoji, entry] of Object.entries(usage)) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.lastUsedAt > best.lastUsedAt)) {
      favorite = emoji;
      best = entry;
    }
  }
  return favorite;
}

/**
 * One more use of `emoji`. Past REACTION_USAGE_LIMIT emoji the least-used
 * other one (the oldest among equals) goes, so a new emoji can still come in.
 */
export function addReactionUsage(usage: ReactionUsage, emoji: string, now: number): ReactionUsage {
  const next: ReactionUsage = { ...usage, [emoji]: { count: (usage[emoji]?.count ?? 0) + 1, lastUsedAt: now } };
  const others = Object.entries(next).filter(([key]) => key !== emoji);
  if (others.length < REACTION_USAGE_LIMIT) return next;
  others.sort(([, a], [, b]) => a.count - b.count || a.lastUsedAt - b.lastUsedAt);
  for (const [key] of others.slice(0, others.length - REACTION_USAGE_LIMIT + 1)) delete next[key];
  return next;
}

// This tab's counts per user, read from storage on first use: a toolbar reads
// the favorite each time it shows, so that read stays in memory.
const usageCache = new Map<string, ReactionUsage>();

/** Counts one more `emoji`, on top of what storage holds now (other tabs included). */
export function recordReactionUsage(userId: string, emoji: string): void {
  const next = addReactionUsage(readReactionUsage(userId), emoji, Date.now());
  usageCache.set(userId, next);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(reactionUsageStorageKey(userId), JSON.stringify(next));
  } catch {
    // Best effort: other tabs and the next load just don't learn from this reaction.
  }
}

/**
 * The favorite as of now. A toolbar reads it when it shows and keeps it while
 * it shows, so the button never changes under the pointer (cindyz).
 */
export function currentFavoriteReaction(userId: string | null | undefined): string {
  if (!userId) return DEFAULT_FAVORITE_REACTION;
  let usage = usageCache.get(userId);
  if (!usage) {
    usage = readReactionUsage(userId);
    usageCache.set(userId, usage);
  }
  return pickFavoriteReaction(usage);
}

/** Tests: forget this tab's counts, as a new page load would. */
export function resetReactionUsageCacheForTests(): void {
  usageCache.clear();
}
