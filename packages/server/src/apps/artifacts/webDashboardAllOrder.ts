// The All tab's order (webDashboard.ts `dashboardAll`, `sort` and `dir`):
// what each sort orders by, as SQL for the one statement that also holds
// visibility, the filters and the LIMIT, and its keyset cursor.
//
// Every sort is the card's own value (webCards.ts cardsOf), then the item's
// id in the same direction:
// - `updated`: the card's `updatedAt` (items.updated_at) at millisecond
//   precision (search.ts updatedMs, the precision a cursor carries);
// - `title`: the card's `title` (items.title), lower(): any case, in the
//   database's collation;
// - `comments`: the card's `commentCount` (artifactCardFacts): the item's
//   comments with deleted_at null, none for a reader who reads it as an
//   outsider (accessOf; the All tab lists no such item, as
//   visibleArtifactsSql never lists another server's public ones), counted
//   per row by a LATERAL count over idx_comments_item_position;
// - `opened`: the reader's read position's updated_at (the row's `openedAt`),
//   at millisecond precision, then `updated`. A reader with no read position
//   never opened it: the key is NULL, which a row comparison can't page past
//   (NULL compares as unknown, and the row is lost), so it is COALESCEd past
//   every time on the side the direction ends at, -infinity going down and
//   infinity going up: never-opened Artifacts come after everything opened
//   in both directions, then by `updated` in that direction.
// - `relevant` (not a `sort`: the `relevant` filter's own order, whatever
//   `sort` says): what has news for the reader first, and among it what is
//   waiting on them (news.mentions) first; then `updated`, all descending. One
//   key, the tier (the segment): 2 waiting, 1 other news, 0 none (read, or
//   nothing new). It needs the statement to have LEFT JOINed the news as
//   NEWS_ALIAS: on the first page as it is now; on a later page as of the
//   first page's moment (dashboardNewsSql `asOf`, the database's now() then,
//   which the cursor carries), counting only activity made by then and still
//   bounded by the reader's current read position. So news that arrives
//   while someone pages moves nothing up (nothing skipped), and a read
//   between pages can only move an Artifact down: one already listed may come
//   back once further down (the web drops a row it already has, by card id),
//   one not listed yet is listed in the lower segment; never skipped. Its
//   row's `news` is now, as ever. What still moves it is what moves every
//   keyset list here (a new update time, a stopped follow, a deleted comment,
//   a lost view).
//
// The cursor: newest update first (the default, the only order before
// `sort`) keeps the plain list cursor (search.ts encodeListCursor,
// `[updatedAt, id]`), so a page an older or newer replica answered pages on
// either; `opened`, which has two keys, `[sort, dir, key, updatedAt, id]`
// (`key` the opened time or null); `relevant` `[sort, dir, asOf, news,
// waiting, updatedAt, id]` (`asOf` the first page's moment, `news` and
// `waiting` 1 or 0, the segment, never waiting without news; the update and
// id the place in it: seven long, so a cursor of the filter's older order,
// waiting or not in five, is no cursor of this one); every other order
// `[sort, dir, key, id]`, base64url JSON. Each pages only the order it names
// (another order's, either way, is no cursor: 400 INVALID_REQUEST).
import { asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS,
  ARTIFACT_DASHBOARD_ALL_DIRS,
  ARTIFACT_DASHBOARD_ALL_SORTS,
  type ArtifactDashboardAllDir,
  type ArtifactDashboardAllSort,
  type ServerId,
} from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { ARTIFACT_CURSOR_ID } from "./apiCommon";
import { artifactComments, artifactItems, artifactReadPositions, type ArtifactItemRow } from "./schema";
import { decodeListCursor, encodeListCursor, updatedMs } from "./search";
import { refuse } from "./webCommon";

export interface DashboardAllOrder {
  sort: ArtifactDashboardAllSort | "relevant";
  dir: ArtifactDashboardAllDir;
}

/**
 * A page's place in its order: the last row's key (an ISO time, a lower-cased
 * title, a count or `relevant`'s tier; null: never opened), its update time where the order has
 * it as a second key (`opened`, `relevant`) and id.
 */
export interface DashboardAllCursor {
  key: string | number | null;
  updated?: string;
  /** `relevant`: the first page's time, the moment its tiers are as of. */
  asOf?: string;
  id: string;
}

/** The name the statement gives the joined dashboardNewsSql (`relevant` only for the page, LEFT JOINed: what has none comes after; always for the counts). */
export const NEWS_ALIAS = "reader_news";

/** The longest key a title cursor may carry (titles are far shorter; a bound on what is decoded). */
const CURSOR_TITLE_MAX_CHARS = 2000;

const isDefault = (order: DashboardAllOrder) => order.sort === "updated" && order.dir === "desc";

/** An ISO time a cursor may carry (years 1 to 9999, which timestamptz holds), or null when it isn't one. */
function cursorTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return null;
  const year = time.getUTCFullYear();
  return year >= 1 && year <= 9999 ? time.toISOString() : null;
}

/** `sort` and `dir`: absent, or one string of the contract's values; anything else 400 INVALID_REQUEST. `relevant` fixes the order (after they are checked). */
export function parseAllOrder(sort: unknown, dir: unknown, relevant: boolean): DashboardAllOrder {
  if (sort !== undefined && (typeof sort !== "string" || !(ARTIFACT_DASHBOARD_ALL_SORTS as readonly string[]).includes(sort))) {
    refuse(400, { code: "INVALID_REQUEST", error: `This list can't be sorted that way (sort is one of ${ARTIFACT_DASHBOARD_ALL_SORTS.join(", ")}): reload the page and choose the order again.` });
  }
  if (dir !== undefined && (typeof dir !== "string" || !(ARTIFACT_DASHBOARD_ALL_DIRS as readonly string[]).includes(dir))) {
    refuse(400, { code: "INVALID_REQUEST", error: `This list can't be ordered that way (dir is one of ${ARTIFACT_DASHBOARD_ALL_DIRS.join(", ")}): reload the page and choose the order again.` });
  }
  if (relevant) return { sort: "relevant", dir: "desc" };
  const chosen = (sort ?? "updated") as ArtifactDashboardAllSort;
  return { sort: chosen, dir: (dir ?? ARTIFACT_DASHBOARD_ALL_DEFAULT_DIRS[chosen]) as ArtifactDashboardAllDir };
}

/** The cursor of `order`, or null when it doesn't parse or is another order's. */
export function decodeAllCursor(cursor: string, order: DashboardAllOrder): DashboardAllCursor | null {
  if (isDefault(order)) {
    const plain = decodeListCursor(cursor, null);
    return plain ? { key: plain.updatedAt.toISOString(), id: plain.id } : null;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value)) return null;
    if (value.length !== (order.sort === "relevant" ? 7 : order.sort === "opened" ? 5 : 4)) return null;
    const [sort, dir, key] = value as unknown[];
    const id: unknown = value[value.length - 1];
    if (sort !== order.sort || dir !== order.dir || typeof id !== "string" || !ARTIFACT_CURSOR_ID.test(id)) return null;
    switch (order.sort) {
      case "relevant": {
        const [, , moment, news, waiting, at] = value as unknown[];
        const updated = cursorTime(at);
        const asOf = cursorTime(moment);
        if (!updated || !asOf || (news !== 0 && news !== 1) || (waiting !== 0 && waiting !== 1) || waiting > news) return null;
        return { key: news + waiting, updated, asOf, id };
      }
      case "opened": {
        const updated = cursorTime(value[3]);
        if (!updated) return null;
        const opened = key === null ? null : cursorTime(key);
        return key === null || opened ? { key: opened, updated, id } : null;
      }
      case "updated": {
        const time = cursorTime(key);
        return time ? { key: time, id } : null;
      }
      case "title":
        return typeof key === "string" && key.length <= CURSOR_TITLE_MAX_CHARS ? { key, id } : null;
      case "comments":
        return typeof key === "number" && Number.isSafeInteger(key) && key >= 0 ? { key, id } : null;
    }
  } catch {
    return null;
  }
}

/** The next page's cursor from the page's last row (its item, when the reader opened it, and the key the statement selected); `asOf` the moment `relevant`'s tiers were as of. */
export function encodeAllCursor(order: DashboardAllOrder, last: { item: ArtifactItemRow; key: unknown; openedAt: Date | null }, asOf: Date): string {
  if (isDefault(order)) return encodeListCursor(last.item, null);
  if (order.sort === "relevant") {
    const tier = Number(last.key);
    return Buffer.from(JSON.stringify([order.sort, order.dir, asOf.toISOString(), tier > 0 ? 1 : 0, tier > 1 ? 1 : 0, last.item.updatedAt.toISOString(), last.item.id])).toString("base64url");
  }
  if (order.sort === "opened") {
    return Buffer.from(JSON.stringify([order.sort, order.dir, last.openedAt?.toISOString() ?? null, last.item.updatedAt.toISOString(), last.item.id])).toString("base64url");
  }
  const key = order.sort === "updated" ? last.item.updatedAt.toISOString() : order.sort === "title" ? String(last.key) : Number(last.key);
  return Buffer.from(JSON.stringify([order.sort, order.dir, key, last.item.id])).toString("base64url");
}

/**
 * The live comments a card counts, per item (the `comments` sort only): a
 * LATERAL subquery on the statement's unaliased items, one row each.
 */
export function commentCountLateral(readerServerId: ServerId) {
  return getDb()
    .select({ n: sql<number>`count(*)::int`.as("comment_count") })
    .from(artifactComments)
    .where(sql`${eq(artifactComments.itemId, artifactItems.id)} AND ${isNull(artifactComments.deletedAt)}
      AND NOT (${artifactItems.serverId} <> ${readerServerId} AND ${artifactItems.homeKind} = 'public')`)
    .as("card_comments");
}

/**
 * The order as SQL: its key (`n`, the comment count, for `comments`), the
 * condition past `cursor` (undefined: the first page) and ORDER BY, every
 * term in the order's direction, so one row comparison pages them all.
 */
export function allOrderSql(order: DashboardAllOrder, cursor: DashboardAllCursor | null, n: SQL | null): { key: SQL; after: SQL | undefined; orderBy: SQL[] } {
  const by = order.dir === "asc" ? asc : desc;
  const past = order.dir === "asc" ? sql`>` : sql`<`;
  if (order.sort === "opened" || order.sort === "relevant") {
    // Where a NULL open time sorts: past every time, at the end of the direction.
    const neverOpened = sql.raw(order.dir === "asc" ? "'infinity'::timestamptz" : "'-infinity'::timestamptz");
    const opened = order.sort === "opened";
    const key = opened
      ? sql`COALESCE(date_trunc('milliseconds', ${artifactReadPositions.updatedAt}), ${neverOpened})`
      : sql`(CASE WHEN ${sql.raw(NEWS_ALIAS)}.item_id IS NULL THEN 0 WHEN ${sql.raw(NEWS_ALIAS)}.mentions > 0 THEN 2 ELSE 1 END)`;
    let after: SQL | undefined;
    if (cursor) {
      const cursorKey = !opened ? sql`${Number(cursor.key)}::int` : cursor.key === null ? neverOpened : sql`${String(cursor.key)}::timestamptz`;
      after = sql`(${key}, ${updatedMs}, ${artifactItems.id}) ${past} (${cursorKey}, ${cursor.updated}::timestamptz, ${cursor.id})`;
    }
    return { key, after, orderBy: [by(key), by(updatedMs), by(artifactItems.id)] };
  }
  let key: SQL;
  let cursorKey: SQL | null = null;
  switch (order.sort) {
    case "updated":
      key = updatedMs;
      if (cursor) cursorKey = sql`${String(cursor.key)}::timestamptz`;
      break;
    case "title":
      key = sql`lower(${artifactItems.title})`;
      if (cursor) cursorKey = sql`${String(cursor.key)}::text`;
      break;
    case "comments":
      if (!n) throw new Error("allOrderSql: the comments sort needs the count");
      key = n;
      if (cursor) cursorKey = sql`${Number(cursor.key)}::int`;
      break;
  }
  const after = cursor && cursorKey ? sql`(${key}, ${artifactItems.id}) ${past} (${cursorKey}, ${cursor.id})` : undefined;
  return { key, after, orderBy: [by(key), by(artifactItems.id)] };
}
