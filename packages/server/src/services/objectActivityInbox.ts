/**
 * The Activity page with object rows (S6): `GET /api/channels/inbox` reads
 * this. Conversation rows come from channelService.getInboxItems, unchanged;
 * object rows (objectActivity.ts) are merged into the page by time, the way
 * the unfollowed-thread compositor (getUnifiedActivityAllInboxItems) merges
 * its rows: both sources read from the start to the page's end, sorted
 * together, the page sliced out. The counts stay apart: `totalCount`,
 * `totalUnreadCount` and `activeUnreadCount` are the conversation rows' as
 * before (older App versions badge them directly), and object rows add
 * `objectCount`, `objectUnreadCount` and `objectMentionUnreadCount` (shared
 * ObjectInboxFields).
 *
 * With no object app on for the server the answer is exactly getInboxItems'.
 * Object rows are listed for the filters all, unread, mentions and
 * unread_mentions, not with a search, a channel or a scope (the counts are
 * still added); on a plan with a history window (Free), those whose newest
 * event is inside it, as conversation rows.
 */
import type { ObjectInboxFields, ObjectInboxItem } from "@botiverse/raft-shared";
import type { AppWebReader } from "../platform/apps";
import * as channelService from "./channelService";
import { objectInboxItems, objectRowIdentity, readObjectActivityPage, type ObjectActivityRow } from "./objectActivity";

export type ActivityInboxItem = channelService.InboxItem | ObjectInboxItem;
export type ActivityInboxResult = Omit<channelService.InboxItemsResult, "items"> & { items: ActivityInboxItem[] } & Partial<ObjectInboxFields>;

type Entry = { kind: "conversation"; item: channelService.InboxItem } | { kind: "object"; row: ObjectActivityRow };

/**
 * The time an entry sorts by, to the microsecond as ISO 8601 (UTC), so keys
 * compare as strings: an object row's is `last_event_at` as its page was
 * read in that order (objectActivity.ts); a conversation row's time has
 * milliseconds only, its microseconds read as zero.
 */
const activityKeyOf = (entry: Entry): string => (entry.kind === "object"
  ? entry.row.activityKey
  : conversationActivityKey(entry.item));

/** The key a conversation row with no valid time sorts by: the oldest there is. */
export const EARLIEST_ACTIVITY_KEY = "1970-01-01T00:00:00.000000Z";

const conversationKeys = new WeakMap<channelService.InboxItem, string>();

/**
 * A conversation row's sort key. A row whose time is missing or does not
 * parse sorts as the oldest (last in the newest-first list) instead of
 * failing the whole page; it is logged once, with its kind and id, so the
 * row can be found.
 */
export function conversationActivityKey(item: channelService.InboxItem): string {
  const cached = conversationKeys.get(item);
  if (cached !== undefined) return cached;
  const raw = channelService.inboxItemActivityAt(item);
  const at = new Date(raw);
  let key: string;
  if (Number.isNaN(at.getTime())) {
    console.warn("[ActivityInbox] conversation row has no valid activity time; sorted as the oldest", {
      row: channelService.inboxItemIdentity(item),
      value: raw === "" ? "(empty)" : raw,
    });
    key = EARLIEST_ACTIVITY_KEY;
  } else {
    key = at.toISOString().replace(/Z$/, "000Z");
  }
  conversationKeys.set(item, key);
  return key;
}
const rowKindOf = (entry: Entry): string => (entry.kind === "object" ? "object" : entry.item.kind);
const byCodePoint = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * channelService's order (time, then kind, then identity), over both kinds
 * of row. Restricted to either source it is that source's own order, so
 * reading each from the start to the page's end and merging never repeats
 * or skips a row across pages: object rows by their microsecond time, then
 * kind and id by code point (the page's ORDER BY with COLLATE "C").
 */
function compareEntries(left: Entry, right: Entry, sort: "asc" | "desc" | undefined): number {
  const direction = sort === "asc" ? 1 : -1;
  const timeDelta = byCodePoint(activityKeyOf(left), activityKeyOf(right));
  if (timeDelta !== 0) return timeDelta * direction;
  const kindDelta = rowKindOf(left).localeCompare(rowKindOf(right));
  if (kindDelta !== 0) return kindDelta * direction;
  if (left.kind === "object" && right.kind === "object") {
    return (byCodePoint(left.row.objectKind, right.row.objectKind) || byCodePoint(left.row.objectId, right.row.objectId)) * direction;
  }
  if (left.kind === "conversation" && right.kind === "conversation") {
    return channelService.inboxItemIdentity(left.item).localeCompare(channelService.inboxItemIdentity(right.item)) * direction;
  }
  return 0;
}

/**
 * Activity filtered to one app (`scope=<app id>`, e.g. the Artifacts filter):
 * these kinds' object rows only, no conversation rows, in the merged list's
 * order, paged the same way. The conversation counts are zero (this list has
 * none); the object counts are these kinds'. A server without them on lists nothing.
 */
export async function getObjectKindInboxItems(reader: AppWebReader, kinds: readonly string[], opts: {
  filter?: channelService.InboxItemsQuery["filter"];
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
  historyCutoff?: Date;
}): Promise<ActivityInboxResult> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const empty: ActivityInboxResult = { items: [], groups: [], hasMore: false, totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0 };
  const page = await readObjectActivityPage(reader.serverId, reader.userId, {
    filter: opts.filter ?? "all",
    needed: offset + limit + 1,
    sort: opts.sort,
    historyCutoff: opts.historyCutoff,
    onlyKinds: kinds,
  });
  if (!page) return { ...empty, objectCount: 0, objectUnreadCount: 0, objectMentionUnreadCount: 0 };
  const shown = page.rows.slice(offset, offset + limit);
  const built = await objectInboxItems(reader, shown);
  const builtOf = new Map(built.map((item) => [objectRowIdentity(item), item]));
  return {
    ...empty,
    // A row whose newest event is already gone (retention) is left out of the page.
    items: shown.flatMap((row) => {
      const item = builtOf.get(objectRowIdentity(row));
      return item ? [item] : [];
    }),
    hasMore: page.rows.length > offset + limit,
    objectCount: page.objectCount,
    objectUnreadCount: page.objectUnreadCount,
    objectMentionUnreadCount: page.objectMentionUnreadCount,
  };
}

/** An Activity page for the reader in its server, object rows merged in (see the header). */
export async function getActivityInboxItems(reader: AppWebReader, opts: channelService.InboxItemsQuery): Promise<ActivityInboxResult> {
  const filter = opts.filter ?? "all";
  const listsObjects = !opts.q && !opts.channelId && !opts.scope && opts.pinnedChannelIds === undefined && opts.rowIds === undefined;
  // As readInboxItems clamps them.
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), Math.max(opts.internalLimitCap ?? 100, 1));
  const offset = Math.max(opts.offset ?? 0, 0);
  const needed = listsObjects ? offset + limit + 1 : 0;
  const page = await readObjectActivityPage(reader.serverId, reader.userId, { filter, needed, sort: opts.sort, historyCutoff: opts.historyCutoff });
  // No object app on: exactly today's answer.
  if (!page) return channelService.getInboxItems(reader.serverId, reader.userId, opts);
  const fields: ObjectInboxFields = {
    objectUnreadCount: page.objectUnreadCount,
    objectMentionUnreadCount: page.objectMentionUnreadCount,
    objectCount: listsObjects ? page.objectCount : 0,
  };
  if (page.rows.length === 0) return { ...(await channelService.getInboxItems(reader.serverId, reader.userId, opts)), ...fields };

  const conversations = await channelService.getInboxItems(reader.serverId, reader.userId, {
    ...opts,
    offset: 0,
    limit: needed,
    internalLimitCap: needed,
  });
  const merged: Entry[] = [
    ...conversations.items.map((item): Entry => ({ kind: "conversation", item })),
    ...page.rows.map((row): Entry => ({ kind: "object", row })),
  ].sort((left, right) => compareEntries(left, right, opts.sort));
  const shown = merged.slice(offset, offset + limit);
  const built = await objectInboxItems(reader, shown.flatMap((entry) => (entry.kind === "object" ? [entry.row] : [])));
  const builtOf = new Map(built.map((item) => [objectRowIdentity(item), item]));
  return {
    ...conversations,
    // A row whose newest event is already gone (retention) is left out of the page.
    items: shown.flatMap((entry): ActivityInboxItem[] => {
      if (entry.kind === "conversation") return [entry.item];
      const item = builtOf.get(objectRowIdentity(entry.row));
      return item ? [item] : [];
    }),
    hasMore: conversations.hasMore || merged.length > offset + limit,
    ...fields,
  };
}
