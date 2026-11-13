// The Artifacts home page (S7): `GET /api/artifacts/dashboard` (every
// section's first page, ArtifactWebDashboard) and
// `GET /api/artifacts/dashboard/:section` (one section's next page), for the
// signed-in reader in the request's server.
//
// It only reads: no read position moves (the viewer moves it) and nothing is
// written. It checks, in order:
// 1. workspace_artifacts_v0 for the reader's server (403 ARTIFACTS_NOT_ENABLED);
// 2. the section (dashboardSection only) and the query: `home` one of
//    ARTIFACT_DASHBOARD_HOMES, `author` (below), `cursor` a page's
//    nextCursor, and only on dashboardSection (400 INVALID_REQUEST).
//
// Who sees what: every row is an Artifact visibleArtifactsSql lets through
// (the list form of canViewArtifacts the viewer uses: the reader's server,
// live, a home the reader can see; visible conversations as one uuid[]),
// with a published current version. The condition is part of each section's
// query, so a section's cap and its cursor count only what the reader can
// see; nothing is filtered afterwards. Orphans (home conversation deleted)
// are not listed, as in the agent API's list; their few readers reach them
// by id. The reader always stands in the server (core's requireServer), and
// all rows are of that server, so comments are never members-only for them.
//
// Sections, each newest first, ARTIFACT_DASHBOARD_PAGE_LIMIT a page, one row
// per Artifact, ordered at millisecond precision (the precision a cursor
// carries) then by id:
// - waiting: live comments that mention the reader (comments.mentions holds
//   `{ type: "user", id }`), by others, after the reader's read position; the
//   newest one and how many;
// - following: Artifacts the reader follows (subscriptions, not stopped)
//   with published versions or live comments by others after the reader's
//   read position; how many of each;
// - recent: Artifacts the reader published a version of (versions.publisher)
//   or opened (read_positions.updated_at), the later of the two.
// A constant number of queries however many rows: the flag, the visible
// homes (visibleArtifactsSql), one query per section asked, the items, their
// current versions, profiles, and the cards' comment counts and
// conversation names (artifactCards).
//
// Paging is by keyset (time, id), so an Artifact with new activity while
// someone pages moves to the top and may be skipped for the rest of that run
// through the pages; it is never listed twice.
//
// Cost: every section starts from the reader's own rows and joins the
// items, with visibleArtifactsSql, only after, so its work follows the
// reader's activity, not the server's size. `waiting`: the comments that
// mention the reader (idx_comments_mentions, GIN jsonb_path_ops;
// containment on the `{ type, id }` shape stored), the unread ones by
// others, grouped per Artifact. `following`: what the reader follows
// (idx_subscriptions_actor). `recent`: what it opened
// (idx_read_positions_actor) and published (idx_versions_publisher).
// Comments and versions of one item come from idx_comments_item_position and
// idx_versions_item_position. Measured with 10k visible Artifacts of 20
// comments each, the reader mentioned on 200 and having opened none
// (PostgreSQL 17; pglite alike): `waiting` 232000 buffers before, about
// 3500 now (582 to 17 ms), `following` about 3400 (it already started from
// the subscriptions, by a sequential scan), `recent` 30500 to 6 (about 30 to
// 3 ms; 1221 buffers, 5 ms, with 50 opened and 50 published).
//
// The All tab (task #115): `GET /api/artifacts/dashboard/all?home=&conversation=&q=&sort=&dir=&relevant=&cursor=`
// (ArtifactWebDashboardAll), every Artifact the reader can see, not only what
// concerns it. Checked in order: the flag (403), then the query (`home` as
// above, `q` one string of at most WEB_SEARCH_QUERY_MAX_CHARS code points once
// trimmed, `sort` and `dir` the contract's values, `relevant` 1 or absent,
// `cursor` a nextCursor of the same order: 400 INVALID_REQUEST). One statement over the items:
// visibleArtifactsSql with the `home` narrowing (the same condition the
// sections use, so the same homes, the reader's guest scope and the joints'
// flags), a readable current version (hasReadableCurrentVersion, as search
// and a conversation's Artifacts), and with `q` Artifacts' title search as
// one condition (search.ts titleMatch: the words the agent list's `query` and
// core's search match). Ordered by the sort's key then id, in its direction
// (webDashboardAllOrder.ts: the update time at millisecond precision, the
// lower-cased title, or the live comments by a LATERAL count in the same
// statement), with a query too (no rank): a keyset cursor of that order,
// whatever the query, since the order does not depend on it; newest update
// first keeps the agent list's plain one (search.ts encodeListCursor).
// ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT a page. Then the cards as the sections
// draw them. Cost, unlike the sections': it follows the server's size, not
// the reader's activity. The page sorts the visible items of the server
// (idx_items_server_home, idx_items_home_channel; no index on updated_at or
// the title), with `q` only the titles' matches (idx_search_vector_gin), as
// the agent list does; `comments` counts each visible item's comments
// (idx_comments_item_position) before it sorts. Not measured yet.
//
// The one list of the home page (#proj-workspace:#210, the same route):
// - `sort=opened` orders by the reader's read position's updated_at, the
//   `recent` section's opened time (webDashboardAllOrder.ts). A LEFT JOIN on
//   its primary key, on every sort, since each row says when it was opened
//   (`openedAt`); no read position, never opened. It moves on whatever moves
//   the read position: the viewer's current version, and also following, a comment or
//   review from the end of the list, Activity's mark as read and an import
//   (there is no other record of an open), so `openedAt` means what it means
//   on `recent`.
// - `relevant=1` (和我有关, #proj-workspace:#276) keeps every Artifact the reader
//   is involved with, read or not (webDashboardNews.ts involvedSql): it made it
//   (published any version, itself or through an agent it created that is live
//   in this server), it follows it (subscriptions, not stopped), or a live
//   comment by someone else mentions it. Before #276 it kept only what had news
//   (what `waiting` and `following` list), so a reader who had read everything
//   saw nothing. A condition in the statement that limits, beside
//   visibleArtifactsSql, one row per Artifact. It fixes the order: what has
//   news first (dashboardNewsSql LEFT JOINed), among it waiting first
//   (news.mentions) then by update, as the filter ordered before; then the rest
//   by update; ties by id (webDashboardAllOrder.ts, one tier key and its cursor).
//   A later page's tiers count only activity made by the first page's moment
//   (the database's now(), carried by the cursor), bounded by the reader's
//   current read position: news that arrives while someone pages moves
//   nothing up, and a read between pages can move an Artifact down, never
//   skip it (one already listed comes back once lower; the web drops a row it
//   has by card id).
//   "Made it" is versions.publisher (the card's "who updated"; the creator is
//   always v1's publisher), so someone who published only v2 is involved, and
//   so is the person who created the agent that published it
//   (platform/visibility agentsCreatedBy, one query, then an IN list).
//   `waiting` holds what has data: mentions. Review requests have none yet
//   (ARTIFACT_DASHBOARD_SECTIONS); when one joins mentionedSql the filter has it.
// - Every row says its `news`, one query for the page (dashboardNewsSql narrowed
//   to its ids), so a card reads the same with the filter on or off.
// - `counts`: the first page only (no cursor), one statement (allCounts).
//   `relevant` is what has news of what the filter would keep (the toggle's
//   badge: something new for you), `filtered` with the filter on what it lists.
// Reads: at most ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT rows a page and the
// dashboard's 120 a minute, as before; still a constant number of queries, two
// more a first page (the counts, the news), one more a next page (the news).
// Cost: the counts' one pass is the read `dashboardAuthors` already makes (the
// server's visible items, no sort), plus `waiting` and `following`'s own work,
// what `/dashboard` costs for them on every load. With `q` the pass also tests
// each visible item's search row (by its key, not idx_search_vector_gin: `total`
// needs them all anyway). A `relevant` page starts from the reader's own rows:
// its and its agents' publishes, its follows and mentions as one hashed set
// (idx_versions_publisher, idx_subscriptions_actor, idx_comments_mentions),
// then the items by primary key, with the news joined; one more query a page
// for the reader's agents (idx_agents_creator).
// The news of a page is at most 50 ids through the same indexes. Not measured
// yet: the statements are in the PR for EXPLAIN.
//
// The `author` filter (task #133), on the sections, the first pages and the
// All tab alike: the key once per value, at most
// ARTIFACT_DASHBOARD_AUTHORS_MAX, each `me`, `my-agents`, `user:<uuid>` or
// `agent:<uuid>` (else 400 INVALID_REQUEST); several are any of them. It
// keeps Artifacts by their item's author (created_by, the latest card's
// `author`), as one more condition beside visibleArtifactsSql in the same
// statement (authorCondition), so it only narrows what the reader sees and
// a page's cap and cursor count only what it keeps. `my-agents` is
// platform/visibility agentsManagedBy: the reader's live agents in its
// server whose manager it is (its personal assistant, and the agents it
// made that are no one's assistant: canManageObject's manager rule), one
// query; none and nothing else asked is no row. No index on created_by:
// the sections start from the reader's own rows anyway; the All tab sorts
// the visible items as without it.
//
// The `conversation` filter (#proj-workspace:#221), on the All tab only: one
// uuid (else 400 INVALID_REQUEST), a condition beside visibleArtifactsSql in
// the same statements, the page and the counts alike (conversationCondition),
// so it only narrows, and `filtered` and `relevant` follow it while `total`
// doesn't. The id goes through readableConversation, as a conversation's
// Artifacts (webConversation.ts): at most four queries, a thread's or task's
// id meaning its parent, a joint named by the reader's projection and matched
// by every id its Artifacts may name. Anything else, a conversation the reader
// can't see, another server's, deleted or unknown, is FALSE: one ordinary empty
// page (`total` as ever) whatever the reason, not webConversation's 404: this
// route's answer is a list, a filter left on a conversation the reader has
// since left reads as "nothing here" with its way out, and Lagoon's App gets no
// new failure on a contract it already reads. Checked after the flag and the
// query, so a refusal never depends on the conversation.
//
// The conversations (`GET /api/artifacts/dashboard/conversations?q=`,
// ArtifactWebDashboardConversations, the shape of the authors below): the flag
// (403), `q` (400), then one statement grouping the All tab's Artifacts in
// conversations (visibleArtifactsSql narrowed to conversation homes,
// hasReadableCurrentVersion) by home with their count and newest update, then
// conversationNames for those homes, which merges a joint's aliases into the
// reader's projection and names a DM by its peer, then only what the filter
// would take (readableConversations, the rule of readableConversation as one
// batch, so a row is never one that filters to nothing and its count is what
// the filter lists), then `q` on the names (any case, contained, a leading #
// dropped), newest update first, ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT of them,
// then one profile lookup for the DM peers shown. Only a home that passed
// visibility and that rule is ever kept, and `q` reads only those, so a private
// channel's name can't reach a reader outside it, by `q` or otherwise. An
// Artifact that left a conversation for a wider home names no channel any more
// (the items' `items_home_channel` check) and is in the All tab, under no
// conversation. Names are core's tables, so `q` and the cap apply after the
// lookup, as the authors'. A constant number of queries. Cost: the statement reads the
// server's visible Artifacts as the All tab's does (not measured yet); the
// lookup follows how many visible conversations hold Artifacts.
//
// The authors (`GET /api/artifacts/dashboard/authors?q=`,
// ArtifactWebDashboardAuthors): the flag (403), `q` as the All tab's (400),
// then one statement grouping the All tab's Artifacts (visibleArtifactsSql,
// hasReadableCurrentVersion) by author with their count, then one profile
// lookup for every author (profiler), `q` on the handle and the display
// name (any case, contained), the most Artifacts first, then by display
// name, ARTIFACT_DASHBOARD_AUTHORS_LIMIT of them. Names are core's tables,
// so `q` and the cap apply after the lookup. Cost: the statement reads the
// server's visible Artifacts as the All tab's does (not measured yet); the
// lookup follows how many people and agents wrote them.
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT,
  ARTIFACT_DASHBOARD_AUTHORS_LIMIT,
  ARTIFACT_DASHBOARD_AUTHORS_MAX,
  ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT,
  ARTIFACT_DASHBOARD_HOMES,
  ARTIFACT_DASHBOARD_PAGE_LIMIT,
  ARTIFACT_DASHBOARD_SECTIONS,
  WEB_SEARCH_QUERY_MAX_CHARS,
  asArtifactCommentId,
  type ArtifactActor,
  type ArtifactCard,
  type ArtifactDashboardAllCounts,
  type ArtifactDashboardConversation,
  type ArtifactDashboardFollowing,
  type ArtifactDashboardHome,
  type ArtifactDashboardPage,
  type ArtifactDashboardRecent,
  type ArtifactDashboardSection,
  type ArtifactDashboardWaiting,
  type ArtifactWebDashboard,
  type ArtifactWebDashboardAll,
  type ArtifactWebDashboardAuthors,
  type ArtifactWebDashboardConversations,
} from "@botiverse/raft-shared";
import { conversationNames, readableConversation, readableConversations } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { agentsCreatedBy, agentsManagedBy, jointHomeAliases, type HomeNarrowing } from "../../platform/visibility";
import { ARTIFACT_CURSOR_ID, ARTIFACTS_NOT_ENABLED_ERROR, artifactsEnabled, excerptOf, json, type ArtifactActorRef, type ArtifactApiJson } from "./apiCommon";
import { prepareArtifactSearch, updatedMs } from "./search";
import { artifactCards, atCurrentVersions, cardAuthorRef, hasReadableCurrentVersion } from "./webCards";
import { answerWeb, profiler, readerViewActor, refuse, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";
import { allOrderSql, commentCountLateral, decodeAllCursor, encodeAllCursor, NEWS_ALIAS, parseAllOrder, type DashboardAllCursor, type DashboardAllOrder } from "./webDashboardAllOrder";
import {
  artifactComments,
  artifactItems,
  artifactReadPositions,
  artifactVersions,
  type ArtifactActorType,
} from "./schema";
import { dashboardNewsOf, dashboardNewsSql, followedNewsSql, involvedSql, mentionedSql } from "./webDashboardNews";
import { visibleArtifactsNarrowed, visibleArtifactsSql } from "./visibility";

/** The homes each `home` filter keeps. */
const NARROWING: Record<ArtifactDashboardHome, HomeNarrowing> = {
  channel: { kinds: ["conversation"], conversationTypes: ["channel", "private", "joint"] },
  dm: { kinds: ["conversation"], conversationTypes: ["dm"] },
  server: { kinds: ["server"] },
  public: { kinds: ["public"] },
};

type Cursor = { at: string; id: string };

/** The times a cursor may carry: years 1 to 9999, which Postgres's timestamptz holds (a later or earlier one would fail inside the query). */
const CURSOR_MIN_MS = Date.parse("0001-01-01T00:00:00.000Z");
const CURSOR_MAX_MS = Date.parse("9999-12-31T23:59:59.999Z");

/** `[epoch milliseconds, item id]`, base64url JSON. */
const encodeCursor = (row: { at: Date; itemId: string }): string =>
  Buffer.from(JSON.stringify([row.at.getTime(), row.itemId])).toString("base64url");

function decodeCursor(cursor: string): Cursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[1] !== "string" || !ARTIFACT_CURSOR_ID.test(value[1])) return null;
    const [ms, id] = value as [unknown, string];
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < CURSOR_MIN_MS || ms > CURSOR_MAX_MS) return null;
    return { at: new Date(ms).toISOString(), id };
  } catch {
    return null;
  }
}

/**
 * The `author` filter as asked (ArtifactDashboardAuthor values, the key once
 * per value): `me`, `my-agents`, and the people and agents named by id.
 * Null: no filter (everyone).
 */
type AuthorFilter = { me: boolean; myAgents: boolean; users: readonly string[]; agents: readonly string[] } | null;

/**
 * A dashboard query the page never builds (a stale page or a hand-made
 * request): what is wrong, and that reloading builds a good one.
 */
export const badFilter = (why: string): never => refuse(400, { code: "INVALID_REQUEST", error: `This list's filters aren't ones it takes (${why}): reload the page and choose them again.` });

/** A cursor this list didn't give out, or one of another order: start the list again. */
export const STALE_CURSOR = { code: "INVALID_REQUEST" as const, error: "That page of the list isn't one it gave out for this order and these filters: reload the list to start from the top." };

/** One `author` value: the words exactly, an id a uuid in any case. */
const AUTHOR_VALUE = /^(?:(me|my-agents)|(user|agent):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}))$/;

/** `author`: absent, or one to ARTIFACT_DASHBOARD_AUTHORS_MAX ArtifactDashboardAuthor values (an id a uuid); anything else 400 INVALID_REQUEST. */
function parseAuthors(author: unknown): AuthorFilter {
  if (author === undefined) return null;
  const values = Array.isArray(author) ? (author as unknown[]) : [author];
  if (values.length > ARTIFACT_DASHBOARD_AUTHORS_MAX) badFilter(`at most ${ARTIFACT_DASHBOARD_AUTHORS_MAX} authors`);
  const filter = { me: false, myAgents: false, users: [] as string[], agents: [] as string[] };
  for (const value of values) {
    const match = typeof value === "string" ? AUTHOR_VALUE.exec(value) : null;
    if (!match) badFilter("an author is me, my-agents, user:<id> or agent:<id>");
    const [, word, type, id] = match!;
    if (word === "me") filter.me = true;
    else if (word === "my-agents") filter.myAgents = true;
    else (type === "user" ? filter.users : filter.agents).push(id!.toLowerCase());
  }
  return filter;
}

/**
 * The `author` filter as a condition on the items' author (created_by: the
 * card's author at the current version), for the statement that also holds
 * visibleArtifactsSql: it only narrows. `my-agents` is the reader's managed
 * agents in its server (platform/visibility agentsManagedBy, one query);
 * none of them, and nothing else asked, matches nothing. Undefined: no
 * filter.
 */
async function authorCondition(reader: ArtifactWebReader, filter: AuthorFilter): Promise<SQL | undefined> {
  if (!filter) return undefined;
  const userIds = new Set(filter.users);
  if (filter.me) userIds.add(reader.userId);
  const agentIds = new Set(filter.agents);
  if (filter.myAgents) for (const id of await agentsManagedBy({ id: reader.userId, serverId: reader.serverId })) agentIds.add(id);
  const branches = [
    ...(userIds.size > 0 ? [and(eq(artifactItems.createdByType, "user"), inArray(artifactItems.createdById, [...userIds]))!] : []),
    ...(agentIds.size > 0 ? [and(eq(artifactItems.createdByType, "agent"), inArray(artifactItems.createdById, [...agentIds]))!] : []),
  ];
  return branches.length > 0 ? sql`(${or(...branches)})` : sql`FALSE`;
}

/** One conversation's id, in any case. */
const CONVERSATION_VALUE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `conversation`: absent, or one uuid; anything else 400 INVALID_REQUEST. Whether it is a conversation is conversationCondition's. */
function parseConversation(conversation: unknown): string | null {
  if (conversation === undefined) return null;
  if (typeof conversation !== "string" || !CONVERSATION_VALUE.test(conversation)) badFilter("conversation is one conversation's id");
  return (conversation as string).toLowerCase();
}

/**
 * The `conversation` filter as a condition on the items' home, for the
 * statements that also hold visibleArtifactsSql: it only narrows. A joint's
 * Artifacts name its canonical channel or a server's projection of it, so it
 * takes every id they may name, as webConversation.ts does. A conversation the
 * reader can't read, whatever the reason, matches nothing. Undefined: no filter.
 */
async function conversationCondition(reader: ArtifactWebReader, conversationId: string | null): Promise<SQL | undefined> {
  if (conversationId === null) return undefined;
  const conversation = await readableConversation(reader, conversationId);
  if (!conversation) return sql`FALSE`;
  const homes = conversation.type === "joint" ? await jointHomeAliases([conversation.homeChannelId]) : [conversation.homeChannelId];
  return and(eq(artifactItems.homeKind, "conversation"), inArray(artifactItems.homeChannelId, homes))!;
}

function parseHome(home: unknown): HomeNarrowing | undefined {
  if (home !== undefined && (typeof home !== "string" || !(ARTIFACT_DASHBOARD_HOMES as readonly string[]).includes(home))) {
    badFilter(`home is one of ${ARTIFACT_DASHBOARD_HOMES.join(", ")}`);
  }
  return home === undefined ? undefined : NARROWING[home as ArtifactDashboardHome];
}

/** `q` as the All tab and the authors read it: one string, trimmed, at most WEB_SEARCH_QUERY_MAX_CHARS code points; null when empty or absent. */
function parseQ(q: unknown): string | null {
  if (q !== undefined && typeof q !== "string") badFilter("the search is one string");
  const words = typeof q === "string" ? q.trim() : "";
  if (Array.from(words).length > WEB_SEARCH_QUERY_MAX_CHARS) refuse(400, { code: "INVALID_REQUEST", error: `A search can be at most ${WEB_SEARCH_QUERY_MAX_CHARS} characters: use fewer words.` });
  return words === "" ? null : words;
}

function parseQuery(query: Record<string, unknown>, opts: { cursor: boolean }): { narrow: HomeNarrowing | undefined; authors: AuthorFilter; cursor: Cursor | null } {
  const { home, author, cursor } = query;
  const narrow = parseHome(home);
  const authors = parseAuthors(author);
  if (cursor !== undefined && !opts.cursor) badFilter("a cursor pages one section, so it goes to /dashboard/:section");
  let parsed: Cursor | null = null;
  if (cursor !== undefined) {
    parsed = typeof cursor === "string" ? decodeCursor(cursor) : null;
    if (!parsed) refuse(400, STALE_CURSOR);
  }
  return { narrow, authors, cursor: parsed };
}

/** The All tab's query: the `home` narrowing, the `author` and `conversation` filters, the title search (null: none), the order (`relevant` is one) and its cursor. */
function parseAllQuery(query: Record<string, unknown>): { narrow: HomeNarrowing | undefined; authors: AuthorFilter; conversationId: string | null; q: string | null; order: DashboardAllOrder; cursor: DashboardAllCursor | null } {
  const { home, author, conversation, q, sort, dir, relevant, cursor } = query;
  const narrow = parseHome(home);
  const authors = parseAuthors(author);
  const conversationId = parseConversation(conversation);
  const words = parseQ(q);
  if (relevant !== undefined && relevant !== "1") badFilter("relevant is 1, or left out");
  const order = parseAllOrder(sort, dir, relevant === "1");
  let parsed: DashboardAllCursor | null = null;
  if (cursor !== undefined) {
    // The order's own cursor (no query digest: the order never depends on `q`); another order's is none.
    parsed = typeof cursor === "string" ? decodeAllCursor(cursor, order) : null;
    if (!parsed) refuse(400, STALE_CURSOR);
  }
  return { narrow, authors, conversationId, q: words, order, cursor: parsed };
}

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const asNullableDate = (value: unknown): Date | null => (value === null || value === undefined ? null : asDate(value));

/** A section query's row: the item, the time it is ordered by, and what the section adds. */
type SectionRow = { itemId: string; at: Date; row: Record<string, unknown> };

/**
 * The All tab's counts, one statement: one pass over everything the reader
 * can see (`everywhere`: visibleArtifactsSql without the `home` narrowing), a
 * readable current version as a page's, keeping what `matching` keeps (it
 * holds the home, author, conversation and title conditions); the news joined for N
 * (dashboardNewsSql, the reader's own rows), so a mention on an Artifact it
 * can't see counts for nothing. `relevant`: what has news (every Artifact with
 * news is one the reader is involved with), the toggle's "something new for
 * you"; with the filter on, `filtered` is what it lists, everything the reader
 * is involved with (involvedSql), news or not.
 */
async function allCounts(reader: ArtifactWebReader, on: { everywhere: SQL; matching: SQL; relevant: boolean; agentIds: readonly string[] }): Promise<ArtifactDashboardAllCounts> {
  const [row] = await getDb().select({
    total: sql<number>`count(*)::int`,
    matching: sql<number>`count(*) FILTER (WHERE ${on.matching})::int`,
    involved: on.relevant ? sql<number>`count(*) FILTER (WHERE ${involvedSql(reader, on.agentIds)} AND ${on.matching})::int` : sql<number>`0`,
    relevant: sql<number>`count(*) FILTER (WHERE ${sql.raw(NEWS_ALIAS)}.item_id IS NOT NULL AND ${on.matching})::int`,
  }).from(artifactItems)
    .leftJoin(sql`(${dashboardNewsSql(reader)}) AS ${sql.raw(NEWS_ALIAS)}`, sql`${sql.raw(NEWS_ALIAS)}.item_id = ${artifactItems.id}`)
    .where(and(on.everywhere, hasReadableCurrentVersion()));
  return {
    total: Number(row?.total ?? 0),
    filtered: Number((on.relevant ? row?.involved : row?.matching) ?? 0),
    relevant: Number(row?.relevant ?? 0),
  };
}

export function createDashboardOperations() {
  /**
   * One section's rows for the reader, at most `limit + 1` (the extra one
   * says there is more), newest first after `cursor`. `visible` is the
   * reader's visibleArtifactsSql with the `author` filter (authorCondition)
   * when asked; it is part of the query.
   */
  async function sectionRows(reader: ArtifactWebReader, section: ArtifactDashboardSection, visible: SQL, cursor: Cursor | null, limit: number): Promise<SectionRow[]> {
    const me = sql`${reader.userId}::uuid`;
    // The card shows the current version: only Artifacts that have a published one.
    const published = sql`EXISTS (SELECT 1 FROM ${artifactVersions} cv
      WHERE cv.id = ${artifactItems.currentVersionId} AND cv.revoked_at IS NULL AND cv.position IS NOT NULL)`;
    const readPosition = sql`LEFT JOIN ${artifactReadPositions} rp
      ON rp.item_id = ${artifactItems.id} AND rp.actor_type = 'user' AND rp.actor_id = ${me}`;
    const after = (at: SQL) => (cursor ? sql`AND (${at}, ${artifactItems.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : sql``);
    let query: SQL;
    switch (section) {
      case "waiting": {
        // From the comments side (mentionedSql), then only Artifacts the reader can see.
        const at = sql`date_trunc('milliseconds', w.created_at)`;
        query = sql`
          WITH mentioned AS (${mentionedSql(reader)})
          SELECT ${artifactItems.id} AS item_id, ${at} AS at, w.id AS comment_id, m.n, w.body, w.author_type, w.author_id, w.path,
            w.created_at AS comment_created_at, wv.number AS comment_version
          FROM mentioned m
          JOIN ${artifactItems} ON ${artifactItems.id} = m.item_id
          JOIN ${artifactComments} w ON w.item_id = m.item_id AND w.position = m.newest
          LEFT JOIN ${artifactVersions} wv ON wv.id = w.version_id
          WHERE ${visible} AND ${published} ${after(at)}
          ORDER BY at DESC, item_id DESC
          LIMIT ${limit + 1}`;
        break;
      }
      case "following": {
        // From what the reader follows (followedNewsSql), then only Artifacts it can see.
        const at = sql`date_trunc('milliseconds', f.at)`;
        query = sql`
          SELECT ${artifactItems.id} AS item_id, ${at} AS at, f.versions, f.comments
          FROM (${followedNewsSql(reader)}) f
          JOIN ${artifactItems} ON ${artifactItems.id} = f.item_id
          WHERE ${visible} AND ${published} ${after(at)}
          ORDER BY at DESC, item_id DESC
          LIMIT ${limit + 1}`;
        break;
      }
      case "recent": {
        // From the reader's side: what it opened (idx_read_positions_actor)
        // and what it published (idx_versions_publisher), then only
        // Artifacts it can see.
        const at = sql`date_trunc('milliseconds', GREATEST(mine.at, rp.updated_at))`;
        query = sql`
          WITH candidates AS (
            SELECT orp.item_id FROM ${artifactReadPositions} orp
            WHERE orp.actor_type = 'user' AND orp.actor_id = ${me}
            UNION
            SELECT pv.item_id FROM ${artifactVersions} pv
            WHERE pv.publisher_type = 'user' AND pv.publisher_id = ${me}
              AND pv.revoked_at IS NULL AND pv.position IS NOT NULL
          )
          SELECT ${artifactItems.id} AS item_id, ${at} AS at, mine.at AS published_at, rp.updated_at AS opened_at
          FROM candidates
          JOIN ${artifactItems} ON ${artifactItems.id} = candidates.item_id
          ${readPosition}
          CROSS JOIN LATERAL (
            SELECT max(v.created_at) AS at FROM ${artifactVersions} v
            WHERE v.item_id = ${artifactItems.id}
              AND v.publisher_type = 'user' AND v.publisher_id = ${me}
              AND v.revoked_at IS NULL AND v.position IS NOT NULL
          ) mine
          WHERE ${visible} AND ${published} AND (mine.at IS NOT NULL OR rp.item_id IS NOT NULL) ${after(at)}
          ORDER BY at DESC, item_id DESC
          LIMIT ${limit + 1}`;
        break;
      }
    }
    const result = await getDb().execute(query);
    return (result.rows as Array<Record<string, unknown>>).map((row) => ({ itemId: String(row.item_id), at: asDate(row.at), row }));
  }

  /**
   * The asked sections' pages: one query each, then the cards for every row
   * at once (items, current versions, one profile lookup, artifactCards).
   */
  async function pages<S extends ArtifactDashboardSection>(reader: ArtifactWebReader, sections: readonly S[], narrow: HomeNarrowing | undefined, authors: AuthorFilter, cursor: Cursor | null): Promise<Pick<ArtifactWebDashboard, S>> {
    const limit = ARTIFACT_DASHBOARD_PAGE_LIMIT;
    const [homes, byAuthor] = await Promise.all([visibleArtifactsSql(readerViewActor(reader), { narrow }), authorCondition(reader, authors)]);
    // The author filter only narrows what the reader sees: both conditions in each section's query.
    const visible = byAuthor ? sql`(${homes} AND ${byAuthor})` : homes;
    // fanout-ok: one query per asked section, at most the 3 of ARTIFACT_DASHBOARD_SECTIONS (waiting, following, recent)
    const found = await Promise.all(sections.map((section) => sectionRows(reader, section, visible, cursor, limit)));
    const shownRows = found.map((rows) => rows.slice(0, limit));

    const db = getDb();
    const ids = [...new Set(shownRows.flat().map((row) => row.itemId))];
    const items = ids.length > 0
      ? await db.select().from(artifactItems).where(and(inArray(artifactItems.id, ids), isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt)))
      : [];
    const shown = await atCurrentVersions(items);
    const waitingIndex = (sections as readonly ArtifactDashboardSection[]).indexOf("waiting");
    const waitingAuthors = waitingIndex < 0
      ? []
      : shownRows[waitingIndex]!.map(({ row }) => ({ type: row.author_type as ArtifactActorType, id: String(row.author_id) }));
    const actorOf = await profiler([...shown.map(({ item }) => ({ type: item.createdByType, id: item.createdById })), ...waitingAuthors]);
    const cards = await artifactCards(reader, shown, actorOf);
    const cardOf = new Map<string, ArtifactCard>(shown.map(({ item }, index) => [item.id, cards[index]!]));

    const answer = {} as Record<ArtifactDashboardSection, ArtifactDashboardPage<unknown>>;
    sections.forEach((section, index) => {
      const rows = shownRows[index]!;
      // An Artifact deleted, revoked or unpublished between the section's query and the items' is left out of this page.
      const kept = rows.flatMap((entry) => {
        const card = cardOf.get(entry.itemId);
        return card ? [rowOf(section, card, entry, actorOf)] : [];
      });
      answer[section] = { rows: kept, nextCursor: found[index]!.length > limit ? encodeCursor(rows[rows.length - 1]!) : null };
    });
    return answer as unknown as Pick<ArtifactWebDashboard, S>;
  }

  return {
    dashboard: (reader: ArtifactWebReader, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebDashboard> | ArtifactWebApiError> => answerWeb(async () => {
      if (!(await artifactsEnabled(reader.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
      const { narrow, authors } = parseQuery(query, { cursor: false });
      return json<ArtifactWebDashboard>(await pages(reader, ARTIFACT_DASHBOARD_SECTIONS, narrow, authors, null));
    }),

    dashboardAll: (reader: ArtifactWebReader, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebDashboardAll> | ArtifactWebApiError> => answerWeb(async () => {
      if (!(await artifactsEnabled(reader.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
      const { narrow, authors, conversationId, q, order, cursor } = parseAllQuery(query);
      const search = q === null ? null : prepareArtifactSearch(q);
      const limit = ARTIFACT_DASHBOARD_ALL_PAGE_LIMIT;
      // Visibility, the home, author and conversation filters and the title search are in the statement that orders and limits, never a filter after it.
      const relevant = order.sort === "relevant";
      // `relevant`: the reader's own agents (the ones it created, live in this server) count as it for "made it", by id.
      const [{ narrowed: visible, everywhere }, byAuthor, inConversation, myAgents] = await Promise.all([
        visibleArtifactsNarrowed(readerViewActor(reader), narrow),
        authorCondition(reader, authors),
        conversationCondition(reader, conversationId),
        relevant ? agentsCreatedBy({ id: reader.userId, serverId: reader.serverId }) : Promise.resolve([] as string[]),
      ]);
      // A query with no words in it (only punctuation) matches nothing, as everywhere it is searched.
      const nothing = search !== null && !search.titleMatch;
      // Beside the page: no awaited step between here and the page's own read.
      const counting = cursor ? null : allCounts(reader, {
        everywhere,
        matching: nothing ? sql`FALSE` : and(visible, byAuthor, inConversation, search?.titleMatch ?? undefined)!,
        relevant,
        agentIds: myAgents,
      });
      if (nothing) return json<ArtifactWebDashboardAll>({ rows: [], nextCursor: null, counts: await counting });
      // The `comments` sort counts each row's live comments in the statement (a LATERAL count), as the card counts them.
      const counted = order.sort === "comments" ? commentCountLateral(reader.serverId) : null;
      const { key, after, orderBy } = allOrderSql(order, cursor, counted ? sql`${counted.n}` : null);
      // The reader's read position (at most one a row; none: never opened) says when it was opened, for the row and the `opened` sort.
      // `moment`: the database's clock, the one read positions are written by; `relevant`'s cursor carries the first page's.
      const select = getDb().select({ item: artifactItems, key: sql<unknown>`${key}`, openedAt: artifactReadPositions.updatedAt, moment: sql<Date>`now()`.mapWith(artifactReadPositions.updatedAt) }).from(artifactItems)
        .leftJoin(artifactReadPositions, and(
          eq(artifactReadPositions.itemId, artifactItems.id),
          eq(artifactReadPositions.actorType, "user"),
          eq(artifactReadPositions.actorId, reader.userId),
        )).$dynamic();
      // `relevant`'s tiers: the first page's are now; a later page's as of the first page's moment, which its cursor carries (webDashboardAllOrder.ts).
      const asOf = cursor?.asOf ? new Date(cursor.asOf) : undefined;
      const conditions = and(
        visible,
        byAuthor,
        inConversation,
        // `relevant`: what the reader is involved with, read or not; the news (joined below) only orders it.
        relevant ? involvedSql(reader, myAgents) : undefined,
        // The card shows the current version: never one never published, so a page counts only rows with a card.
        hasReadableCurrentVersion(),
        search?.titleMatch ?? undefined,
        after,
      );
      // `relevant` orders what has news first: a LEFT JOIN, so what is involved but read stays, last.
      const joined = relevant
        ? select.leftJoin(sql`(${dashboardNewsSql(reader, undefined, asOf)}) AS ${sql.raw(NEWS_ALIAS)}`, sql`${sql.raw(NEWS_ALIAS)}.item_id = ${artifactItems.id}`)
        : counted ? select.innerJoinLateral(counted, sql`true`) : select;
      const [rows, counts] = await Promise.all([joined.where(conditions).orderBy(...orderBy).limit(limit + 1), counting]);
      const page = rows.slice(0, limit);

      // An Artifact unpublished between the two queries is left out of this page.
      const shown = await atCurrentVersions(page.map((row) => row.item));
      const [actorOf, news] = await Promise.all([profiler(shown.map(cardAuthorRef)), dashboardNewsOf(reader, shown.map(({ item }) => item.id))]);
      const cards = await artifactCards(reader, shown, actorOf);
      const openedOf = new Map(page.map((row) => [row.item.id, row.openedAt]));
      const last = page[page.length - 1];
      return json<ArtifactWebDashboardAll>({
        rows: cards.map((card) => ({ card, openedAt: openedOf.get(card.id)?.toISOString() ?? null, news: news.get(card.id) ?? { mentions: 0, versions: 0, comments: 0 } })),
        nextCursor: rows.length > limit && last ? encodeAllCursor(order, last, asOf ?? asDate(last.moment)) : null,
        counts,
      });
    }),

    dashboardSection: (reader: ArtifactWebReader, section: string, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebDashboard[ArtifactDashboardSection]> | ArtifactWebApiError> => answerWeb(async () => {
      if (!(await artifactsEnabled(reader.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
      if (!(ARTIFACT_DASHBOARD_SECTIONS as readonly string[]).includes(section)) badFilter(`the section is one of ${ARTIFACT_DASHBOARD_SECTIONS.join(", ")}`);
      const { narrow, authors, cursor } = parseQuery(query, { cursor: true });
      const name = section as ArtifactDashboardSection;
      const answer = await pages(reader, [name], narrow, authors, cursor);
      return json(answer[name]);
    }),

    dashboardAuthors: (reader: ArtifactWebReader, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebDashboardAuthors> | ArtifactWebApiError> => answerWeb(async () => {
      if (!(await artifactsEnabled(reader.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
      const q = parseQ(query.q)?.toLowerCase() ?? null;
      // The All tab's Artifacts (visibility and a readable current version in the statement), grouped by author.
      const visible = await visibleArtifactsSql(readerViewActor(reader));
      const groups = await getDb().select({ type: artifactItems.createdByType, id: artifactItems.createdById, count: sql<number>`count(*)::int` })
        .from(artifactItems)
        .where(and(visible, hasReadableCurrentVersion()))
        .groupBy(artifactItems.createdByType, artifactItems.createdById);
      // Names are core's (platform/actors): one lookup for every author, then `q` on the handle and the display name.
      const actorOf = await profiler(groups);
      const contains = (text: string) => q === null || text.toLowerCase().includes(q);
      const authors = groups
        .map((group) => ({ ...actorOf(group), count: Number(group.count) }))
        .filter((author) => contains(author.name) || contains(author.displayName))
        .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
        .slice(0, ARTIFACT_DASHBOARD_AUTHORS_LIMIT);
      return json<ArtifactWebDashboardAuthors>({ authors });
    }),

    dashboardConversations: (reader: ArtifactWebReader, query: Record<string, unknown>): Promise<ArtifactApiJson<ArtifactWebDashboardConversations> | ArtifactWebApiError> => answerWeb(async () => {
      if (!(await artifactsEnabled(reader.serverId))) refuse(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR });
      // A channel is written with its #, which no name has.
      const q = parseQ(query.q)?.replace(/^#/, "").toLowerCase() ?? "";
      // The All tab's Artifacts in conversations (visibility and a readable current version in the statement), grouped by home.
      const visible = await visibleArtifactsSql(readerViewActor(reader), { narrow: { kinds: ["conversation"] } });
      const groups = await getDb().select({ home: artifactItems.homeChannelId, count: sql<number>`count(*)::int`, updatedAt: sql<unknown>`max(${updatedMs})` })
        .from(artifactItems)
        .where(and(visible, hasReadableCurrentVersion()))
        .groupBy(artifactItems.homeChannelId);
      // Names are core's: the homes that passed, and only those, as this reader sees them (a joint's aliases become its one projection).
      const names = await conversationNames(reader, groups.flatMap((group) => (group.home ? [group.home] : [])));
      // The filter's own rule, as one batch: what it would refuse is no row, and `q` below reads only what is left.
      const readable = await readableConversations(reader, [...names.values()].map(({ id }) => id));
      const merged = new Map<string, { id: string; name: string; type: ArtifactDashboardConversation["type"]; peerDisplayName?: string; peer?: { type: "user" | "agent"; id: string }; count: number; at: Date }>();
      for (const group of groups) {
        const conversation = group.home ? names.get(group.home) : undefined;
        if (!conversation || !readable.has(conversation.id)) continue;
        const at = asDate(group.updatedAt);
        const seen = merged.get(conversation.id);
        merged.set(conversation.id, { ...conversation, count: (seen?.count ?? 0) + Number(group.count), at: seen && seen.at > at ? seen.at : at });
      }
      const contains = (text: string | undefined) => text?.toLowerCase().includes(q) === true;
      const shown = [...merged.values()]
        .filter((conversation) => q === "" || contains(conversation.name) || contains(conversation.peerDisplayName))
        .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id))
        .slice(0, ARTIFACT_DASHBOARD_CONVERSATIONS_LIMIT);
      // One lookup for the DM peers shown (their avatars).
      const actorOf = await profiler(shown.flatMap(({ peer }) => (peer ? [peer] : [])));
      return json<ArtifactWebDashboardConversations>({
        conversations: shown.map(({ peer, at, ...conversation }) => ({ ...conversation, updatedAt: at.toISOString(), ...(peer ? { peer: actorOf(peer) } : {}) })),
      });
    }),
  };
}

/** A section's row from its query row and the Artifact's card. */
function rowOf(
  section: ArtifactDashboardSection,
  card: ArtifactCard,
  { at, row }: SectionRow,
  actorOf: (actor: ArtifactActorRef) => ArtifactActor,
): ArtifactDashboardWaiting | ArtifactDashboardFollowing | ArtifactDashboardRecent {
  switch (section) {
    case "waiting": {
      const { excerpt, truncated } = excerptOf(String(row.body));
      return {
        card,
        comment: {
          id: asArtifactCommentId(String(row.comment_id)),
          author: actorOf({ type: row.author_type as ArtifactActorType, id: String(row.author_id) }),
          excerpt,
          truncated,
          createdAt: asDate(row.comment_created_at).toISOString(),
          version: Number(row.comment_version),
          path: row.path === null ? null : String(row.path),
        },
        count: Number(row.n),
      };
    }
    case "following":
      return { card, unread: { versions: Number(row.versions), comments: Number(row.comments) }, activityAt: at.toISOString() };
    case "recent":
      return {
        card,
        publishedAt: asNullableDate(row.published_at)?.toISOString() ?? null,
        openedAt: asNullableDate(row.opened_at)?.toISOString() ?? null,
        at: at.toISOString(),
      };
  }
}
