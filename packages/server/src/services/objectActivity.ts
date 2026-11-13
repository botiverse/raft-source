/**
 * Core read side of people's Activity rows for first-party objects (S6,
 * first-party app mechanism §四; shared activityObjectsContract.ts). The rows
 * are `object_inbox_states` (objectInboxStates.ts writes them with each
 * object event); this file reads them for the Activity list, its badge and
 * the Done / read routes. Platform-generic: kinds come from the app registry
 * and everything an app knows comes from its registration's hooks
 * (`summarize`, `unreadFor`, `activityDetails`, `markRead`).
 *
 * Which rows a person has in a server: theirs, of a kind whose app is on for
 * the server and that has Activity (`unreadFor`), not Done (an event newer
 * than `done_through_seq`), and whose home the person can see now
 * (platform/visibility visibleHomes, in the same statement; never an orphan).
 * A row is unread when its newest event is past both Done and how far the
 * person has read (`read_through_seq`, which the app reports); it has an
 * unread mention when its newest mention is. Only rows whose newest event is
 * kept count anywhere (inWindow): retention's 90 days, whether or not the
 * hourly prune (objectEventRetention.ts, in bounded batches) has deleted the
 * row yet, so the badge and the list never disagree while it catches up;
 * and on a plan with a history window (Free, 30 days) that window, as for
 * conversation rows.
 *
 * A joint channel's object is, for the other servers' people, a message in
 * that channel (#68): the person's row of another server's object is listed
 * and badged in each of the person's servers it sees the object from through
 * the joint (jointRowsSeen: platform/visibility seenThroughJoint, the rule an
 * app's writes by such a person ask too, so leaving the joint takes the row,
 * the badge and the writes away at once). A row is one per person and
 * object, so reading it in one server reads it in all.
 *
 * The badge (objectActivityUnreadBatch) is the number of unread rows per
 * server: one query over the rows and one for those homed in a joint, then,
 * only for servers with unread rows, the visible homes and one count (and
 * for a joint's rows, jointRowsSeen and one count per server). It never asks an app. The list
 * (readObjectActivityPage) counts the same way and reads the newest rows of a
 * page; objectInboxItems then builds the rows of one page, asking each app
 * once per kind (summaries, unread numbers, details).
 *
 * Cost and where it stops scaling: metrics.ts (objectActivityRowsPerUser,
 * objectActivityFanout).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { currentDate, type ObjectActivityUnread, type ObjectInboxActor, type ObjectInboxHome, type ObjectInboxItem, type ObjectInboxReason, type ObjectSummary, type ServerId } from "@botiverse/raft-shared";
import { firstPartyApps } from "../apps/firstPartyApps";
import { getDb } from "../db/index";
import { channels, objectEventRecipients, objectEvents, objectInboxStates, type ObjectEventData } from "../db/schema";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { objectActivityRowsPerUser } from "../metrics";
import { actorKey, actorNames, type ActorRef } from "../platform/actors";
import type { AppObjectActivityDetail, AppObjectKind, AppObjectUnread, AppWebReader, FirstPartyApp } from "../platform/apps";
import { appEnabledOnCached } from "../platform/flags";
import { localConversationIds } from "../platform/conversations";
import { seenThroughJoint, visibleHomes, type HomeColumns, type VisibleHomes } from "../platform/visibility";
import { getReadableDMPeersForUser } from "./channelService";
import { OBJECT_EVENT_RETENTION_MS } from "./objectEventRetention";
import { visibleObjectsOf } from "./objectSummaries";

/** An object kind with Activity rows, and its app. */
export interface ActivityObjectKind {
  app: FirstPartyApp;
  objectKind: AppObjectKind & Required<Pick<AppObjectKind, "unreadFor">>;
}

/** The registered kinds with Activity (`unreadFor`). */
export function activityObjectKinds(): ActivityObjectKind[] {
  return firstPartyApps().flatMap((app) => app.objectKinds
    .filter((objectKind): objectKind is ActivityObjectKind["objectKind"] => typeof objectKind.unreadFor === "function")
    .map((objectKind) => ({ app, objectKind })));
}

/**
 * The kinds with Activity on for each of these servers (one batched flag
 * evaluation per app, through the short flag cache: these are the inbox's,
 * mark all read's and the badge's, on every request); a server with none is absent. An app whose flag can't
 * be read counts as off (logged): the inbox, mark all read and the badge
 * then answer as before Activity had objects instead of failing.
 */
export async function enabledActivityKinds(serverIds: readonly string[]): Promise<Map<string, ActivityObjectKind[]>> {
  const kinds = activityObjectKinds();
  const enabled = new Map<string, ActivityObjectKind[]>();
  if (kinds.length === 0 || serverIds.length === 0) return enabled;
  const apps = [...new Set(kinds.map((kind) => kind.app))];
  const servers = [...new Set(serverIds)] as ServerId[];
  // fanout-ok: one batched, cached flag read per registered first-party app with Activity kinds (a fixed registry)
  const answers = await Promise.all(apps.map((app) => appEnabledOnCached(servers, app.flag).catch((err: unknown) => {
    console.error(`[object-activity] ${app.flag} flag read failed; treated as off`, err instanceof Error ? err.message : err);
    return servers.map(() => false);
  })));
  apps.forEach((app, appIndex) => {
    servers.forEach((serverId, serverIndex) => {
      if (!answers[appIndex]![serverIndex]) return;
      enabled.set(serverId, [...(enabled.get(serverId) ?? []), ...kinds.filter((kind) => kind.app === app)]);
    });
  });
  return enabled;
}

// ---- the rows' conditions --------------------------------------------------------

const S_COLUMNS: HomeColumns = { serverId: sql`s.server_id`, homeKind: sql`s.home_kind`, homeChannelId: sql`s.home_channel_id` };
const ACTIVE = sql`(s.done_through_seq IS NULL OR s.last_event_seq > s.done_through_seq)`;
const READ_FRONTIER = sql`GREATEST(COALESCE(s.done_through_seq, 0), COALESCE(s.read_through_seq, 0))`;
const UNREAD = sql`(s.last_event_seq > ${READ_FRONTIER})`;
const MENTION_SINCE_DONE = sql`(COALESCE(s.last_mention_seq, 0) > COALESCE(s.done_through_seq, 0))`;
const UNREAD_MENTION = sql`(COALESCE(s.last_mention_seq, 0) > ${READ_FRONTIER})`;

const textList = (values: readonly string[]): SQL => sql.join(values.map((value) => sql`${value}`), sql`, `);

/** The home columns' condition for each of these kinds' rows, under its own app's flag (platform/visibility visibleHomes). */
const visibleKinds = (homes: VisibleHomes, kinds: readonly ActivityObjectKind[]): SQL =>
  sql`(${sql.join(kinds.map((kind) => sql`(s.object_kind = ${kind.objectKind.kind} AND ${homes.sql(S_COLUMNS, { appFlag: kind.app.flag })})`), sql` OR `)})`;

/** How many servers' visible homes the badge reads at once (each is several queries; a person may be in many servers). */
const BADGE_HOMES_CONCURRENCY = 4;

/** The visible homes of a person in one server, read for the flags of these kinds' apps. */
const homesFor = (userId: string, serverId: string, kinds: readonly ActivityObjectKind[]): Promise<VisibleHomes> =>
  visibleHomes({ type: "user", id: userId, serverId: serverId as ServerId }, { appFlags: [...new Set(kinds.map((kind) => kind.app.flag))] });

/** Rows of these kinds in this server. */
const inServerKinds = (serverId: string, kinds: readonly ActivityObjectKind[]): SQL =>
  sql`(s.server_id = ${serverId}::uuid AND s.object_kind IN (${textList(kinds.map((kind) => kind.objectKind.kind))}))`;

/**
 * The row's home is a joint channel (its canonical channel or a projection of
 * it): a cheap first cut before jointRowsSeen decides who sees it from where.
 * Correlated, so each of the person's rows is one index probe
 * (idx_joint_channels_canonical, idx_joint_channel_servers_local_channel)
 * and the cost follows their own rows, not how many joints exist (Tenny's
 * EXPLAIN on #12390: 0.7 ms against 22-26 ms for an IN over both tables).
 */
const JOINT_HOMED = sql`(s.home_kind = 'conversation' AND (
  EXISTS (SELECT 1 FROM joint_channels jc WHERE jc.canonical_channel_id = s.home_channel_id AND jc.status = 'active')
  OR EXISTS (SELECT 1 FROM joint_channel_servers js WHERE js.local_channel_id = s.home_channel_id)))`;

/** A row by its object (jointRowsSeen's answer). */
interface RowObject { objectKind: string; objectId: string }

/** These rows, by their objects; FALSE for none. */
const rowsOf = (objects: readonly RowObject[]): SQL => objects.length === 0
  ? sql`FALSE`
  : sql`((s.object_kind, s.object_id) IN (${sql.join(objects.map((object) => sql`(${object.objectKind}, ${object.objectId})`), sql`, `)}))`;

/**
 * Of the person's rows of these kinds' objects of other servers homed in a
 * conversation (`rows`, else all of them), those whose object it sees from
 * `serverId` through a joint channel (platform/visibility seenThroughJoint,
 * with each object's home as its app reports it now): the rows of another
 * server listed and badged in this one. One query for the rows, then per
 * kind its homes and seenThroughJoint's few.
 */
async function jointRowsSeen(userId: string, serverId: string, kinds: readonly ActivityObjectKind[], rows?: readonly RowObject[]): Promise<RowObject[]> {
  if (kinds.length === 0) return [];
  const candidates = rows ?? (await getDb().execute(sql`
    SELECT s.object_kind AS "objectKind", s.object_id AS "objectId"
    FROM object_inbox_states s
    WHERE s.user_id = ${userId}::uuid AND s.server_id <> ${serverId}::uuid AND ${JOINT_HOMED}
      AND s.object_kind IN (${textList(kinds.map((kind) => kind.objectKind.kind))})`)).rows as unknown as RowObject[];
  if (candidates.length === 0) return [];
  const viewer = { type: "user" as const, id: userId, serverId: serverId as ServerId };
  // fanout-ok: one entry per object kind among the rows (bounded by the registered kinds), each batched
  const seen = await Promise.all(kinds.map(async (kind) => {
    const ids = [...new Set(candidates.filter((row) => row.objectKind === kind.objectKind.kind).map((row) => String(row.objectId)))];
    if (ids.length === 0) return [];
    const homes = await kind.objectKind.homes(ids);
    const located = ids.flatMap((id) => {
      const home = homes.get(id);
      return home ? [{ id, serverId: home.serverId, homeKind: home.homeKind, homeChannelId: home.homeChannelId, author: home.author }] : [];
    });
    const through = await seenThroughJoint(viewer, located, kind.app.flag);
    return ids.filter((id) => through.has(id)).map((objectId) => ({ objectKind: kind.objectKind.kind, objectId }));
  }));
  return seen.flat();
}

/**
 * Rows whose newest event is kept (see the header): inside retention (the
 * prune deletes rows older than its cutoff, so what it hasn't reached yet
 * is left out the same way) and, when the server's plan has a history
 * window (`historyCutoff`, planService.getHistoryCutoff), after its cutoff,
 * as a message is inside the window when created after it (historyWindow.ts).
 */
function inWindow(historyCutoff: Date | undefined): SQL {
  const retained = new Date(currentDate().getTime() - OBJECT_EVENT_RETENTION_MS);
  return historyCutoff && historyCutoff.getTime() >= retained.getTime()
    ? sql`s.last_event_at > ${historyCutoff.toISOString()}::timestamptz`
    : sql`s.last_event_at >= ${retained.toISOString()}::timestamptz`;
}

/** The Activity filters object rows are listed for, and the condition of each. */
export type ObjectActivityFilter = "all" | "unread" | "mentions" | "unread_mentions";
const FILTERS: Record<ObjectActivityFilter, SQL> = {
  all: sql`TRUE`,
  unread: UNREAD,
  mentions: MENTION_SINCE_DONE,
  unread_mentions: UNREAD_MENTION,
};

// ---- the badge ---------------------------------------------------------------------

/**
 * The number of unread object rows the person has in each of these servers
 * that has an object app on (a server with none is absent: its answer is as
 * before Activity had objects); `historyCutoff`: the server's plan's history
 * window, if any. Never asks an app: one query over the person's rows, and
 * only for servers with unread rows their visible homes and one count. Equal
 * to readObjectActivityPage's `objectUnreadCount` for each server.
 */
export async function objectActivityUnreadBatch(servers: ReadonlyArray<{ serverId: string; historyCutoff?: Date }>, userId: string): Promise<Map<string, number>> {
  const enabled = await enabledActivityKinds(servers.map((server) => server.serverId));
  const counts = new Map<string, number>([...enabled.keys()].map((serverId) => [serverId, 0]));
  if (enabled.size === 0) return counts;
  const cutoffOf = new Map(servers.map((server) => [server.serverId, server.historyCutoff]));
  const inServer = (serverId: string) => sql`(${inServerKinds(serverId, enabled.get(serverId)!)} AND ${inWindow(cutoffOf.get(serverId))})`;
  const scope = sql.join([...enabled.keys()].map(inServer), sql` OR `);
  const db = getDb();
  const candidates = (await db.execute(sql`
    SELECT s.server_id AS "serverId", count(*)::int AS "rows", (count(*) FILTER (WHERE ${UNREAD}))::int AS "unread"
    FROM object_inbox_states s
    WHERE s.user_id = ${userId}::uuid AND (${scope})
    GROUP BY s.server_id`)).rows as Array<{ serverId: string; rows: number; unread: number }>;
  objectActivityRowsPerUser.observe({ surface: "badge" }, candidates.reduce((sum, row) => sum + Number(row.rows), 0));
  const unreadServers = candidates.filter((row) => Number(row.unread) > 0).map((row) => String(row.serverId));
  // Unread rows of objects homed in a joint: they may count in another of the person's servers (jointRowsSeen).
  const jointUnread = (await db.execute(sql`
    SELECT s.server_id AS "serverId", s.object_kind AS "objectKind", s.object_id AS "objectId"
    FROM object_inbox_states s
    WHERE s.user_id = ${userId}::uuid AND ${JOINT_HOMED} AND ${UNREAD}`)).rows as Array<{ serverId: string; objectKind: string; objectId: string }>;
  const jointAsked = [...enabled.keys()].filter((serverId) => jointUnread.some((row) => String(row.serverId) !== serverId));
  if (unreadServers.length === 0 && jointAsked.length === 0) return counts;
  const visible = await mapWithConcurrency(unreadServers, BADGE_HOMES_CONCURRENCY, async (serverId) => {
    const kinds = enabled.get(serverId)!;
    const homes = await homesFor(userId, serverId, kinds);
    return sql`(${inServer(serverId)} AND ${visibleKinds(homes, kinds)})`;
  });
  if (visible.length > 0) {
    const rows = (await db.execute(sql`
      SELECT s.server_id AS "serverId", count(*)::int AS "unread"
      FROM object_inbox_states s
      WHERE s.user_id = ${userId}::uuid AND ${UNREAD} AND (${sql.join(visible, sql` OR `)})
      GROUP BY s.server_id`)).rows as Array<{ serverId: string; unread: number }>;
    for (const row of rows) counts.set(String(row.serverId), Number(row.unread));
  }
  // Another server's joint rows, in each server the person sees them from.
  await mapWithConcurrency(jointAsked, BADGE_HOMES_CONCURRENCY, async (serverId) => {
    const kinds = enabled.get(serverId)!;
    const seen = await jointRowsSeen(userId, serverId, kinds, jointUnread.filter((row) => String(row.serverId) !== serverId));
    if (seen.length === 0) return;
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS "unread"
      FROM object_inbox_states s
      WHERE s.user_id = ${userId}::uuid AND ${UNREAD} AND ${rowsOf(seen)} AND ${inWindow(cutoffOf.get(serverId))}`)).rows as Array<{ unread: number }>;
    counts.set(serverId, (counts.get(serverId) ?? 0) + Number(row?.unread ?? 0));
  });
  return counts;
}

// ---- the list ----------------------------------------------------------------------

/** A row as the list reads it. */
export interface ObjectActivityRow {
  objectKind: string;
  objectId: string;
  serverId: string;
  homeKind: "conversation" | "server" | "public";
  homeChannelId: string | null;
  lastEventId: string;
  lastEventSeq: number;
  lastEventAt: Date;
  /**
   * `last_event_at` to the microsecond (ISO 8601, UTC), the list's sort key:
   * the page is read in this order, so the merge with conversation rows must
   * sort by it too, not by `lastEventAt` (milliseconds).
   */
  activityKey: string;
  unread: boolean;
  unreadMention: boolean;
}

export interface ObjectActivityPage {
  /** The newest `needed` rows matching the filter (oldest first when `sort` is asc). */
  rows: ObjectActivityRow[];
  /** How many rows match the filter. */
  objectCount: number;
  /** How many rows are unread, whatever the filter (the badge's number for this server). */
  objectUnreadCount: number;
  /** How many of the rows the `mentions` filter lists are unread, whatever the filter. */
  objectMentionUnreadCount: number;
}

/**
 * The person's object rows in one server for an Activity page: counts and
 * the first `needed` rows matching `filter` in `sort` order (none when
 * `needed` is 0). Null when no object app is on for the server (Activity is
 * then as before). Two queries after the visible homes, all the counts in
 * the first; the second only when a row is needed and one matches.
 */
export async function readObjectActivityPage(serverId: string, userId: string, opts: {
  filter: ObjectActivityFilter;
  needed: number;
  sort?: "asc" | "desc";
  /** The server's plan's history window, if any. */
  historyCutoff?: Date;
  /** Only these kinds, by name (`object_kind`, Activity's Artifacts filter); default, every kind on for the server. */
  onlyKinds?: readonly string[];
}): Promise<ObjectActivityPage | null> {
  const enabled = (await enabledActivityKinds([serverId])).get(serverId);
  if (!enabled) return null;
  const kinds = opts.onlyKinds ? enabled.filter((kind) => opts.onlyKinds!.includes(kind.objectKind.kind)) : enabled;
  if (kinds.length === 0) return { rows: [], objectCount: 0, objectUnreadCount: 0, objectMentionUnreadCount: 0 };
  const [homes, joint] = await Promise.all([homesFor(userId, serverId, kinds), jointRowsSeen(userId, serverId, kinds)]);
  // The server's own rows, and another server's that it sees through a joint (jointRowsSeen, which decided their sight).
  const mine = sql`s.user_id = ${userId}::uuid AND (${inServerKinds(serverId, kinds)} OR ${rowsOf(joint)}) AND ${inWindow(opts.historyCutoff)}`;
  const listed = sql`${ACTIVE} AND (s.server_id <> ${serverId}::uuid OR ${visibleKinds(homes, kinds)})`;
  const filter = FILTERS[opts.filter];
  const db = getDb();
  const [counts] = (await db.execute(sql`
    SELECT count(*)::int AS "rows",
      (count(*) FILTER (WHERE ${listed} AND ${filter}))::int AS "matching",
      (count(*) FILTER (WHERE ${listed} AND ${UNREAD}))::int AS "unread",
      (count(*) FILTER (WHERE ${listed} AND ${FILTERS.mentions} AND ${UNREAD}))::int AS "mentionUnread"
    FROM object_inbox_states s
    WHERE ${mine}`)).rows as Array<{ rows: number; matching: number; unread: number; mentionUnread: number }>;
  objectActivityRowsPerUser.observe({ surface: "list" }, Number(counts?.rows ?? 0));
  const page: ObjectActivityPage = {
    rows: [],
    objectCount: Number(counts?.matching ?? 0),
    objectUnreadCount: Number(counts?.unread ?? 0),
    objectMentionUnreadCount: Number(counts?.mentionUnread ?? 0),
  };
  if (opts.needed <= 0 || page.objectCount === 0) return page;
  const direction = opts.sort === "asc" ? sql`ASC` : sql`DESC`;
  const rows = (await db.execute(sql`
    SELECT s.object_kind AS "objectKind", s.object_id AS "objectId", s.server_id AS "serverId",
      s.home_kind AS "homeKind", s.home_channel_id AS "homeChannelId",
      s.last_event_id AS "lastEventId", s.last_event_seq AS "lastEventSeq", s.last_event_at AS "lastEventAt",
      to_char(s.last_event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "activityKey",
      ${UNREAD} AS "unread", ${UNREAD_MENTION} AS "unreadMention"
    FROM object_inbox_states s
    WHERE ${mine} AND ${listed} AND ${filter}
    ORDER BY s.last_event_at ${direction}, s.object_kind COLLATE "C" ${direction}, s.object_id COLLATE "C" ${direction}
    LIMIT ${opts.needed}`)).rows as Array<Record<string, unknown>>;
  page.rows = rows.map((row) => ({
    objectKind: String(row.objectKind),
    objectId: String(row.objectId),
    serverId: String(row.serverId),
    homeKind: row.homeKind as ObjectActivityRow["homeKind"],
    homeChannelId: row.homeChannelId === null ? null : String(row.homeChannelId),
    lastEventId: String(row.lastEventId),
    lastEventSeq: Number(row.lastEventSeq),
    lastEventAt: row.lastEventAt instanceof Date ? row.lastEventAt : new Date(String(row.lastEventAt)),
    activityKey: String(row.activityKey),
    unread: row.unread === true,
    unreadMention: row.unreadMention === true,
  }));
  return page;
}

/** A row's identity, as the list merges it with conversation rows. */
export const objectRowIdentity = (row: { objectKind: string; objectId: string }): string => `object:${row.objectKind}:${row.objectId}`;

// ---- one page's rows ---------------------------------------------------------------

/**
 * The ObjectInboxItems of a page's rows, in their order; a row whose newest
 * event is gone (retention) is left out. A constant number of queries:
 * the newest events and the reader's reason, names, the homes' conversations
 * and DM labels; and each app once per kind: summarize, unreadFor and
 * activityDetails, in parallel.
 */
export async function objectInboxItems(reader: AppWebReader, rows: readonly ObjectActivityRow[]): Promise<ObjectInboxItem[]> {
  if (rows.length === 0) return [];
  const db = getDb();
  const events = await db
    .select({
      id: objectEvents.id,
      eventKind: objectEvents.eventKind,
      actorType: objectEvents.actorType,
      actorId: objectEvents.actorId,
      data: objectEvents.data,
      createdAt: objectEvents.createdAt,
      reason: objectEventRecipients.reason,
    })
    .from(objectEvents)
    .leftJoin(objectEventRecipients, and(
      eq(objectEventRecipients.eventId, objectEvents.id),
      eq(objectEventRecipients.recipientType, "user"),
      eq(objectEventRecipients.recipientId, reader.userId),
    ))
    .where(inArray(objectEvents.id, rows.map((row) => row.lastEventId)));
  const eventOf = new Map(events.map((event) => [event.id, event]));
  const kept = rows.filter((row) => eventOf.has(row.lastEventId));

  const byKind = new Map<string, ObjectActivityRow[]>();
  for (const row of kept) byKind.set(row.objectKind, [...(byKind.get(row.objectKind) ?? []), row]);
  const kinds = new Map(activityObjectKinds().map((kind) => [kind.objectKind.kind, kind]));
  type KindAnswers = { summaries: Map<string, ObjectSummary>; unread: ReadonlyMap<string, AppObjectUnread>; details: ReadonlyMap<string, AppObjectActivityDetail> };
  // fanout-ok: one entry per object kind on the page (bounded by the registered kinds; an unregistered one does no I/O), each batched over its rows
  const answers = new Map<string, KindAnswers>(await Promise.all([...byKind].map(async ([kind, kindRows]): Promise<[string, KindAnswers]> => {
    const registered = kinds.get(kind);
    if (!registered) return [kind, { summaries: new Map(), unread: new Map(), details: new Map() }];
    const { objectKind } = registered;
    const ids = kindRows.map((row) => row.objectId);
    const refs = ids.flatMap((id) => {
      const ref = objectKind.parseRef({ id });
      return ref && ref.id === id ? [ref] : [];
    });
    const [summaryList, unread, details] = await Promise.all([
      refs.length > 0 ? objectKind.summarize(reader, refs) : Promise.resolve([]),
      objectKind.unreadFor(reader, ids),
      objectKind.activityDetails
        ? objectKind.activityDetails(reader, kindRows.map((row) => {
          const event = eventOf.get(row.lastEventId)!;
          return { id: row.objectId, latest: { eventKind: event.eventKind, data: event.data as ObjectEventData } };
        }))
        : Promise.resolve(new Map<string, AppObjectActivityDetail>()),
    ]);
    if (summaryList.length !== refs.length) throw new Error(`${kind} summarize answered ${summaryList.length} entries for ${refs.length} references`);
    const summaries = new Map<string, ObjectSummary>();
    refs.forEach((ref, index) => {
      const summary = summaryList[index];
      if (summary) summaries.set(ref.id, summary);
    });
    return [kind, { summaries, unread, details }];
  })));

  const actors: ActorRef[] = [];
  for (const event of events) actors.push({ type: event.actorType, id: event.actorId });
  for (const kindAnswers of answers.values()) {
    for (const detail of kindAnswers.details.values()) if (detail.preview) actors.push(detail.preview.author);
  }
  const [names, homes] = await Promise.all([actorNames(actors), homeLabels(reader, kept)]);
  const actorOf = (actor: ActorRef): ObjectInboxActor => ({ type: actor.type, id: actor.id, name: names.get(actorKey(actor)) ?? null });

  return kept.map((row): ObjectInboxItem => {
    const event = eventOf.get(row.lastEventId)!;
    const kindAnswers = answers.get(row.objectKind)!;
    const unread = kindAnswers.unread.get(row.objectId);
    const detail = kindAnswers.details.get(row.objectId);
    const at = event.createdAt.toISOString();
    return {
      kind: "object",
      objectKind: row.objectKind,
      objectId: row.objectId,
      summary: kindAnswers.summaries.get(row.objectId) ?? null,
      home: homes(row),
      latestEvent: {
        eventKind: event.eventKind,
        // The row's newest event always lists the person (it moved the row); "following" only if the recipient row is gone.
        reason: (event.reason ?? "following") as ObjectInboxReason,
        actor: actorOf({ type: event.actorType, id: event.actorId }),
        at,
      },
      preview: detail?.preview
        ? {
          text: detail.preview.text,
          truncated: detail.preview.truncated,
          author: actorOf(detail.preview.author),
          at: detail.preview.at.toISOString(),
          ...(detail.preview.images ? { images: detail.preview.images } : {}),
        }
        : null,
      target: detail?.target ?? null,
      // Unread is core's (the badge counts it the same way); the app numbers it, at least 1.
      unreadCount: row.unread ? Math.max(1, unread?.unread ?? 0) : 0,
      // The same count by part (the app's split), all zero once the row is read, as unreadCount is.
      ...(unread?.parts ? { unreadParts: row.unread ? unread.parts : zeroParts(unread.parts) } : {}),
      hasMention: row.unreadMention,
      isFollowing: unread?.following ?? false,
      lastActivityAt: at,
      doneFrontierSeq: String(row.lastEventSeq),
    } as ObjectInboxItem;
  });
}

/** A kind's unread parts, each zero (a read row's). */
const zeroParts = (parts: ObjectActivityUnread): ObjectActivityUnread =>
  Object.fromEntries(Object.keys(parts).map((key) => [key, 0])) as unknown as ObjectActivityUnread;

/** The homes of these rows as the reader sees them: one query for the conversations, one for DM peers (handle and display name, as the sidebar). */
async function homeLabels(reader: AppWebReader, rows: readonly ObjectActivityRow[]): Promise<(row: ObjectActivityRow) => ObjectInboxHome> {
  // Another server's joint home as the reader's server has it: its projection there (a joint message's row is the reader's channel).
  const foreign = [...new Set(rows.flatMap((row) => (row.serverId !== reader.serverId && row.homeKind === "conversation" && row.homeChannelId ? [row.homeChannelId] : [])))];
  const localOf = foreign.length > 0 ? await localConversationIds(reader.serverId as ServerId, foreign) : new Map<string, string>();
  const shownHome = (row: ObjectActivityRow): string | null => (row.serverId !== reader.serverId && row.homeChannelId ? localOf.get(row.homeChannelId) ?? null : row.homeChannelId);
  const channelIds = [...new Set(rows.flatMap((row) => {
    const shown = row.homeKind === "conversation" ? shownHome(row) : null;
    return shown ? [shown] : [];
  }))];
  const conversations = channelIds.length > 0
    ? await getDb().select({ id: channels.id, name: channels.name, type: channels.type, deletedAt: channels.deletedAt }).from(channels).where(inArray(channels.id, channelIds))
    : [];
  const dmPeers = await getReadableDMPeersForUser(conversations.filter((row) => row.type === "dm").map((row) => row.id), reader.userId);
  const conversationOf = new Map(conversations.map((row) => [row.id, row]));
  return (row) => {
    if (row.homeKind === "server") return { kind: "server", label: null, channelId: null };
    if (row.homeKind === "public") return { kind: "public", label: null, channelId: null };
    const shown = shownHome(row);
    const conversation = shown ? conversationOf.get(shown) : undefined;
    if (!conversation || conversation.deletedAt) return { kind: "orphan", label: null, channelId: null };
    if (conversation.type === "dm") {
      const peer = dmPeers.get(conversation.id);
      return { kind: "dm", label: peer?.name ?? conversation.name, channelId: conversation.id, ...(peer?.displayName ? { peerDisplayName: peer.displayName } : {}) };
    }
    return { kind: "channel", label: conversation.name, channelId: conversation.id };
  };
}

// ---- Done, undo, read ------------------------------------------------------------------

export type ObjectActivityWriteOutcome = "ok" | "not_found" | "beyond_latest";

/**
 * The person's row for the object, if they can see it now from the reader's
 * server: one of that server's by core's by-id rule (orphans included),
 * another server's through a joint (jointRowsSeen), as the list has it.
 */
async function visibleRow(reader: AppWebReader, kind: ActivityObjectKind, objectId: string) {
  const [row] = await getDb().select().from(objectInboxStates).where(and(
    eq(objectInboxStates.userId, reader.userId),
    eq(objectInboxStates.objectKind, kind.objectKind.kind),
    eq(objectInboxStates.objectId, objectId),
  )).limit(1);
  if (!row) return null;
  if (row.serverId !== reader.serverId) {
    const seen = row.homeKind === "conversation" ? await jointRowsSeen(reader.userId, reader.serverId, [kind], [{ objectKind: row.objectKind, objectId }]) : [];
    return seen.length > 0 ? row : null;
  }
  const visible = await visibleObjectsOf({ type: "user", id: reader.userId, serverId: reader.serverId }, kind, [objectId]);
  return visible.has(objectId) ? row : null;
}

/** The data of the newest event of the object at or before `seq` (what Done marks read through). */
async function eventDataThrough(kind: string, objectId: string, seq: number): Promise<ObjectEventData | null> {
  const [event] = await getDb().select({ data: objectEvents.data }).from(objectEvents).where(and(
    eq(objectEvents.objectKind, kind),
    eq(objectEvents.objectId, objectId),
    sql`${objectEvents.seq} <= ${seq}`,
  )).orderBy(sql`${objectEvents.seq} DESC`).limit(1);
  return event ? event.data : null;
}

/**
 * Done: the row is hidden until an event newer than `throughSeq` (default:
 * its newest), and the object is marked read through that event (the app's
 * markRead; Done reads, as a conversation's Done moves its read cursor), in
 * one transaction: if the app's read fails, the row is not Done either.
 * `beyond_latest` for a frontier past the row's newest event.
 */
export async function markObjectActivityDone(reader: AppWebReader, kind: ActivityObjectKind, objectId: string, throughSeq: number | undefined): Promise<ObjectActivityWriteOutcome> {
  const row = await visibleRow(reader, kind, objectId);
  if (!row) return "not_found";
  const through = throughSeq ?? row.lastEventSeq;
  if (through > row.lastEventSeq) return "beyond_latest";
  const throughData = kind.objectKind.markRead ? await eventDataThrough(kind.objectKind.kind, objectId, through) : null;
  // One transaction: the row is Done only if the app's read moved too.
  await getDb().transaction(async (tx) => {
    await tx.update(objectInboxStates).set({
      doneThroughSeq: sql`GREATEST(COALESCE(${objectInboxStates.doneThroughSeq}, 0), ${through})`,
      doneAt: sql`now()`,
      updatedAt: sql`now()`,
    }).where(and(
      eq(objectInboxStates.userId, reader.userId),
      eq(objectInboxStates.objectKind, kind.objectKind.kind),
      eq(objectInboxStates.objectId, objectId),
    ));
    // A frontier before the object's first event read nothing (null would read everything).
    if (kind.objectKind.markRead && throughData) await kind.objectKind.markRead(reader, [{ id: objectId, through: throughData }], tx);
  });
  return "ok";
}

/** Undo Done: the row shows again while its events are kept. */
export async function markObjectActivityUndone(reader: AppWebReader, kind: ActivityObjectKind, objectId: string): Promise<ObjectActivityWriteOutcome> {
  const row = await visibleRow(reader, kind, objectId);
  if (!row) return "not_found";
  await getDb().update(objectInboxStates).set({ doneThroughSeq: null, doneAt: null, updatedAt: sql`now()` }).where(and(
    eq(objectInboxStates.userId, reader.userId),
    eq(objectInboxStates.objectKind, kind.objectKind.kind),
    eq(objectInboxStates.objectId, objectId),
  ));
  return "ok";
}

/**
 * Mark the object read (the app moves its read position and reports it back):
 * through the event `throughSeq` (what the row showed when the person saw it,
 * so a later event, a new version say, stays unread), or everything now.
 */
export async function markObjectActivityRead(reader: AppWebReader, kind: ActivityObjectKind, objectId: string, throughSeq?: number): Promise<ObjectActivityWriteOutcome> {
  const row = await visibleRow(reader, kind, objectId);
  if (!row) return "not_found";
  if (throughSeq !== undefined && throughSeq > row.lastEventSeq) return "beyond_latest";
  const { markRead } = kind.objectKind;
  if (!markRead) return "ok";
  const through = throughSeq === undefined ? null : await eventDataThrough(kind.objectKind.kind, objectId, throughSeq);
  // A frontier before the object's first event has nothing to read (null would read everything).
  if (throughSeq !== undefined && !through) return "ok";
  await getDb().transaction((tx) => markRead(reader, [{ id: objectId, through }], tx));
  return "ok";
}

/**
 * Mark all read (Activity's "mark all read", for one server): every unread
 * object row the person sees there, through each app's markRead once per
 * kind. Returns how many rows it marked; 0 when no object app is on.
 */
export async function markAllObjectActivityRead(reader: AppWebReader): Promise<number> {
  const kinds = (await enabledActivityKinds([reader.serverId])).get(reader.serverId);
  if (!kinds) return 0;
  const [homes, joint] = await Promise.all([homesFor(reader.userId, reader.serverId, kinds), jointRowsSeen(reader.userId, reader.serverId, kinds)]);
  const rows = (await getDb().execute(sql`
    SELECT s.object_kind AS "objectKind", s.object_id AS "objectId"
    FROM object_inbox_states s
    WHERE s.user_id = ${reader.userId}::uuid AND ${UNREAD}
      AND ((${inServerKinds(reader.serverId, kinds)} AND ${visibleKinds(homes, kinds)}) OR ${rowsOf(joint)})`)).rows as Array<{ objectKind: string; objectId: string }>;
  await getDb().transaction(async (tx) => {
    for (const kind of kinds) {
      const ids = rows.filter((row) => row.objectKind === kind.objectKind.kind).map((row) => String(row.objectId));
      if (ids.length > 0 && kind.objectKind.markRead) await kind.objectKind.markRead(reader, ids.map((id) => ({ id, through: null })), tx);
    }
  });
  return rows.length;
}
