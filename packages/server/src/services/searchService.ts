import { performance } from "node:perf_hooks";
import {
  AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
  AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
  buildSearchSnippet,
  clearClockTimeout,
  SEARCH_SNIPPET_WIDTH_AFTER_HIT,
  SEARCH_SNIPPET_WIDTH_BEFORE_HIT,
  searchSnippetCharWidth,
  setClockTimeout,
} from "@botiverse/raft-shared";
import { sql, type SQL } from "drizzle-orm";
import { executeSearchSql, getDb, isSearchQueryAbortedError } from "../db/index";
import { addTraceEvent } from "../tracing/semanticTrace";
import { messageSearchErrorTraceAttrs, messageSearchParamTraceAttrs } from "../tracing/messageSearchTrace";
import { traceQuerySpan } from "../tracing/queryTrace";
import { evaluateFeatureFlag, SEARCH_SERVER_GIN_FEATURE_FLAG_KEY } from "./featureFlagService";
import { tokenizeSearchText } from "./searchTokenizer";
import { historyLimitedPreview } from "./historyPreview";
import { legacyAgentProvenance } from "./externalAgentProvenance";
import type { AgentVisibleExternalMessageProvenance, ServerId } from "@botiverse/raft-shared";
import {
  intersectVisibleRoots,
  uuidArray,
  visibleConversationRootIds,
  visibleConversationSql,
  visibleRootChannelIds,
  type VisibleRoots,
} from "./visibilityService";

export interface MessageSearchResult {
  id: string;
  seq: number;
  channelId: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentChannelArchivedAt: string | null;
  senderId: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  senderAvatarUrl: string | null;
  externalMessage: AgentVisibleExternalMessageProvenance | null;
  channelName: string;
  /** "task": a task v2 conversation hit (its parent channel is parentChannel*). */
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  channelArchivedAt: string | null;
  /** RFC 077: the assistant that sent this for its owner; null otherwise. */
  delegatedBy?: { id: string; name: string; displayName: string; avatarUrl: string | null; deleted: boolean } | null;
  /** RFC 077: a delegated message its owner retracted (content is the placeholder). */
  retracted?: boolean;
  content: string;
  snippet: string;
  createdAt: string;
  /** Task v2: set on a task-conversation hit (channelType "task"). */
  taskId?: string;
  taskNumber?: number;
  taskTitle?: string;
}

/** Task v2: the task of each task-conversation hit (by its conversation channel id). */
async function loadSearchHitTasks(rows: ReadonlyArray<{ channelId: string; channelType: string }>) {
  const conversationIds = [...new Set(rows.filter((row) => row.channelType === "task").map((row) => row.channelId))];
  const byConversation = new Map<string, { taskId: string; taskNumber: number; taskTitle: string }>();
  if (conversationIds.length === 0) return byConversation;
  const result = await getDb().execute(sql`
    SELECT c.id::text AS "conversationId", t.id::text AS "taskId", t.task_number AS "taskNumber", t.title AS "taskTitle"
    FROM channels c
    JOIN tasks t ON t.id = c.task_id
    WHERE c.type = 'task'
      AND c.id IN (${sql.join(conversationIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  for (const row of result.rows as Array<{ conversationId: string; taskId: string; taskNumber: number | string; taskTitle: string }>) {
    byConversation.set(row.conversationId, { taskId: row.taskId, taskNumber: Number(row.taskNumber), taskTitle: row.taskTitle });
  }
  return byConversation;
}

export type MessageSearchSort = "relevance" | "recent";
/**
 * How a recent-sort text search finds its page. The walk reads messages newest
 * first across every server (idx_messages_created_at) and checks visibility per
 * row, so its cost is the global traffic it passes before LIMIT visible matches:
 * a term that is neither rare nor dense, searched from a server with a small
 * share of the traffic, walks ~160k rows (KBDevTeam user: 464k buffers, 5-6s
 * cold; KBDevTeam agent: canceled). Text matches first costs the term's match
 * set instead, bounded by the same corpus-wide estimate relevance admits; above
 * it the term is dense enough that the walk finds matches quickly.
 */
export type MessageSearchRecentPlan = "walk" | "text_matches_first" | "server_timeline_walk";
export type MessageSearchSenderType = "user" | "agent";

export interface MessageSearchMentionTarget {
  targetType: "user" | "agent";
  targetId: string;
}

/**
 * Relevance search is admitted only when PostgreSQL estimates no more than
 * this many visible, filter-matching FTS candidate rows. The fixed threshold
 * is intentionally 6.1x below the first viewer-scoped production timeout
 * estimate (61,050 rows) while retaining the measured 3,045-row query. It is
 * a conservative admission heuristic, not an exact count or a completion
 * guarantee; statement-timeout remains a typed fail-closed backstop.
 * Keep this value synchronized with manual/agent-knowledge/search.md.
 */
export const MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT = 10_000;
/**
 * Relevance search reads the full-text matches of every server first (the GIN
 * index cannot be narrowed to one server) and only then keeps the visible ones,
 * so it is also admitted only while PostgreSQL estimates at most this many
 * matches across all servers for the text and the message-level filters
 * (sender, sender type, dates, channel). A term absent from the search_vector
 * statistics is always estimated at a fixed selectivity of at most 0.5% of all
 * messages (80,918 of 16.1M rows on prod, 2026-09-29), whatever its real count.
 * So an estimate is only rejected when it is also above
 * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION of all messages: that keeps rare
 * terms admitted as the corpus grows, and only rejects terms the statistics
 * know to be common.
 * Keep both values synchronized with manual/agent-knowledge/search.md.
 */
export const MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT = 200_000;
export const MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION = 0.01;
/**
 * search_server_gin_v0: the cap on the estimated text matches of the searched
 * servers (idx_message_server_timeline_server_search) relevance ranks. The
 * corpus-wide cap above bounds a read of every server's matches; this one
 * bounds only the searched server's, so it is a fixed number. Relevance reads
 * and ranks every match (about 0.25 ms warm, 2.8 ms cold each, see
 * MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP), so 200k let single common words run
 * for 5 s and more (prod 11-05..11-12: 2.8% of these over 5 s, on a few large
 * servers). Above it relevance is not refused: the page is the recent sort's,
 * marked relevanceFallback (#raft-architecture:#29, Tenny 2026-11-12).
 */
export const MESSAGE_SEARCH_SERVER_GIN_ESTIMATED_TEXT_MATCH_LIMIT = 20_000;
/**
 * Recent sort on a server with the timeline walk: collect the term's text
 * matches first only while the planner expects at most this many (corpus-wide;
 * the GIN match cannot be narrowed to one server). Above it, walk this server's
 * timeline newest first instead (bounded by the row budget below). The
 * relevance cap above is far too high for this: each collected match is a
 * random heap read, and the walk stops at the page. Prod 2026-10-16 (agent
 * search timeouts, 'deploy', 7 days, cold replica): collect-first 18.4 s (427k
 * GIN matches, lossy bitmap, 36k pages read) vs this server's timeline walk
 * 1.05 s (617 timeline rows). Without the timeline walk (flag off, or a channel
 * filter) recent sort keeps the relevance cap: the other walk has no budget.
 */
export const MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT = 2_000;
/**
 * search_server_gin_v0, relevance sort: the most text matches the any-term
 * fallback (run only when the all-terms search found nothing) may rank. It is
 * counted exactly (LIMIT cap + 1 over the searched servers' timeline rows),
 * not estimated: for a term absent from the GIN statistics the planner assumes
 * a fixed 3,758 rows whatever the real count (prod 2026-11-12, second-largest
 * server: 'sidebar' 7,072, 'migration' 24,907). Each match is then re-read
 * from messages (its search_vector is in TOAST) and ranked: about 0.25 ms
 * warm and 2.8 ms cold a match, so 7,072 took 1.8 s warm and 20.5 s cold, and
 * any-term over four common words (115k matches) hit the statement timeout.
 * 3,000 keeps the cold worst case near 8 s.
 * The count is of text matches BEFORE visibility: on a large server a caller
 * who can see few of them is still over the cap. That is deliberate (counting
 * visible matches costs what the cap avoids). Over the cap the fallback is
 * skipped and the page says so (relaxedSkipped), instead of timing out.
 */
export const MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP = 3_000;
/**
 * Most timeline rows one server-timeline walk reads. A term common across
 * Raft but rare on this server otherwise walks the whole range: 'invoice', 30
 * days, the busiest server (prod replica 2026-10-16) read 46,921 timeline rows
 * in 14.5 s for 3 matches, one step from the 15 s statement timeout. The walk
 * reads each row's search_vector, mostly in TOAST, from a heap the 0658
 * backfill scattered: 10,000 cold rows on /raft took 9.1 s (prod replica
 * 2026-11-12, 15k blocks read; 25 ms without the vector), and 15% of these
 * walks ran over 5 s. About 0.9 ms a row cold, so this budget is about 2.7 s.
 * When it runs out before the page fills, the page is returned as incomplete
 * with a cursor that continues below the last row read.
 */
export const MESSAGE_SEARCH_WALK_TIMELINE_ROW_BUDGET = 3_000;

/**
 * Opaque position in one server's timeline walk: (created_at, message_id) of a
 * row, exclusive (a walk from it reads strictly older rows). Produced only by
 * encodeMessageSearchWalkCursor; a client passes it back unchanged.
 */
export type MessageSearchWalkCursor = string & { readonly __brand: "MessageSearchWalkCursor" };

interface MessageSearchWalkPosition {
  /** UTC, microseconds: the exact stored created_at (a JS Date keeps only ms). */
  createdAt: string;
  messageId: string;
}

const WALK_CURSOR_CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const WALK_CURSOR_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeMessageSearchWalkCursor(position: MessageSearchWalkPosition): MessageSearchWalkCursor {
  return Buffer.from(JSON.stringify({ t: position.createdAt, i: position.messageId }), "utf8")
    .toString("base64url") as MessageSearchWalkCursor;
}

function decodeMessageSearchWalkCursor(cursor: MessageSearchWalkCursor): MessageSearchWalkPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || !WALK_CURSOR_CREATED_AT_RE.test(parsed.t)) return null;
    if (Number.isNaN(Date.parse(parsed.t))) return null;
    if (typeof parsed.i !== "string" || !WALK_CURSOR_MESSAGE_ID_RE.test(parsed.i)) return null;
    return { createdAt: parsed.t, messageId: parsed.i.toLowerCase() };
  } catch {
    return null;
  }
}

/** Null for anything that is not a cursor this server produced. */
export function parseMessageSearchWalkCursor(raw: unknown): MessageSearchWalkCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return null;
  return decodeMessageSearchWalkCursor(raw as MessageSearchWalkCursor) ? raw as MessageSearchWalkCursor : null;
}

/** created_at as the cursor stores it: UTC with all six fractional digits. */
const walkCreatedAtTextSql = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS = 1_000;
/**
 * A Free agent search counts the matches its window hides up to this many
 * ("over 100" past it), on its first page only (Tenny, task #proj-commercial:#24).
 */
export const MESSAGE_SEARCH_OLDER_HIDDEN_CAP = 100;
/**
 * The count's own deadline: on a broad term it can read the text index's
 * whole match set (#14398: about a second). Past it, or on any error, the page
 * carries no count and is otherwise unchanged.
 */
export const MESSAGE_SEARCH_OLDER_HIDDEN_TIMEOUT_MS = 1_000;
export const MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE = "QUERY_TOO_BROAD" as const;
export const MESSAGE_SEARCH_TIMEOUT_CODE = "SEARCH_TIMEOUT" as const;
export const MESSAGE_SEARCH_UNAVAILABLE_CODE = "SEARCH_UNAVAILABLE" as const;
export const MESSAGE_SEARCH_QUERY_TOO_BROAD_MESSAGE =
  "Search query is too broad. Add a channel or sender filter, or use --sort recent (a time range works with recent).";
export const MESSAGE_SEARCH_TIMEOUT_MESSAGE =
  "Search timed out. Add a channel or sender filter, use --sort recent (a time range works with recent), or retry.";
export const MESSAGE_SEARCH_UNAVAILABLE_MESSAGE =
  "Search planning is temporarily unavailable. Retry the search.";

export class MessageSearchQueryTooBroadError extends Error {
  readonly code = MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE;
  readonly status = 422;

  constructor() {
    super(MESSAGE_SEARCH_QUERY_TOO_BROAD_MESSAGE);
    this.name = "MessageSearchQueryTooBroadError";
  }
}

export class MessageSearchTimeoutError extends Error {
  readonly code = MESSAGE_SEARCH_TIMEOUT_CODE;
  readonly status = 503;

  constructor() {
    super(MESSAGE_SEARCH_TIMEOUT_MESSAGE);
    this.name = "MessageSearchTimeoutError";
  }
}

export class MessageSearchUnavailableError extends Error {
  readonly code = MESSAGE_SEARCH_UNAVAILABLE_CODE;
  readonly status = 503;

  constructor(options?: ErrorOptions) {
    super(MESSAGE_SEARCH_UNAVAILABLE_MESSAGE, options);
    this.name = "MessageSearchUnavailableError";
  }
}

export type MessageSearchPublicError = MessageSearchQueryTooBroadError | MessageSearchTimeoutError | MessageSearchUnavailableError;

export function isMessageSearchPublicError(error: unknown): error is MessageSearchPublicError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown };
  return (
    candidate.code === MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE
    || candidate.code === MESSAGE_SEARCH_TIMEOUT_CODE
    || candidate.code === MESSAGE_SEARCH_UNAVAILABLE_CODE
  ) && (candidate.status === 422 || candidate.status === 503);
}

export function isMessageSearchQueryTooBroadError(error: unknown): error is MessageSearchQueryTooBroadError {
  return error instanceof MessageSearchQueryTooBroadError
    || (
      !!error
      && typeof error === "object"
      && (error as { code?: unknown }).code === MESSAGE_SEARCH_QUERY_TOO_BROAD_CODE
    );
}

export function classifyMessageSearchBreadth(estimatedCandidateRows: number): "within_limit" | "over_limit" {
  if (!Number.isInteger(estimatedCandidateRows) || estimatedCandidateRows < 0) {
    throw new Error("Invalid message search planner estimate");
  }
  return estimatedCandidateRows > MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT ? "over_limit" : "within_limit";
}

/**
 * Recent sort plan, on a server with the timeline walk, from the planner's
 * corpus-wide text-match estimate: collect the matches first only for a
 * bounded set, otherwise walk this server's timeline newest first.
 */
export function chooseMessageSearchRecentPlan(estimatedTextMatchRows: number): "text_matches_first" | "walk" {
  if (!Number.isFinite(estimatedTextMatchRows) || estimatedTextMatchRows < 0) return "walk";
  return estimatedTextMatchRows <= MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT ? "text_matches_first" : "walk";
}

export function classifyMessageSearchTextMatchBreadth(
  estimatedTextMatchRows: number,
  corpusRows: number,
): "within_limit" | "over_limit" {
  if (!Number.isInteger(estimatedTextMatchRows) || estimatedTextMatchRows < 0 || !Number.isFinite(corpusRows)) {
    throw new Error("Invalid message search planner estimate");
  }
  const limit = Math.max(
    MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
    Math.max(corpusRows, 0) * MESSAGE_SEARCH_COMMON_TERM_CORPUS_FRACTION,
  );
  return estimatedTextMatchRows > limit ? "over_limit" : "within_limit";
}

// The snippet cut (display-width window around the first hit, word-boundary
// edges, "…") lives in raft-shared so the web's channel-description subtitle
// cuts the same way.
export { SEARCH_SNIPPET_WIDTH_AFTER_HIT, SEARCH_SNIPPET_WIDTH_BEFORE_HIT, searchSnippetCharWidth };

export function buildSnippet(content: string, queryTokens: string[]): string {
  return buildSearchSnippet(content, queryTokens);
}

/** Hidden is created_at <= cutoff, the complement of the window (services/historyWindow.ts). */
function isParentBehindHistory(createdAt: Date | string | null, cutoff: Date | undefined): boolean {
  return Boolean(cutoff && createdAt && new Date(createdAt).getTime() <= cutoff.getTime());
}

interface SearchRow extends Record<string, unknown> {
  id: string;
  seq: number | string;
  channelId: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  /** Only to cut `parentMessageContent` behind the history window; not returned. */
  parentMessageCreatedAt: Date | string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentChannelArchivedAt: Date | string | null;
  senderId: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  senderAvatarUrl: string | null;
  externalMessage: AgentVisibleExternalMessageProvenance | null;
  externalIdentityKind: "provider_actor" | "anonymous" | null;
  channelName: string;
  /** "task": a task v2 conversation hit (its parent channel is parentChannel*). */
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  channelArchivedAt: Date | string | null;
  content: string;
  createdAt: Date | string;
  /** server_timeline_walk only: the row's exact walk key (see MessageSearchWalkPosition). */
  walkCreatedAt?: string;
}

interface SearchBreadthProbeRow extends Record<string, unknown> {
  "QUERY PLAN": unknown;
}

type SearchServiceDeps = {
  executeSearchSql: typeof executeSearchSql;
  /** search_server_gin_v0 for the searched server. */
  isServerSearchGinEnabled: (serverId: string) => Promise<boolean>;
  /** Rows one server timeline walk may read (tests shrink it). */
  walkTimelineRowBudget: number;
  /** MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP (tests shrink it). */
  relaxedTextMatchCap: number;
  /** The viewer's visible conversations (the visibility entry). */
  visibleRootChannelIds: typeof visibleRootChannelIds;
};

async function isServerSearchGinEnabled(serverId: string): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({ key: SEARCH_SERVER_GIN_FEATURE_FLAG_KEY, serverId });
  return evaluation.enabled;
}

const defaultSearchServiceDeps: SearchServiceDeps = {
  executeSearchSql,
  isServerSearchGinEnabled,
  walkTimelineRowBudget: MESSAGE_SEARCH_WALK_TIMELINE_ROW_BUDGET,
  relaxedTextMatchCap: MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP,
  visibleRootChannelIds,
};
let searchServiceDepsOverride: Partial<SearchServiceDeps> | null = null;

function resolveSearchServiceDeps(): SearchServiceDeps {
  return {
    ...defaultSearchServiceDeps,
    ...(searchServiceDepsOverride ?? {}),
  };
}

export function __setSearchServiceDepsForTests(overrides: Partial<SearchServiceDeps>): void {
  searchServiceDepsOverride = overrides;
}

export function __resetSearchServiceDepsForTests(): void {
  searchServiceDepsOverride = null;
}

function parseExplainJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new MessageSearchUnavailableError();
  }
}

/** @internal Strictly project only the root planner row estimate. */
export function readMessageSearchEstimatedCandidateRows(value: unknown): number {
  const parsed = parseExplainJson(value);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new MessageSearchUnavailableError();
  }
  const explain = parsed[0];
  if (!explain || typeof explain !== "object" || Array.isArray(explain)) {
    throw new MessageSearchUnavailableError();
  }
  const plan = (explain as Record<string, unknown>).Plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new MessageSearchUnavailableError();
  }
  const estimatedRows = (plan as Record<string, unknown>)["Plan Rows"];
  if (!Number.isInteger(estimatedRows) || (estimatedRows as number) < 0) {
    throw new MessageSearchUnavailableError();
  }
  return estimatedRows as number;
}

function isPostgresStatementTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "57014"
    && typeof candidate.message === "string"
    && /statement timeout/i.test(candidate.message);
}

function normalizeCreatedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeNullableTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeSeq(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function hasMeaningfulSearchFilter(params: {
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  signal?: AbortSignal;
}): boolean {
  return Boolean(params.channelId || params.senderId || params.senderType || params.mentionTarget || params.after || params.before);
}

function buildAnyTokenTsQuery(queryTokens: string[]): SQL | null {
  if (queryTokens.length === 0) return null;
  return queryTokens.slice(1).reduce(
    (acc, token) => sql`${acc} || plainto_tsquery('simple', ${token})`,
    sql`plainto_tsquery('simple', ${queryTokens[0]})`,
  );
}

interface SearchCandidateCtesParams {
  tsQuery: SQL | null;
  sort: MessageSearchSort;
  limit: number;
  offset: number;
  channelFilter: SQL;
  channelScopeFilter: SQL;
  /** The same channel scope as an array, for the GIN-driven text_matches set (see buildSearchFilters). */
  textMatchChannelScopeFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
  mentionTargetFilter: SQL;
  afterFilter: SQL;
  beforeFilter: SQL;
  /**
   * Recent sort with text only: "text_matches_first" collects the text matches
   * first (as relevance does) and orders the visible ones by time; "walk" (the
   * default, and a dense term with a channel filter) walks messages newest
   * first until LIMIT visible matches;
   * "server_timeline_walk" walks only this server's messages newest first
   * (message_server_timeline), for a dense term with no channel filter.
   */
  recentPlan?: MessageSearchRecentPlan;
  /** The searched server: bounds the server timeline walk. */
  serverId?: string;
  /** after/before on message_server_timeline.created_at (the walk's index range). */
  timelineRangeFilter?: SQL;
  /** The server timeline walk's window; see MessageSearchStatementParams.walkWindow. */
  walkWindow?: MessageSearchWalkWindow;
  /** See MessageSearchStatementParams.textMatchServerIds. */
  textMatchServerIds?: readonly string[];
  /** textMatchChannelScopeFilter on the timeline's channel_id. */
  timelineTextMatchChannelScopeFilter?: SQL;
}

/**
 * The rows one server timeline walk may read: strictly older than `from` (the
 * request's cursor) and no older than `through` (the row budget's last row,
 * absent when fewer rows than the budget remain).
 */
export interface MessageSearchWalkWindow {
  from?: MessageSearchWalkPosition;
  through?: MessageSearchWalkPosition;
  /** Rows the walk may read: the window size when `through` is set. */
  budget?: number;
}

function walkWindowFilterSql(window: MessageSearchWalkWindow | undefined): SQL {
  return sql`${window?.from
    ? sql`AND (t.created_at, t.message_id) < (${window.from.createdAt}::timestamptz, ${window.from.messageId}::uuid)`
    : sql``} ${window?.through
    ? sql`AND (t.created_at, t.message_id) >= (${window.through.createdAt}::timestamptz, ${window.through.messageId}::uuid)`
    : sql``}`;
}

/** @internal Exported so the production query-plan contract can be tested without a database. */
export function buildSearchCandidateCtes(params: SearchCandidateCtesParams): SQL {
  const searchVectorFilter = params.tsQuery ? sql`AND m.search_vector @@ (${params.tsQuery})` : sql``;
  // Recent sort ranks nothing, so either recent plan orders exactly like the
  // walk (created_at, then id) and a page never depends on the plan chosen.
  const matchedCandidateRank = params.tsQuery && params.sort === "relevance"
    ? sql`ts_rank_cd(mm.search_vector, (${params.tsQuery}))`
    : sql`0`;
  const matchedCandidateOrderBy = params.sort === "recent"
    ? sql`mm.created_at DESC, mm.id DESC`
    : sql`${matchedCandidateRank} DESC, mm.created_at DESC, mm.id DESC`;

  if (params.tsQuery && params.sort === "recent" && params.recentPlan === "server_timeline_walk") {
    if (!params.serverId) throw new Error("server_timeline_walk needs the searched serverId");
    // With search_server_gin_v0 on (textMatchServerIds set: the timeline's
    // search_vector is filled, verified equal to the message's and kept in step
    // by the trigger), the walk first tests the timeline's own copy, so a row
    // that does not match costs no messages read; only those rows fetch the
    // message, which is then re-checked like the server GIN match does, so a
    // stale copy can still only drop a message. Prod 11-11 (replica, LIMIT 21,
    // same term): 0.3 s instead of 1.5 s, 3.2 s instead of 8.7 s cold.
    const timelineVectorPrefilter = params.textMatchServerIds
      ? sql`AND (t.search_vector @@ (${params.tsQuery})) IS TRUE`
      : sql``;
    // Newest first over this server's messages only (0310 timeline, verified
    // 0 missing / 0 divergent before this plan was switched on), instead of
    // every server's through idx_messages_created_at. Visibility and every
    // filter still read the message itself (m.channel_id, not the timeline's
    // copy), so a stale timeline row can only drop a message, never show one.
    // The text match is written `(... @@ ...) IS TRUE` so it cannot become a
    // GIN index condition: on a server with few visible channels the planner
    // otherwise loops over them and runs BitmapAnd(channel index, GIN) per
    // channel, rescanning the term's whole match set each time (prod
    // 2026-10-03, apache-maka agent, 'means': 2,152 rescans, 27s) instead of
    // walking the timeline. Same rows: IS TRUE only differs from @@ on NULL,
    // which the WHERE clause drops either way.
    return sql`
      search_candidates AS (
        SELECT
          t.message_id AS "id",
          t.created_at AS "createdAt",
          0 AS "searchRank",
          ${walkCreatedAtTextSql(sql`t.created_at`)} AS "walkCreatedAt"
        FROM message_server_timeline t
        JOIN messages m
          ON m.id = t.message_id
        JOIN visible_channels vc
          ON vc.id = m.channel_id
        WHERE t.server_id = ${params.serverId}
          ${params.timelineRangeFilter ?? sql``}
          ${walkWindowFilterSql(params.walkWindow)}
          AND (
            m.message_type = 'chat'
            OR EXISTS (
              SELECT 1
              FROM agent_migration_receipt_channels receipt_surface
              WHERE receipt_surface.channel_id = m.channel_id
            )
            OR EXISTS (
              SELECT 1
              FROM agent_private_surfaces private_surface
              WHERE private_surface.channel_id = m.channel_id
            )
          )
          ${params.channelFilter}
          ${params.senderFilter}
          ${params.senderTypeFilter}
          ${params.mentionTargetFilter}
          ${params.afterFilter}
          ${params.beforeFilter}
          ${timelineVectorPrefilter}
          AND (m.search_vector @@ (${params.tsQuery})) IS TRUE
        ORDER BY t.created_at DESC, t.message_id DESC
        LIMIT ${params.limit + 1}
        OFFSET ${params.offset}
      )`;
  }

  if (!params.tsQuery || (params.sort === "recent" && params.recentPlan !== "text_matches_first")) {
    return sql`
      search_candidates AS (
        SELECT
          m.id AS "id",
          m.created_at AS "createdAt",
          0 AS "searchRank"
        FROM visible_channels vc
        JOIN messages m
          ON m.channel_id = vc.id
        WHERE (
          m.message_type = 'chat'
          OR EXISTS (
            SELECT 1
            FROM agent_migration_receipt_channels receipt_surface
            WHERE receipt_surface.channel_id = m.channel_id
          )
          OR EXISTS (
            SELECT 1
            FROM agent_private_surfaces private_surface
            WHERE private_surface.channel_id = m.channel_id
          )
        )
          ${params.channelFilter}
          ${params.channelScopeFilter}
          ${params.senderFilter}
          ${params.senderTypeFilter}
          ${params.mentionTargetFilter}
          ${params.afterFilter}
          ${params.beforeFilter}
          ${searchVectorFilter}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${params.limit + 1}
        OFFSET ${params.offset}
      )`;
  }

  // Relevance (and recent sort on a term with a bounded match set): collect
  // the text matches first, then keep the visible ones.
  // Joining visible_channels to messages instead leaves the join order to the
  // planner, which misestimates the thread arms (every thread in the server
  // joined to a filtered parent set reads as a few dozen rows) and then runs
  // the GIN match once per visible channel: 23k loops, 29s for one Botiverse
  // agent. Here the GIN match runs once, and the planner only picks how to join
  // text_matches to visible_channels, which is cheap either way.
  // text_matches holds only ids from every server (a GIN index cannot be
  // narrowed to one), bounded by the breadth probe's corpus-wide estimate;
  // content and ranking only ever read visible rows.
  // search_server_gin_v0: the same match over the searched servers' timeline
  // rows only (idx_message_server_timeline_server_search), never every
  // server's. The timeline is derived, so matched_messages re-checks the
  // message itself (its channel and its own search_vector): a stale timeline
  // row can only drop a match, never show one. Sender filters need the
  // message, so they move to that step; the result is the same set.
  const serverGin = params.textMatchServerIds !== undefined;
  const textMatches = serverGin
    ? sql`
    text_matches AS MATERIALIZED (
      SELECT
        t.message_id AS id,
        t.channel_id AS channel_id
      FROM message_server_timeline t
      WHERE t.server_id = ANY(${uuidArray(params.textMatchServerIds ?? [])})
        AND t.search_vector @@ (${params.tsQuery})
        ${params.timelineTextMatchChannelScopeFilter ?? sql``}
        ${params.timelineRangeFilter ?? sql``}
    )`
    : sql`
    text_matches AS MATERIALIZED (
      SELECT
        m.id AS id,
        m.channel_id AS channel_id
      FROM messages m
      WHERE m.search_vector @@ (${params.tsQuery})
        ${params.textMatchChannelScopeFilter}
        ${params.senderFilter}
        ${params.senderTypeFilter}
        ${params.afterFilter}
        ${params.beforeFilter}
    )`;
  const serverGinRecheck = serverGin
    ? sql`
        AND m.channel_id = tm.channel_id
        AND m.search_vector @@ (${params.tsQuery})
        ${params.senderFilter}
        ${params.senderTypeFilter}
        ${params.afterFilter}
        ${params.beforeFilter}`
    : sql``;
  return sql`
    ${textMatches},
    matched_messages AS MATERIALIZED (
      SELECT
        m.id AS id,
        m.channel_id AS channel_id,
        m.created_at AS created_at,
        m.search_vector AS search_vector
      FROM text_matches tm
      JOIN visible_channels vc
        ON vc.id = tm.channel_id
      JOIN messages m
        ON m.id = tm.id
      WHERE (
        m.message_type = 'chat'
        OR EXISTS (
          SELECT 1
          FROM agent_migration_receipt_channels receipt_surface
          WHERE receipt_surface.channel_id = m.channel_id
        )
        OR EXISTS (
          SELECT 1
          FROM agent_private_surfaces private_surface
          WHERE private_surface.channel_id = m.channel_id
        )
      )
        ${params.channelFilter}
        ${params.mentionTargetFilter}
        ${serverGinRecheck}
    ),
    search_candidates AS (
      SELECT
        mm.id AS "id",
        mm.created_at AS "createdAt",
        ${matchedCandidateRank} AS "searchRank"
      FROM matched_messages mm
      ORDER BY ${matchedCandidateOrderBy}
      LIMIT ${params.limit + 1}
      OFFSET ${params.offset}
    )`;
}


export interface MessageSearchStatementParams {
  serverId: string;
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  sort: MessageSearchSort;
  recentPlan?: MessageSearchRecentPlan;
  /** server_timeline_walk only: the window the walk may read. */
  walkWindow?: MessageSearchWalkWindow;
  /**
   * search_server_gin_v0: the servers whose timeline rows the text match reads
   * (the searched server, plus the joint storage server of any visible joint
   * conversation). Unset: the corpus-wide match over messages.
   */
  textMatchServerIds?: readonly string[];
  limit: number;
  offset: number;
}

function buildSearchFilters(params: MessageSearchStatementParams) {
  const channelFilter = params.channelId
    ? sql`AND (m.channel_id = ${params.channelId} OR vc.parent_channel_id = ${params.channelId})`
    : sql``;
  // The channel filter without visibility: the channel and its live threads,
  // through idx_channels_thread_parent_channel. A superset of what
  // channelFilter passes (both visibility builders only admit live threads),
  // so messages can be narrowed to the filtered channel before visibility is
  // joined instead of scanning every visible channel.
  const channelScopeFilter = params.channelId
    ? sql`AND m.channel_id IN (
        SELECT ${params.channelId}::uuid
        UNION ALL
        SELECT scoped_thread.id
        FROM channels scoped_thread
        WHERE scoped_thread.parent_channel_id = ${params.channelId}
          AND scoped_thread.type = 'thread'
          AND scoped_thread.deleted_at IS NULL
        UNION ALL
        -- Task conversations (task v2), through idx_channels_task_parent_channel.
        SELECT scoped_task.id
        FROM channels scoped_task
        WHERE scoped_task.parent_channel_id = ${params.channelId}
          AND scoped_task.type = 'task'
          AND scoped_task.deleted_at IS NULL
      )`
    : sql``;
  // The same scope as an array, computed once (an InitPlan) before the text
  // match. As IN (subquery) the planner may instead run the GIN match once per
  // scoped channel (BitmapAnd with the channel index, one GIN rescan per thread)
  // whenever the term's estimate is small: 3,241 rescans, 4.8s for a 13k-match
  // term on a channel with 3,240 threads. The walk keeps the IN form: there the
  // scope is a per-row filter, which IN hashes and a parameter array does not.
  const textMatchChannelScopeArray = params.channelId
    ? sql`ARRAY(
        SELECT ${params.channelId}::uuid
        UNION ALL
        SELECT scoped_thread.id
        FROM channels scoped_thread
        WHERE scoped_thread.parent_channel_id = ${params.channelId}
          AND scoped_thread.type = 'thread'
          AND scoped_thread.deleted_at IS NULL
        UNION ALL
        -- Task conversations (task v2), through idx_channels_task_parent_channel.
        SELECT scoped_task.id
        FROM channels scoped_task
        WHERE scoped_task.parent_channel_id = ${params.channelId}
          AND scoped_task.type = 'task'
          AND scoped_task.deleted_at IS NULL
      )`
    : null;
  const textMatchChannelScopeFilter = textMatchChannelScopeArray
    ? sql`AND m.channel_id = ANY(${textMatchChannelScopeArray})`
    : sql``;
  // The same scope on the timeline's copy of channel_id (search_server_gin_v0).
  const timelineTextMatchChannelScopeFilter = textMatchChannelScopeArray
    ? sql`AND t.channel_id = ANY(${textMatchChannelScopeArray})`
    : sql``;
  const senderFilter = params.senderId
    ? sql`AND m.sender_id = ${params.senderId}`
    : sql``;
  const senderTypeFilter = params.senderType
    ? sql`AND m.sender_type = ${params.senderType}`
    : sql``;
  const mentionTargetFilter = params.mentionTarget
    ? sql`AND EXISTS (
        SELECT 1
        FROM message_mentions mm
        WHERE mm.message_id = m.id
          AND mm.server_id = ${params.serverId}
          AND mm.target_type = ${params.mentionTarget.targetType}
          AND mm.target_id = ${params.mentionTarget.targetId}
      )`
    : sql``;
  const afterFilter = params.after
    ? sql`AND m.created_at >= ${params.after}`
    : sql``;
  const beforeFilter = params.before
    ? sql`AND m.created_at <= ${params.before}`
    : sql``;
  const timelineRangeFilter = sql`${params.after ? sql`AND t.created_at >= ${params.after}` : sql``} ${params.before ? sql`AND t.created_at <= ${params.before}` : sql``}`;
  return { channelFilter, channelScopeFilter, textMatchChannelScopeFilter, timelineTextMatchChannelScopeFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter, timelineRangeFilter };
}

/**
 * @internal Single source of the full search statement: the service executes
 * exactly this, and the real-PG filter-only plan-shape contract EXPLAINs
 * exactly this — no drifting SQL copy in tests. Composes the same
 * buildSearchCandidateCtes the breadth-gated relevance path uses.
 */
export function buildMessageSearchStatement(
  visibleChannelsSql: SQL,
  params: MessageSearchStatementParams,
  tsQuery: SQL | null,
): SQL {
  const { channelFilter, channelScopeFilter, textMatchChannelScopeFilter, timelineTextMatchChannelScopeFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter, timelineRangeFilter } = buildSearchFilters(params);
  const finalOrderBy = !tsQuery
    ? sql`sc."createdAt" DESC, sc."id" DESC`
    : params.sort === "recent"
      ? sql`sc."createdAt" DESC, sc."searchRank" DESC, sc."id" DESC`
      : sql`sc."searchRank" DESC, sc."createdAt" DESC, sc."id" DESC`;
  const candidateCtes = buildSearchCandidateCtes({
    tsQuery,
    sort: params.sort,
    recentPlan: params.recentPlan,
    serverId: params.serverId,
    timelineRangeFilter,
    walkWindow: params.walkWindow,
    textMatchServerIds: params.textMatchServerIds,
    timelineTextMatchChannelScopeFilter,
    limit: params.limit,
    offset: params.offset,
    channelFilter,
    channelScopeFilter,
    textMatchChannelScopeFilter,
    senderFilter,
    senderTypeFilter,
    mentionTargetFilter,
    afterFilter,
    beforeFilter,
  });
  return sql`
        -- Keep the full-text/access pass narrow; enrich parent and sender fields
        -- only after LIMIT so profile joins do not run across every candidate hit.
        WITH visible_channels AS (
          ${visibleChannelsSql}
        ),
        ${candidateCtes}
        SELECT
          m.id AS "id",
          m.seq AS "seq",
          m.channel_id AS "channelId",
          CASE
            WHEN c.type = 'thread' THEN c.id::text
            ELSE m.thread_id
          END AS "threadId",
          c.parent_message_id AS "parentMessageId",
          pm.content AS "parentMessageContent",
          pm.created_at AS "parentMessageCreatedAt",
          COALESCE(pc.id, c.id) AS "parentChannelId",
          COALESCE(pc.name, c.name) AS "parentChannelName",
          COALESCE(pc.type, c.type) AS "parentChannelType",
          COALESCE(pc.archived_at, c.archived_at) AS "parentChannelArchivedAt",
          m.sender_id AS "senderId",
          m.sender_type AS "senderType",
          COALESCE(emaf.display_name, NULLIF(a.display_name, ''), a.name, NULLIF(u.display_name, ''), u.name, 'Unknown') AS "senderName",
          CASE
            WHEN epa.state = 'active'
             AND epa.public_url = emaf.avatar_url
             AND epa.source_digest = emaf.avatar_digest
            THEN epa.public_url
            ELSE NULL
          END AS "senderAvatarUrl",
          emaf.identity_kind AS "externalIdentityKind",
          CASE WHEN emaf.message_id IS NOT NULL THEN jsonb_build_object(
            'schema', 'external-message-provenance.v1',
            'provider', emaf.provider,
            'workspace_id', emaf.workspace_id,
            'conversation_id', emaf.external_conversation_id,
            'message_id', emaf.external_message_id,
            'actor_id', emaf.external_actor_id,
            'actor_kind', emaf.actor_kind,
            'projection_id', emaf.projection_id
          ) ELSE NULL END AS "externalMessage",
          c.name AS "channelName",
          c.type AS "channelType",
          c.archived_at AS "channelArchivedAt",
          -- RFC 077: sent by an assistant for its owner (the label the message list shows too).
          CASE WHEN da.id IS NOT NULL THEN jsonb_build_object(
            'id', da.id,
            'name', da.name,
            'displayName', COALESCE(NULLIF(da.display_name, ''), da.name),
            'avatarUrl', da.avatar_url,
            'deleted', da.deleted_at IS NOT NULL
          ) ELSE NULL END AS "delegatedBy",
          -- RFC 077: its owner retracted it (content is the placeholder).
          (m.delegated_by_agent_id IS NOT NULL AND m.deleted_at IS NOT NULL) AS "retracted",
          m.content AS "content",
          m.created_at AS "createdAt"${tsQuery && params.sort === "recent" && params.recentPlan === "server_timeline_walk"
            ? sql`,
          sc."walkCreatedAt" AS "walkCreatedAt"`
            : sql``}
        FROM search_candidates sc
        JOIN messages m
          ON m.id = sc.id
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN messages pm
          ON c.type = 'thread'
         AND pm.id = c.parent_message_id
        -- Task conversation (task v2): its parent channel is on the row.
        LEFT JOIN channels pc
          ON pc.id = COALESCE(pm.channel_id, CASE WHEN c.type = 'task' THEN c.parent_channel_id END)
        LEFT JOIN agents a
          ON m.sender_type = 'agent'
         AND a.id = NULLIF(m.sender_id, 'system')::uuid
        LEFT JOIN users u
          ON m.sender_type = 'user'
         AND u.id = NULLIF(m.sender_id, 'system')::uuid
        LEFT JOIN external_message_author_facts emaf
          ON m.sender_type = 'external_projection'
         AND emaf.message_id = m.id
        LEFT JOIN external_projection_avatar_artifacts epa
          ON epa.id = emaf.avatar_artifact_id
        LEFT JOIN agents da
          ON da.id = m.delegated_by_agent_id
        ORDER BY ${finalOrderBy}
      `;
}

/**
 * @internal The last row a server timeline walk may read: the budget's row,
 * counted newest first from the cursor within the after/before range, and the
 * row after it. Unless both exist, no more than the budget remain and the walk
 * reads them all. Reads only idx_message_server_timeline_server_created
 * (server_id, created_at, message_id), never messages.
 */
export function buildMessageSearchWalkFrontierSql(params: {
  serverId: string;
  after?: Date;
  before?: Date;
  from?: MessageSearchWalkPosition;
  budget: number;
}): SQL {
  return sql`
    SELECT
      ${walkCreatedAtTextSql(sql`t.created_at`)} AS "createdAt",
      t.message_id AS "messageId"
    FROM message_server_timeline t
    WHERE t.server_id = ${params.serverId}
      ${params.after ? sql`AND t.created_at >= ${params.after}` : sql``}
      ${params.before ? sql`AND t.created_at <= ${params.before}` : sql``}
      ${walkWindowFilterSql({ from: params.from })}
    ORDER BY t.created_at DESC, t.message_id DESC
    OFFSET ${params.budget - 1}
    LIMIT 2
  `;
}

interface SearchBreadthProbeParams {
  visibleChannelsSql: SQL;
  tsQuery: SQL;
  channelFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
  mentionTargetFilter: SQL;
  afterFilter: SQL;
  beforeFilter: SQL;
}

interface SearchTextMatchProbeParams {
  tsQuery: SQL;
  channelScopeFilter: SQL;
  senderFilter: SQL;
  senderTypeFilter: SQL;
}

/**
 * @internal The estimate for the relevance statement's text_matches set: the
 * same predicate over every server, planned but not executed.
 * It carries no date bound, not even one the caller asked for: the GIN index
 * reads every match of the term before any date filter, so a date only shrinks
 * the estimate, not the read. With dates in the probe, a common term plus a
 * narrow range was admitted and then ran to the statement timeout (`deploy`,
 * ~437k matches: 0.8 s for 1 day, 12 s for 7, >60 s for 30 on the 10-21 replica).
 */
export function buildMessageSearchTextMatchProbeSql(params: SearchTextMatchProbeParams): SQL {
  return sql`
    EXPLAIN (FORMAT JSON)
    SELECT m.id
    FROM messages m
    WHERE m.search_vector @@ (${params.tsQuery})
      ${params.channelScopeFilter}
      ${params.senderFilter}
      ${params.senderTypeFilter}
  `;
}

/**
 * @internal search_server_gin_v0's estimate for text_matches: the searched
 * servers' timeline rows matching the term, planned but not executed. Like the
 * corpus-wide probe it takes no dates (the index reads every match of the term
 * in those servers before any date filter).
 */
export function buildMessageSearchServerTextMatchProbeSql(params: {
  tsQuery: SQL;
  serverIds: readonly string[];
  timelineChannelScopeFilter: SQL;
}): SQL {
  return sql`
    EXPLAIN (FORMAT JSON)
    SELECT t.message_id
    FROM message_server_timeline t
    WHERE t.server_id = ANY(${uuidArray(params.serverIds)})
      AND t.search_vector @@ (${params.tsQuery})
      ${params.timelineChannelScopeFilter}
  `;
}

/**
 * @internal The searched servers' timeline rows matching the term, counted up
 * to cap + 1 (MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP): the exact size of
 * search_server_gin_v0's text_matches, before visibility, for any cap-sized
 * read. Same filters as that set.
 */
export function buildMessageSearchServerTextMatchCountSql(params: {
  tsQuery: SQL;
  serverIds: readonly string[];
  timelineChannelScopeFilter: SQL;
  timelineRangeFilter: SQL;
  cap: number;
}): SQL {
  return sql`
    SELECT count(*)::int AS "matches"
    FROM (
      SELECT 1
      FROM message_server_timeline t
      WHERE t.server_id = ANY(${uuidArray(params.serverIds)})
        AND t.search_vector @@ (${params.tsQuery})
        ${params.timelineChannelScopeFilter}
        ${params.timelineRangeFilter}
      LIMIT ${params.cap + 1}
    ) capped
  `;
}

/**
 * The visible messages a search can match, with its filters: the candidate
 * breadth probe's set, and (dates moved behind the plan's cutoff) the older
 * matches a Free search's window hides. `tsQuery` null: a filter-only search.
 */
function searchableMatchesSql(params: Omit<SearchBreadthProbeParams, "visibleChannelsSql" | "tsQuery"> & { tsQuery: SQL | null }): SQL {
  return sql`
    FROM visible_channels vc
    JOIN messages m
      ON m.channel_id = vc.id
    WHERE (
      m.message_type = 'chat'
      OR EXISTS (
        SELECT 1
        FROM agent_migration_receipt_channels receipt_surface
        WHERE receipt_surface.channel_id = m.channel_id
      )
      OR EXISTS (
        SELECT 1
        FROM agent_private_surfaces private_surface
        WHERE private_surface.channel_id = m.channel_id
      )
    )
      ${params.channelFilter}
      ${params.senderFilter}
      ${params.senderTypeFilter}
      ${params.mentionTargetFilter}
      ${params.afterFilter}
      ${params.beforeFilter}
      ${params.tsQuery ? sql`AND m.search_vector @@ (${params.tsQuery})` : sql``}
  `;
}

/** @internal Exported so the planner-admission contract can be verified without production data. */
export function buildMessageSearchBreadthProbeSql(params: SearchBreadthProbeParams): SQL {
  return sql`
    EXPLAIN (FORMAT JSON)
    WITH visible_channels AS (
      ${params.visibleChannelsSql}
    )
    SELECT m.id
    ${searchableMatchesSql(params)}
  `;
}

/**
 * @internal The matches a Free search's window hides (task #proj-commercial:#24,
 * F): the page's text match, visibility and filters, with the requested dates,
 * created before the plan's cutoff (the complement of the page's
 * `created_at >= cutoff`, so no message is in both), counted up to cap + 1.
 *
 * `fallbackTsQuery`, for a search whose page never ran (its range is all
 * behind the window): as the page would, any of the words when no message has
 * all of them (Cody). Still one statement under one deadline: the any-word
 * count is a CASE branch, evaluated only when the all-words count is 0.
 */
export function buildMessageSearchOlderHiddenCountSql(params: Omit<SearchBreadthProbeParams, "tsQuery"> & {
  tsQuery: SQL | null;
  fallbackTsQuery?: SQL | null;
  historyCutoff: Date;
  cap: number;
}): SQL {
  const capped = (tsQuery: SQL | null) => sql`(
      SELECT count(*)
      FROM (
        SELECT 1
        ${searchableMatchesSql({ ...params, tsQuery })}
          AND m.created_at < ${params.historyCutoff}
        LIMIT ${params.cap + 1}
      ) capped
    )`;
  if (!params.fallbackTsQuery) {
    return sql`
    WITH visible_channels AS (
      ${params.visibleChannelsSql}
    )
    SELECT ${capped(params.tsQuery)}::int AS "hidden"
  `;
  }
  return sql`
    WITH visible_channels AS (
      ${params.visibleChannelsSql}
    ), all_words AS MATERIALIZED (
      SELECT ${capped(params.tsQuery)} AS "hidden"
    )
    SELECT (
      CASE WHEN all_words."hidden" > 0 THEN all_words."hidden" ELSE ${capped(params.fallbackTsQuery)} END
    )::int AS "hidden"
    FROM all_words
  `;
}

function createBreadthProbeAbort(parentSignal?: AbortSignal, timeoutMs = MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setClockTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Message search breadth probe timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearClockTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

/**
 * Search stays inside the plan's message history, like every read path: on a
 * free server it finds only the last N days, so no hit points at a message the
 * viewer cannot open. Returns the lower bound to search from, or null when the
 * requested range ends before the history starts and nothing can match.
 */
export function searchAfterWithinHistory(
  after: Date | undefined,
  before: Date | undefined,
  historyCutoff: Date | undefined,
): Date | undefined | null {
  if (!historyCutoff) return after;
  if (before && before < historyCutoff) return null;
  return after && after > historyCutoff ? after : historyCutoff;
}

/**
 * search_server_gin_v0 off (or unreadable): undefined, the corpus-wide match.
 * On: the searched server, plus the server holding the storage channels of the
 * visible joint conversations (all in the joint storage server today; looked
 * up rather than assumed, and only when there are any).
 */
async function resolveTextMatchServerIds(
  deps: SearchServiceDeps,
  serverId: string,
  jointStorageChannelIds: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  if (!await deps.isServerSearchGinEnabled(serverId).catch(() => false)) return undefined;
  if (jointStorageChannelIds.length === 0) return [serverId];
  const storage = await deps.executeSearchSql<{ serverId: string }>(sql`
    SELECT DISTINCT c.server_id::text AS "serverId"
    FROM channels c
    WHERE c.id = ANY(${uuidArray(jointStorageChannelIds)})
      AND c.server_id <> ${serverId}
  `, { signal });
  return [serverId, ...storage.rows.map((row) => row.serverId)];
}

/**
 * How many matches a Free agent search's window hides (MessageSearchPage.olderHidden),
 * on the first page of a search whose dates reach behind the cutoff; else
 * undefined. Fail-open (Tenny): its own deadline, and any failure, give
 * undefined, never a failed search. The span and the event record how long
 * it took and whether it timed out.
 */
async function countOlderHiddenMatches(
  deps: SearchServiceDeps,
  visibleChannelsSql: SQL,
  requestedParams: Parameters<typeof searchMessages>[1],
  tsQuery: SQL | null,
  fallbackTsQuery: SQL | null = null,
): Promise<MessageSearchOlderHidden | undefined> {
  const cutoff = requestedParams.historyCutoff;
  if (!requestedParams.countOlderHidden || !cutoff || requestedParams.offset !== 0 || requestedParams.cursor) return undefined;
  if (requestedParams.after && requestedParams.after >= cutoff) return undefined;
  if (requestedParams.signal?.aborted) return undefined;
  const { channelFilter, senderFilter, senderTypeFilter, mentionTargetFilter, afterFilter, beforeFilter } = buildSearchFilters(requestedParams);
  const abort = createBreadthProbeAbort(requestedParams.signal, MESSAGE_SEARCH_OLDER_HIDDEN_TIMEOUT_MS);
  const startedAt = performance.now();
  try {
    const hidden = await traceQuerySpan({
      queryName: "messages.search.older_hidden_count",
      phase: "older_hidden_count",
      dbSystem: "postgresql",
      attrs: {
        search_text_present: Boolean(tsQuery),
        older_hidden_cap: MESSAGE_SEARCH_OLDER_HIDDEN_CAP,
        older_hidden_timeout_ms: MESSAGE_SEARCH_OLDER_HIDDEN_TIMEOUT_MS,
      },
      successAttrs: (count) => ({ older_hidden_rows: count, duration_ms: Math.round(performance.now() - startedAt) }),
    }, async () => {
      const counted = await deps.executeSearchSql<{ hidden: number | string }>(buildMessageSearchOlderHiddenCountSql({
        visibleChannelsSql,
        tsQuery,
        fallbackTsQuery,
        channelFilter,
        senderFilter,
        senderTypeFilter,
        mentionTargetFilter,
        afterFilter,
        beforeFilter,
        historyCutoff: cutoff,
        cap: MESSAGE_SEARCH_OLDER_HIDDEN_CAP,
      }), { signal: abort.signal });
      return Number(counted.rows[0]?.hidden ?? 0);
    });
    return { count: Math.min(hidden, MESSAGE_SEARCH_OLDER_HIDDEN_CAP), capped: hidden > MESSAGE_SEARCH_OLDER_HIDDEN_CAP };
  } catch (error) {
    addTraceEvent("message_search.older_hidden.skipped", {
      reason: abort.didTimeout() ? "timeout" : requestedParams.signal?.aborted ? "client_aborted" : "query_failed",
      older_hidden_timed_out: abort.didTimeout(),
      duration_ms: Math.round(performance.now() - startedAt),
      ...messageSearchErrorTraceAttrs(error),
    });
    return undefined;
  } finally {
    abort.cleanup();
  }
}

async function searchMessages(
  visibleChannelsSql: SQL,
  requestedParams: {
    serverId: string;
    channelId?: string;
    senderId?: string;
    senderType?: MessageSearchSenderType;
    mentionTarget?: MessageSearchMentionTarget;
    after?: Date;
    before?: Date;
    /** The plan's history cutoff (planService.getHistoryCutoff); undefined on unlimited plans. */
    historyCutoff: Date | undefined;
    sort: MessageSearchSort;
    limit: number;
    offset: number;
    /** Recent-sort text search only (routes reject it otherwise): continue a timeline walk. */
    cursor?: MessageSearchWalkCursor;
    signal?: AbortSignal;
    /** Storage channels of the visible joint conversations (their messages live in the joint storage server). */
    jointStorageChannelIds?: readonly string[];
    /**
     * Count the matches the plan's window hides (olderHidden). Agent search
     * only: a person's search stays as it is (cindyz, task #24, 2026-11-12).
     */
    countOlderHidden?: boolean;
  },
  query: string,
  /**
   * The same visible set, shaped for the recent walk: that plan checks
   * visibility once per message it passes (newest first), so the set must be
   * a per-channel primary-key lookup the planner can memoize, not a UNION the
   * planner re-runs per row. Defaults to visibleChannelsSql.
   */
  walkVisibleChannelsSql: SQL = visibleChannelsSql,
): Promise<MessageSearchPage> {
  const walkFrom = requestedParams.cursor ? decodeMessageSearchWalkCursor(requestedParams.cursor) ?? undefined : undefined;
  if (requestedParams.cursor && !walkFrom) throw new Error("Invalid message search cursor");
  const queryTokens = tokenizeSearchText(query);
  const searchText = queryTokens.join(" ");
  const hasSearchText = Boolean(searchText);
  if (!hasSearchText && !hasMeaningfulSearchFilter(requestedParams)) {
    return { results: [], hasMore: false };
  }
  const strictTsQuery = hasSearchText ? sql`plainto_tsquery('simple', ${searchText})` : null;
  const fallbackTsQuery = hasSearchText && queryTokens.length > 1 ? buildAnyTokenTsQuery(queryTokens) : null;
  const deps = resolveSearchServiceDeps();
  const after = searchAfterWithinHistory(requestedParams.after, requestedParams.before, requestedParams.historyCutoff);
  if (after === null) {
    // The whole range is behind the window: the page is empty, and the count
    // says whether that is "nothing matches" or "hidden".
    const olderHidden = await countOlderHiddenMatches(deps, visibleChannelsSql, requestedParams, strictTsQuery, fallbackTsQuery);
    return { results: [], hasMore: false, ...(olderHidden ? { olderHidden } : {}) };
  }
  // Relevance over its text-match cap is answered as the recent sort
  // (relevanceFallback); a cursor only ever continues such a page.
  let relevanceFallback = requestedParams.sort === "relevance" && Boolean(walkFrom);
  let membershipParams = { ...requestedParams, after, ...(relevanceFallback ? { sort: "recent" as const } : {}) };
  const { channelFilter, channelScopeFilter, timelineTextMatchChannelScopeFilter, timelineRangeFilter, senderFilter, senderTypeFilter, mentionTargetFilter } = buildSearchFilters(membershipParams);
  // The plan's history cutoff never enters a breadth probe: a Free server is
  // refused or admitted exactly as an unlimited one, and only the result
  // statements are cut. The candidate probe keeps the dates the caller asked
  // for; the corpus-wide text-match probe takes no dates at all (see
  // buildMessageSearchTextMatchProbeSql).
  const { afterFilter: probeAfterFilter, beforeFilter: probeBeforeFilter } = buildSearchFilters(requestedParams);

  const queryStart = performance.now();
  // search_server_gin_v0: the servers the text match reads. Joint
  // conversations' messages live in their storage channels' server.
  const textMatchServerIds = hasSearchText
    ? await resolveTextMatchServerIds(deps, membershipParams.serverId, requestedParams.jointStorageChannelIds ?? [], membershipParams.signal)
    : undefined;
  const textMatchSource = textMatchServerIds ? "server_gin" : "corpus_gin";
  let rows: { rows: SearchRow[] };
  let fallbackUsed = false;
  // The any-term fallback was over MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP and not run.
  let relaxedSkipped = false;
  // Planner estimate of the text matches over every server (not executed),
  // classified against the corpus-wide cap relevance admits.
  const probeTextMatchBreadth = async (tsQuery: SQL, signal: AbortSignal): Promise<"within_limit" | "over_limit"> =>
    (await probeTextMatchEstimate(tsQuery, signal)).relevanceVerdict;
  const probeTextMatchEstimate = async (
    tsQuery: SQL,
    signal: AbortSignal,
  ): Promise<{ relevanceVerdict: "within_limit" | "over_limit"; estimatedTextMatchRows: number }> => {
    if (textMatchServerIds) {
      const serverMatch = await traceQuerySpan({
        queryName: "messages.search.text_match_breadth",
        phase: "text_match_breadth_probe",
        dbSystem: "postgresql",
        attrs: {
          search_text_present: true,
          query_plan_shape: "fts_explain_estimate",
          search_text_match_source: textMatchSource,
          search_text_match_server_count: textMatchServerIds.length,
          estimated_text_match_limit: MESSAGE_SEARCH_SERVER_GIN_ESTIMATED_TEXT_MATCH_LIMIT,
          probe_timeout_ms: MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
        },
        successAttrs: (rows) => ({ estimated_text_match_rows: rows }),
      }, async () => {
        const explain = await deps.executeSearchSql<SearchBreadthProbeRow>(buildMessageSearchServerTextMatchProbeSql({
          tsQuery,
          serverIds: textMatchServerIds,
          timelineChannelScopeFilter: timelineTextMatchChannelScopeFilter,
        }), { signal });
        if (explain.rows.length !== 1) throw new MessageSearchUnavailableError();
        return readMessageSearchEstimatedCandidateRows(explain.rows[0]?.["QUERY PLAN"]);
      });
      return {
        relevanceVerdict: serverMatch > MESSAGE_SEARCH_SERVER_GIN_ESTIMATED_TEXT_MATCH_LIMIT ? "over_limit" : "within_limit",
        estimatedTextMatchRows: serverMatch,
      };
    }
    const textMatch = await traceQuerySpan({
      queryName: "messages.search.text_match_breadth",
      phase: "text_match_breadth_probe",
      dbSystem: "postgresql",
      attrs: {
        search_text_present: true,
        query_plan_shape: "fts_explain_estimate",
        estimated_text_match_limit: MESSAGE_SEARCH_RELEVANCE_ESTIMATED_TEXT_MATCH_LIMIT,
        probe_timeout_ms: MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
      },
      successAttrs: (probe) => ({
        estimated_text_match_rows: probe.estimatedTextMatchRows,
        corpus_rows: probe.corpusRows,
      }),
    }, async () => {
      const [explain, corpus] = await Promise.all([
        deps.executeSearchSql<SearchBreadthProbeRow>(buildMessageSearchTextMatchProbeSql({
          tsQuery,
          channelScopeFilter,
          senderFilter,
          senderTypeFilter,
        }), { signal }),
        deps.executeSearchSql<{ corpus_rows: unknown }>(
          sql`SELECT reltuples::float8 AS corpus_rows FROM pg_class WHERE oid = 'messages'::regclass`,
          { signal },
        ),
      ]);
      if (explain.rows.length !== 1 || corpus.rows.length !== 1) throw new MessageSearchUnavailableError();
      return {
        estimatedTextMatchRows: readMessageSearchEstimatedCandidateRows(explain.rows[0]?.["QUERY PLAN"]),
        corpusRows: Number(corpus.rows[0]?.corpus_rows),
      };
    });
    return {
      relevanceVerdict: classifyMessageSearchTextMatchBreadth(textMatch.estimatedTextMatchRows, textMatch.corpusRows),
      estimatedTextMatchRows: textMatch.estimatedTextMatchRows,
    };
  };
  const probeSearchBreadth = async (tsQuery: SQL): Promise<"within_limit" | "over_limit"> => {
    const abort = createBreadthProbeAbort(membershipParams.signal);
    try {
      const result = await traceQuerySpan({
        queryName: "messages.search.breadth",
        phase: "candidate_breadth_probe",
        dbSystem: "postgresql",
        attrs: {
          ...messageSearchParamTraceAttrs({
            queryTokenCount: queryTokens.length,
            query,
            channelId: membershipParams.channelId,
            senderId: membershipParams.senderId,
            after: requestedParams.after,
            before: requestedParams.before,
            sort: membershipParams.sort,
            limit: membershipParams.limit,
            offset: membershipParams.offset,
          }),
          search_text_present: true,
          query_plan_shape: "fts_explain_estimate",
          estimated_candidate_limit: MESSAGE_SEARCH_RELEVANCE_ESTIMATED_CANDIDATE_LIMIT,
          probe_timeout_ms: MESSAGE_SEARCH_BREADTH_PROBE_TIMEOUT_MS,
        },
        successAttrs: (probeResult) => ({
          estimated_candidate_rows: readMessageSearchEstimatedCandidateRows(probeResult.rows[0]?.["QUERY PLAN"]),
        }),
      }, () => deps.executeSearchSql<SearchBreadthProbeRow>(buildMessageSearchBreadthProbeSql({
        visibleChannelsSql,
        tsQuery,
        channelFilter,
        senderFilter,
        senderTypeFilter,
        mentionTargetFilter,
        afterFilter: probeAfterFilter,
        beforeFilter: probeBeforeFilter,
      }), { signal: abort.signal }));
      if (result.rows.length !== 1) throw new MessageSearchUnavailableError();
      if (classifyMessageSearchBreadth(readMessageSearchEstimatedCandidateRows(result.rows[0]?.["QUERY PLAN"])) === "over_limit") {
        return "over_limit";
      }
      // The relevance statement reads the text matches of every server before
      // visibility (see buildSearchCandidateCtes), so bound that set too.
      return await probeTextMatchBreadth(tsQuery, abort.signal);
    } catch (error) {
      if (abort.didTimeout() && !membershipParams.signal?.aborted && isSearchQueryAbortedError(error)) {
        throw new MessageSearchTimeoutError();
      }
      if (isPostgresStatementTimeout(error)) throw new MessageSearchTimeoutError();
      if (isMessageSearchPublicError(error) || isSearchQueryAbortedError(error)) throw error;
      throw new MessageSearchUnavailableError({ cause: error });
    } finally {
      abort.cleanup();
    }
  };
  // Recent sort never rejects. Without a channel filter a term within
  // MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT takes text matches
  // first and a denser one walks the server timeline under the row budget;
  // with one the relevance cap decides, as the channel walk has no budget.
  // A failed probe walks. A cursor continues a timeline walk.
  let recentPlanEstimatedTextMatchRows: number | undefined;
  const chooseRecentPlan = async (tsQuery: SQL): Promise<MessageSearchRecentPlan> => {
    if (walkFrom) return "server_timeline_walk";
    const timelineWalkAvailable = !membershipParams.channelId;
    const abort = createBreadthProbeAbort(membershipParams.signal);
    let estimate: Awaited<ReturnType<typeof probeTextMatchEstimate>>;
    try {
      estimate = await probeTextMatchEstimate(tsQuery, abort.signal);
    } catch (error) {
      if (membershipParams.signal?.aborted) throw error;
      return timelineWalkAvailable ? "server_timeline_walk" : "walk";
    } finally {
      abort.cleanup();
    }
    recentPlanEstimatedTextMatchRows = estimate.estimatedTextMatchRows;
    if (timelineWalkAvailable) {
      return chooseMessageSearchRecentPlan(estimate.estimatedTextMatchRows) === "walk"
        ? "server_timeline_walk"
        : "text_matches_first";
    }
    return estimate.relevanceVerdict === "within_limit" ? "text_matches_first" : "walk";
  };
  // The last row the timeline walk may read (null: no more than the budget remain).
  const loadWalkFrontier = async (): Promise<MessageSearchWalkPosition | null> => {
    const frontier = await traceQuerySpan({
      queryName: "messages.search.walk_frontier",
      phase: "walk_budget_frontier",
      dbSystem: "postgresql",
      attrs: {
        search_walk_budget_rows: deps.walkTimelineRowBudget,
        search_walk_cursor_present: Boolean(walkFrom),
      },
      successAttrs: (result) => ({ row_count: result.rows.length }),
    }, () => deps.executeSearchSql<{ createdAt: string; messageId: string }>(buildMessageSearchWalkFrontierSql({
      serverId: membershipParams.serverId,
      after: membershipParams.after,
      before: membershipParams.before,
      from: walkFrom,
      budget: deps.walkTimelineRowBudget,
    }), { signal: membershipParams.signal }));
    const row = frontier.rows[0];
    return row && frontier.rows.length > 1 ? { createdAt: row.createdAt, messageId: row.messageId } : null;
  };
  // The window of the last timeline walk run (undefined: another plan ran).
  let lastWalkWindow: MessageSearchWalkWindow | undefined;
  const executeSearch = async (tsQuery: SQL | null, mode: "strict_all_terms" | "relaxed_any_term") => {
    const breadth = tsQuery && membershipParams.sort === "relevance"
      ? await probeSearchBreadth(tsQuery)
      : "within_limit";
    if (breadth === "over_limit") {
      // Too many matches to rank: not refused, answered newest first under
      // the recent sort's bounded plans, and marked so the caller can say so.
      relevanceFallback = true;
      membershipParams = { ...membershipParams, sort: "recent" };
    }
    const recentPlan: MessageSearchRecentPlan | undefined = tsQuery && membershipParams.sort === "recent"
      ? await chooseRecentPlan(tsQuery)
      : undefined;
    let walkWindow: MessageSearchWalkWindow | undefined;
    if (recentPlan === "server_timeline_walk") {
      const through = await loadWalkFrontier();
      walkWindow = { ...(walkFrom ? { from: walkFrom } : {}), ...(through ? { through } : {}), budget: deps.walkTimelineRowBudget };
    }
    lastWalkWindow = walkWindow;
    return traceQuerySpan({
      queryName: "messages.search",
      phase: "visibility_candidates_enrich",
      dbSystem: "postgresql",
      attrs: {
        ...messageSearchParamTraceAttrs({
          queryTokenCount: queryTokens.length,
          query,
          channelId: membershipParams.channelId,
          senderId: membershipParams.senderId,
          after: membershipParams.after,
          before: membershipParams.before,
          sort: membershipParams.sort,
          limit: membershipParams.limit,
          offset: membershipParams.offset,
        }),
        search_text_present: hasSearchText,
        query_match_mode: mode,
        ...(tsQuery ? { search_text_match_source: textMatchSource } : {}),
        ...(recentPlan
          ? {
            search_recent_plan: recentPlan === "server_timeline_walk"
              ? "timeline_walk"
              : recentPlan === "walk" ? "legacy_walk" : "collect_first",
            ...(recentPlanEstimatedTextMatchRows === undefined
              ? {}
              : { recent_plan_estimated_text_match_rows: recentPlanEstimatedTextMatchRows }),
          }
          : {}),
        ...(walkWindow
          ? {
            search_walk_budget_rows: deps.walkTimelineRowBudget,
            search_walk_cursor_present: Boolean(walkWindow.from),
          }
          : {}),
        query_plan_shape: !tsQuery
          ? "page_first_single_statement"
          : recentPlan === "server_timeline_walk"
            ? "fts_recent_server_timeline"
            : recentPlan === "walk"
              ? "fts_recent_page_first"
              : recentPlan === "text_matches_first"
                ? "fts_recent_text_matches_first"
                : "fts_text_matches_first",
      },
      successAttrs: (result) => ({
        row_count: result.rows.length,
        ...(walkWindow
          ? { search_walk_budget_exhausted: Boolean(walkWindow.through) && result.rows.length <= membershipParams.limit }
          : {}),
      }),
    }, () => deps.executeSearchSql<SearchRow>(
      buildMessageSearchStatement(
        recentPlan === "walk" || recentPlan === "server_timeline_walk" ? walkVisibleChannelsSql : visibleChannelsSql,
        { ...membershipParams, recentPlan, walkWindow, textMatchServerIds },
        tsQuery,
      ),
      { signal: membershipParams.signal },
    ));
  };
  // Relevance with search_server_gin_v0: whether the any-term fallback has more
  // text matches than it may rank (see MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP).
  const relaxedOverCap = async (tsQuery: SQL): Promise<boolean> => {
    if (!textMatchServerIds || membershipParams.sort !== "relevance") return false;
    const matches = await traceQuerySpan({
      queryName: "messages.search.relaxed_text_match_count",
      phase: "relaxed_text_match_cap",
      dbSystem: "postgresql",
      attrs: {
        search_text_present: true,
        query_match_mode: "relaxed_any_term",
        search_text_match_source: textMatchSource,
        search_text_match_server_count: textMatchServerIds.length,
        relaxed_text_match_cap: deps.relaxedTextMatchCap,
      },
      successAttrs: (count) => ({ relaxed_text_match_rows: count }),
    }, async () => {
      const counted = await deps.executeSearchSql<{ matches: number | string }>(buildMessageSearchServerTextMatchCountSql({
        tsQuery,
        serverIds: textMatchServerIds,
        timelineChannelScopeFilter: timelineTextMatchChannelScopeFilter,
        timelineRangeFilter,
        cap: deps.relaxedTextMatchCap,
      }), { signal: membershipParams.signal });
      return Number(counted.rows[0]?.matches ?? 0);
    });
    return matches > deps.relaxedTextMatchCap;
  };
  try {
    rows = await executeSearch(strictTsQuery, "strict_all_terms");
    // An exhausted walk has not finished looking for all the terms, so it
    // returns incomplete instead of falling back to any term.
    const strictWalkIncomplete = Boolean(lastWalkWindow?.through) && rows.rows.length <= membershipParams.limit;
    if (rows.rows.length === 0 && fallbackTsQuery && membershipParams.offset === 0 && !strictWalkIncomplete && !relevanceFallback) {
      if (await relaxedOverCap(fallbackTsQuery)) {
        // Too many messages match some term to rank them: the page stays the
        // all-terms search's empty one, marked so the caller can narrow it.
        relaxedSkipped = true;
      } else {
        fallbackUsed = true;
        rows = await executeSearch(fallbackTsQuery, "relaxed_any_term");
      }
    }
  } catch (error) {
    const aborted = isSearchQueryAbortedError(error);
    const publicError = isPostgresStatementTimeout(error)
      ? new MessageSearchTimeoutError()
      : error;
    addTraceEvent("message_search.query.failed", {
      ...messageSearchParamTraceAttrs({
        queryTokenCount: queryTokens.length,
        query,
        channelId: membershipParams.channelId,
        senderId: membershipParams.senderId,
        senderType: membershipParams.senderType,
        mentionTarget: membershipParams.mentionTarget ? "self" : undefined,
        after: membershipParams.after,
        before: membershipParams.before,
        sort: membershipParams.sort,
        limit: membershipParams.limit,
        offset: membershipParams.offset,
      }),
      outcome: aborted ? "canceled" : "error",
      reason: aborted ? "client_aborted" : "query_failed",
      query_name: "messages.search",
      duration_ms: Math.round(performance.now() - queryStart),
      search_text_present: hasSearchText,
      query_match_mode: fallbackUsed ? "relaxed_any_term" : "strict_all_terms",
      ...messageSearchErrorTraceAttrs(error, { query }),
    });
    throw publicError;
  }

  const overFetched = rows.rows.length > membershipParams.limit;
  const hasMore = !fallbackUsed && overFetched;
  const visibleRows = overFetched ? rows.rows.slice(0, membershipParams.limit) : rows.rows;
  // A timeline walk whose budget row exists and whose page did not fill read
  // its whole window: the matches below that row were never looked at.
  const walkThrough = lastWalkWindow?.through;
  const incomplete = Boolean(walkThrough) && !overFetched;
  const lastVisibleRow = visibleRows[visibleRows.length - 1];
  const nextWalkPosition: MessageSearchWalkPosition | undefined = !lastWalkWindow
    ? undefined
    : incomplete
      ? walkThrough
      : hasMore && lastVisibleRow?.walkCreatedAt
        ? { createdAt: lastVisibleRow.walkCreatedAt, messageId: lastVisibleRow.id }
        : undefined;
  if (visibleRows.some((row) => row.senderType === "external_projection" && !row.externalMessage)) {
    throw new Error("External projection search row is missing immutable author fact");
  }
  addTraceEvent("message_search.query.finished", {
    ...messageSearchParamTraceAttrs({
      queryTokenCount: queryTokens.length,
      query,
      channelId: membershipParams.channelId,
      senderId: membershipParams.senderId,
      senderType: membershipParams.senderType,
      mentionTarget: membershipParams.mentionTarget ? "self" : undefined,
      after: membershipParams.after,
      before: membershipParams.before,
      sort: membershipParams.sort,
      limit: membershipParams.limit,
      offset: membershipParams.offset,
    }),
    outcome: "success",
    reason: "query_completed",
    query_name: "messages.search",
    duration_ms: Math.round(performance.now() - queryStart),
    search_text_present: hasSearchText,
    query_match_mode: fallbackUsed ? "relaxed_any_term" : "strict_all_terms",
    row_count: rows.rows.length,
    visible_row_count: visibleRows.length,
    has_more: hasMore,
    ...(lastWalkWindow ? { search_walk_budget_exhausted: incomplete } : {}),
    ...(relaxedSkipped ? { relaxed_skipped: "too_broad" } : {}),
    ...(relevanceFallback ? { relevance_fallback: "too_broad" } : {}),
  });

  const [hitTasks, olderHidden] = await Promise.all([
    loadSearchHitTasks(visibleRows),
    countOlderHiddenMatches(deps, visibleChannelsSql, requestedParams, fallbackUsed ? fallbackTsQuery : strictTsQuery),
  ]);
  return {
    hasMore,
    ...(olderHidden ? { olderHidden } : {}),
    ...(incomplete && walkThrough
      ? {
        incomplete: true as const,
        searchedThrough: new Date(walkThrough.createdAt).toISOString(),
        searchedMessages: lastWalkWindow?.budget ?? 0,
      }
      : {}),
    ...(nextWalkPosition ? { nextCursor: encodeMessageSearchWalkCursor(nextWalkPosition) } : {}),
    ...(relaxedSkipped ? { relaxedSkipped: "too_broad" as const } : {}),
    ...(relevanceFallback ? { relevanceFallback: "too_broad" as const } : {}),
    results: visibleRows.map(({ walkCreatedAt: _walkCreatedAt, parentMessageCreatedAt, externalIdentityKind, ...row }) => ({
      ...row,
      externalMessage: row.externalMessage ? legacyAgentProvenance(row.externalMessage, externalIdentityKind) ?? null : null,
      // A hit inside the window whose thread starts behind it: the first
      // message keeps a 40-character preview, as in Activity and the saved list
      // (services/historyPreview.ts; cindyz, #proj-commercial task #8).
      parentMessageContent: isParentBehindHistory(parentMessageCreatedAt, requestedParams.historyCutoff)
        ? historyLimitedPreview(row.parentMessageContent)
        : row.parentMessageContent,
      seq: normalizeSeq(row.seq),
      snippet: buildSnippet(row.content, queryTokens),
      createdAt: normalizeCreatedAt(row.createdAt),
      channelArchivedAt: normalizeNullableTimestamp(row.channelArchivedAt),
      parentChannelArchivedAt: normalizeNullableTimestamp(row.parentChannelArchivedAt),
      ...(hitTasks.get(row.channelId) ?? {}),
    })),
  };
}

/**
 * The visible_channels set of a search: (id, parent_channel_id) for every
 * channel whose messages the viewer may see, from the visibility entry
 * (visibilityService.visibleRootChannelIds), so search answers exactly what
 * canView answers. parent_channel_id is the row's root: the channel itself,
 * or a thread's or task conversation's parent (channels.parent_channel_id,
 * 0297; a task conversation carries it from the start), so resolving
 * visibility never reads messages.
 *
 * Joint conversations are searched in their canonical storage (where their
 * messages live, outside this server): the storage channel of each visible
 * joint root, and the canonical threads under it. Results are projected back
 * to local ids (projectJointSearchResults). The server timeline walk reads
 * this server's timeline only, so it does not reach joint messages.
 *
 * This form enumerates the set from the root side: the roots by primary key,
 * their live threads through idx_channels_thread_parent_channel
 * (parent_channel_id, id) and their task conversations (task v2) through
 * idx_channels_task_parent_channel, so the cost follows the visible roots,
 * not every thread in the server. A local thread must be in this server too.
 */
export function buildVisibleConversationChannelsSql(roots: VisibleRoots): SQL {
  const storageIds = jointStorageRootIds(roots);
  const localRootIds = roots.roots.map((root) => root.id);
  return sql`
    SELECT
      root_channels.id AS id,
      root_channels.id AS parent_channel_id
    FROM channels root_channels
    WHERE root_channels.id = ANY(${uuidArray(visibleConversationRootIds(roots))})
      AND root_channels.deleted_at IS NULL

    UNION ALL

    SELECT
      tc.id AS id,
      tc.parent_channel_id AS parent_channel_id
    FROM channels tc
    WHERE tc.parent_channel_id = ANY(${uuidArray(localRootIds)})
      AND tc.type = 'thread'
      AND tc.deleted_at IS NULL
      AND tc.server_id = ${roots.serverId}

    UNION ALL

    -- Task conversations (task v2), through idx_channels_task_parent_channel.
    SELECT
      tc.id AS id,
      tc.parent_channel_id AS parent_channel_id
    FROM channels tc
    WHERE tc.parent_channel_id = ANY(${uuidArray(localRootIds)})
      AND tc.type = 'task'
      AND tc.deleted_at IS NULL
      AND tc.server_id = ${roots.serverId}

    UNION ALL

    SELECT
      tc.id AS id,
      tc.parent_channel_id AS parent_channel_id
    FROM channels tc
    WHERE tc.parent_channel_id = ANY(${uuidArray(storageIds)})
      AND tc.type = 'thread'
      AND tc.deleted_at IS NULL

    UNION ALL

    SELECT
      tc.id AS id,
      tc.parent_channel_id AS parent_channel_id
    FROM channels tc
    WHERE tc.parent_channel_id = ANY(${uuidArray(storageIds)})
      AND tc.type = 'task'
      AND tc.deleted_at IS NULL
  `;
}

/**
 * The same visible set as buildVisibleConversationChannelsSql, as one
 * predicate from the channel side (visibilityService.visibleConversationSql):
 * joined to messages, it resolves each message's channel by primary key. For
 * the recent walks only, which check visibility per message and need a lookup
 * the planner can memoize, not a UNION it re-runs per row.
 */
export function buildVisibleConversationRowCheckSql(roots: VisibleRoots): SQL {
  return sql`
    SELECT
      visible_channels.id AS id,
      COALESCE(visible_channels.parent_channel_id, visible_channels.id) AS parent_channel_id
    FROM channels visible_channels
    WHERE visible_channels.deleted_at IS NULL
      AND ${visibleConversationSql(roots, sql`visible_channels.id`, sql`visible_channels.parent_channel_id`)}
      AND (
        visible_channels.server_id = ${roots.serverId}
        OR COALESCE(visible_channels.parent_channel_id, visible_channels.id) = ANY(${uuidArray(jointStorageRootIds(roots))})
      )
  `;
}

function jointStorageRootIds(roots: VisibleRoots): string[] {
  return roots.roots.flatMap((root) => {
    const storage = root.type === "joint" ? roots.jointStorageByLocalId.get(root.id) : undefined;
    return storage ? [storage] : [];
  });
}

/**
 * Search rows of joint conversations carry canonical storage ids; the viewer
 * only knows the local projections. Map every storage id back (the root to
 * its local projection, with that projection's name and archive state; a
 * canonical thread to this server's thread projection). A canonical thread
 * this server has no projection of is dropped rather than exposing a storage
 * id; a parent message's thread without one becomes threadId null.
 */
function projectJointSearchResults(roots: VisibleRoots, results: MessageSearchResult[]): MessageSearchResult[] {
  if (roots.jointStorageByLocalId.size === 0) return results;
  const localByStorage = new Map([...roots.jointStorageByLocalId].map(([localId, storageId]) => [storageId, localId]));
  const rootById = new Map(roots.roots.map((root) => [root.id, root]));
  return results.flatMap((row) => {
    const parentLocalId = localByStorage.get(row.parentChannelId);
    const parentRoot = parentLocalId ? rootById.get(parentLocalId) : undefined;
    if (!parentRoot) return [row];
    const channelLocalId = localByStorage.get(row.channelId);
    if (!channelLocalId) return [];
    const parentArchivedAt = parentRoot.archivedAt?.toISOString() ?? null;
    const isRoot = channelLocalId === parentRoot.id;
    return [{
      ...row,
      channelId: channelLocalId,
      threadId: row.threadId ? localByStorage.get(row.threadId) ?? null : null,
      parentChannelId: parentRoot.id,
      parentChannelName: parentRoot.name,
      parentChannelType: parentRoot.type,
      parentChannelArchivedAt: parentArchivedAt,
      ...(isRoot ? { channelName: parentRoot.name, channelType: parentRoot.type, channelArchivedAt: parentArchivedAt } : {}),
    }];
  });
}

export type MessageSearchOlderHidden = {
  count: number;
  capped: boolean;
};

export interface MessageSearchPage {
  results: MessageSearchResult[];
  hasMore: boolean;
  /**
   * A Free agent search's first page whose dates reach behind the plan's
   * history window: how many matches the window hides (up to
   * MESSAGE_SEARCH_OLDER_HIDDEN_CAP; `capped` past it). Absent when nothing
   * was counted (a person's search, unlimited plan, a later page, dates inside
   * the window, or the count failed or ran out of time); `count: 0` when none
   * are hidden.
   */
  olderHidden?: MessageSearchOlderHidden;
  /**
   * The server timeline walk used up its row budget before the page filled:
   * these are not all the matches. Continue with nextCursor.
   */
  incomplete?: true;
  /**
   * Server timeline walk only, when hasMore or incomplete: pass back as the
   * cursor (offset 0) to continue strictly below what this page covered.
   */
  nextCursor?: MessageSearchWalkCursor;
  /** incomplete only: the oldest message time the walk read (ISO). */
  searchedThrough?: string;
  /** incomplete only: how many messages the walk read (newest first, from the cursor). */
  searchedMessages?: number;
  /**
   * No message matched every word, and matching any of the words was not tried:
   * more messages match some word than it may rank
   * (MESSAGE_SEARCH_RELAXED_TEXT_MATCH_CAP, counted before visibility). The
   * empty page is not "nothing matches": use more specific words, or filter by
   * channel or sender.
   */
  relaxedSkipped?: "too_broad";
  /**
   * Relevance sort only: more messages match than it ranks
   * (MESSAGE_SEARCH_SERVER_GIN_ESTIMATED_TEXT_MATCH_LIMIT), so the page is the
   * recent sort's (newest first, incomplete/nextCursor as recent). Not ranked
   * by relevance: use more specific words, or filter by channel or sender.
   */
  relevanceFallback?: "too_broad";
}

type MessageSearchServiceParams = {
  serverId: string;
  query: string;
  channelId?: string;
  senderId?: string;
  senderType?: MessageSearchSenderType;
  mentionTarget?: MessageSearchMentionTarget;
  after?: Date;
  before?: Date;
  /** The plan's history cutoff (planService.getHistoryCutoff); undefined on unlimited plans. */
  historyCutoff: Date | undefined;
  sort?: MessageSearchSort;
  limit?: number;
  offset?: number;
  cursor?: MessageSearchWalkCursor;
  signal?: AbortSignal;
};

export async function searchMessagesForUser(params: MessageSearchServiceParams & {
  userId: string;
  /**
   * Guest prefilter (the guest's listChannels roots): intersected with the
   * visibility entry, never widening it. Kept until the guest redesign, so a
   * guest's results stay exactly what they were (no DMs, for one).
   */
  allowedRootChannelIds?: readonly string[];
}): Promise<MessageSearchPage> {
  const visible = await resolveSearchServiceDeps().visibleRootChannelIds({ type: "user", id: params.userId, serverId: params.serverId as ServerId });
  return searchVisibleConversations(
    params.allowedRootChannelIds ? intersectVisibleRoots(visible, params.allowedRootChannelIds) : visible,
    params,
  );
}

export async function searchMessagesForAgent(params: MessageSearchServiceParams & {
  agentId: string;
}): Promise<MessageSearchPage> {
  return searchVisibleConversations(
    await resolveSearchServiceDeps().visibleRootChannelIds({ type: "agent", id: params.agentId, serverId: params.serverId as ServerId }),
    params,
    { countOlderHidden: true },
  );
}

async function searchVisibleConversations(
  roots: VisibleRoots,
  params: MessageSearchServiceParams,
  options: { countOlderHidden?: boolean } = {},
): Promise<MessageSearchPage> {
  // A joint conversation's messages are filtered in its canonical storage.
  const channelId = params.channelId ? roots.jointStorageByLocalId.get(params.channelId) ?? params.channelId : undefined;
  const page = await searchMessages(
    buildVisibleConversationChannelsSql(roots),
    {
      serverId: params.serverId,
      channelId,
      senderId: params.senderId,
      senderType: params.senderType,
      mentionTarget: params.mentionTarget,
      after: params.after,
      before: params.before,
      historyCutoff: params.historyCutoff,
      sort: params.sort ?? "relevance",
      limit: Math.min(
        params.limit ?? AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT,
        AGENT_API_MESSAGE_SEARCH_MAX_LIMIT,
      ),
      offset: Math.max(params.offset ?? 0, 0),
      cursor: params.cursor,
      signal: params.signal,
      jointStorageChannelIds: jointStorageRootIds(roots),
      countOlderHidden: options.countOlderHidden,
    },
    params.query,
    buildVisibleConversationRowCheckSql(roots),
  );
  return { ...page, results: projectJointSearchResults(roots, page.results) };
}

export { isSearchQueryAbortedError };
