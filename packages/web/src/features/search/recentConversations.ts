import type { SearchEntityResult } from "./searchEntities";

// Desktop ⌘K overlay empty state (task #113, Slack model): with nothing typed
// the palette lists the conversations you were in most recently, so ⌘K doubles
// as "switch back". Recency = the user's own visits (recorded by the channel /
// DM routes), NOT message activity — a busy channel you never open is not
// "recent" to you. Activity only fills the tail when the visit history is short
// (fresh install), so the list is never empty on a live server.

export const RECENT_CONVERSATION_LIMIT = 20;
export const RECENT_CONVERSATION_ROW_LIMIT = 10;

/** Most-recent-first, deduped, capped. */
export function pushRecentConversation(
  ids: readonly string[],
  channelId: string,
  limit = RECENT_CONVERSATION_LIMIT,
): string[] {
  if (!channelId) return [...ids];
  return [channelId, ...ids.filter((id) => id !== channelId)].slice(0, limit);
}

export function normalizeRecentConversationIds(raw: unknown, limit = RECENT_CONVERSATION_LIMIT): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** `/s/:slug/channel/:id` or `/s/:slug/dm/:id` (any prefix) → the conversation's channel id. */
export function conversationChannelIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = /\/(?:channel|dm)\/([^/?#]+)/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface SelectRecentConversationEntitiesParams {
  /** Visit history, most recent first (channel ids). */
  recentChannelIds: readonly string[];
  entities: readonly SearchEntityResult[];
  /** channelStore.channelActivity: last message time per channel id. */
  activity: Readonly<Record<string, string | null>>;
  /** Entity keys allowed to surface (hidden DMs / computers already removed). */
  eligibleEntityKeys: ReadonlySet<string>;
  /** The conversation behind the overlay — a row for "where you already are" is noise. */
  excludeChannelId?: string | null;
  /** Pad a short visit history with recently active conversations (default). `false` = visits only. */
  fillFromActivity?: boolean;
  limit?: number;
}

export function selectRecentConversationEntities({
  recentChannelIds,
  entities,
  activity,
  eligibleEntityKeys,
  excludeChannelId = null,
  fillFromActivity = true,
  limit = RECENT_CONVERSATION_ROW_LIMIT,
}: SelectRecentConversationEntitiesParams): SearchEntityResult[] {
  const byChannelId = new Map<string, SearchEntityResult>();
  for (const entity of entities) {
    if (!entity.channelId || entity.archivedAt || !eligibleEntityKeys.has(entity.key)) continue;
    if (entity.channelId === excludeChannelId) continue;
    // First entity wins for a channel id (a DM has one peer entity).
    if (!byChannelId.has(entity.channelId)) byChannelId.set(entity.channelId, entity);
  }
  const picked: SearchEntityResult[] = [];
  const pickedIds = new Set<string>();
  for (const channelId of recentChannelIds) {
    const entity = byChannelId.get(channelId);
    if (!entity || pickedIds.has(channelId)) continue;
    picked.push(entity);
    pickedIds.add(channelId);
    if (picked.length >= limit) return picked;
  }
  if (!fillFromActivity) return picked;
  const fill = [...byChannelId.entries()]
    .filter(([channelId]) => !pickedIds.has(channelId) && timestampMs(activity[channelId]) > 0)
    .sort((left, right) => timestampMs(activity[right[0]]) - timestampMs(activity[left[0]]) || left[1].title.localeCompare(right[1].title));
  for (const [, entity] of fill) {
    picked.push(entity);
    if (picked.length >= limit) break;
  }
  return picked;
}
