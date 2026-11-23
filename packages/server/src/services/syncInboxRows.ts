// GET /api/sync/changes, inbox_row capability (#triage:#244, sync inbox rows
// PR1; contract: SyncInboxRowChange in packages/shared syncChanges.ts). A
// capable client gets each changed Activity row itself, as
// GET /api/channels/inbox?ids= answers it, instead of reading it again.
//
// Two arms, one response, the log arm first:
// - Log arm: the change_log changes that are about one of the viewer's
//   conversations (`conversation` stale; a channel scope removed) are rebuilt
//   as their rows, at most SYNC_INBOX_ROWS_PER_PULL per response (past that
//   only the `conversation` changes go, as before). A row the read does not
//   return is no upsert; deletes are only the two defined ones: `done` (the
//   change saw Done, and the row is gone or the read still shows it at or
//   below the Done position, i.e. the read model has not applied the Done
//   yet; position = the conversation's latest seq) and `left` (a channel
//   scope removed and the re-read finds no row; position null). Each goes
//   right after the change it came from, with its seq. PR2: the `inbox_row`
//   log rows (read only by a capable pull, ./syncChanges: a Done watermark
//   without a Done marker, e.g. a mention Done; a mute or unmute; a
//   retracted message) arrive as `conversation` changes, a watermark being a
//   Done at that position; then, in the room left, a channel list row change
//   (rename, archive) and a task change (on its conversation's row).
//   A row with the viewer's own inbox_row change (a Done watermark, a mute)
//   whose read model has not ingested it (behindOwnChanges: the row read's copy
//   of those inputs, same RisingWave statement, differs from Postgres's) is
//   HELD: nothing of the log from its first such row on goes (the log part of
//   the cursor stops before it; a late one keeps the cursor's), the response
//   asks for a pull in SYNC_INBOX_HELD_RETRY_MS, and past SYNC_INBOX_HOLD_MS
//   (that row's created_at) the pull resets held_too_long. A retracted
//   message (channel scope) is not checked: see behindOwnChanges.
// - Message arm: the rows that new messages changed. The cursor carries a
//   message position `m<mseq>.<mh>`, the sync horizon invariant over messages
//   (./syncHorizon): every message with seq <= mseq whose transaction is below
//   mh has been looked at. One PG statement, under its own horizon H, walks
//   the messages after mseq that finished below H in seq order (every
//   server's, by idx_messages_seq: at today's write rate that is cheap, and
//   each pull's trace records the walk, sync.inbox_rows.walked; a
//   (server_id, seq) index is the follow-up if it grows), at most
//   SYNC_INBOX_SCAN_CAP per pull, and reads the late rows (seq <= mseq, mh <=
//   insert_xid < H, at most syncLateCap() + 1, by idx_messages_insert_xid),
//   after a bounded count of that window (the late backlog: over
//   SYNC_INBOX_LATE_BACKLOG_CAP, the late scan is skipped and the pull
//   resets), keeping those the viewer's Activity can show
//   (eligibleMessageSql: a message of one of their channels or DMs, of a
//   thread / task they follow below a parent they can read, or mentioning
//   them; joint channels excluded; inside the plan's history window). The
//   cost follows the new messages, not how many conversations the viewer
//   has. The conversations found are taken by smallest new seq (late ones
//   first), at most SYNC_INBOX_ROWS_PER_PULL, and their rows read through the
//   rows-only read, which also returns each target's rw_target_latest_v4 seq
//   from the same RisingWave statement. A row whose target has not reached
//   its newest candidate message (still in PG) is HELD: not sent by either
//   arm, the cursor stops before it, and the response asks for a pull again
//   in SYNC_INBOX_HELD_RETRY_MS (`retryAfterMs`). The next position is
//   mseq' = max(mseq, min(the end of the walk, first left-out conversation's
//   min - 1, each held conversation's min - 1)) and mh' = H, unless a held
//   conversation came from late rows (mh stays). Message rows carry the
//   response's change_log cursor seq and go after the log arm's; they are
//   read after it, so the newer read wins, except that a message row at or
//   below a Done delete of the same pull is dropped (the read model has not
//   applied that Done yet).
// One change per row id per response: the last one (by seq) wins.
//
// inboxReset (the client retakes the inbox snapshot; `changes` still apply),
// each with a freshly minted message position (current messages seq, its
// read's horizon) so a stuck read model does not reset every pull:
// - init: the cursor had no message position (from before the capability);
// - too_many: more than SYNC_INBOX_BACKLOG_CAP of this server's messages in one walk, a late
//   backlog over SYNC_INBOX_LATE_BACKLOG_CAP, more than
//   SYNC_INBOX_NEWS_CAP conversations in one walk, more late rows than the
//   cap, more late conversations than one page, or more held rows than one page;
// - held_too_long: a held row's newest candidate message is older than
//   SYNC_INBOX_HOLD_MS.
// A pull without `since` and a full `reset` mint the position too (no
// inboxReset: the client takes every snapshot then anyway).
//
// A failed row read (RisingWave down or overloaded) does not fail the pull:
// the response is the log's changes as without the capability (the
// `conversation` changes say what to refresh), the message position
// unchanged (nothing is skipped), no inbox_row change, and a trace event.
//
// Staging only, a testing aid: with `stagingHeld` (the route's answer of the
// staging-only sync_inbox_staging_held_v0 flag for the server) every row is
// held (retryAfterMs, then held_too_long).
//
// Only where the viewer's Activity read is served by RisingWave (the routes'
// check: never a guest, whose read is the canonical Postgres one, and not
// without RisingWave configured). There the capability is ignored: the
// response is the non-capable one (no message position minted).

import { sql, type SQL } from "drizzle-orm";
import type {
  SyncChange,
  SyncChangesCursor,
  SyncConversationChange,
  SyncInboxReset,
  SyncInboxResetReason,
  SyncInboxRowChange,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { getActivityReadSourceOverride } from "./activityReadSource";
import { canonicalInboxSourceStates, INBOX_SOURCE_SUPPRESSION_KINDS, type InboxItem, type InboxItemsResult, type InboxSourceStates } from "./channelService";
import { inboxPersonalMentionSql } from "./inboxUnreadEligibility";
import { getHistoryCutoff, getServerPlan } from "./planService";
import { formatSyncChangesCursor, type ParsedSyncCursor, type SyncChangesRead, type SyncInboxRowEntry, type SyncMessagePosition, type SyncViewer } from "./syncChanges";
import { syncHorizonFromDatabase, syncLateCap } from "./syncHorizon";
import { uuidArray } from "./visibilityService";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";
import { addTraceEvent } from "../tracing/semanticTrace";

/** Rows per rows-only read, and so per arm per response (GET /channels/inbox?ids= takes as many: INBOX_ROW_IDS_MAX). */
export const SYNC_INBOX_ROWS_PER_PULL = 50;
/** More conversations with news in one walk than this: inboxReset too_many. */
export const SYNC_INBOX_NEWS_CAP = 1000;
/** Messages (of every conversation) one pull walks after the position; past it the pull pages (hasMore). */
export const SYNC_INBOX_SCAN_CAP = 5000;
/** More of the viewer's server's messages in one walk than this: inboxReset too_many instead of paging. */
export const SYNC_INBOX_BACKLOG_CAP = 2_000;
/** More messages (every server's) finished in the late window [mh, H) than this: inboxReset too_many, before the late scan. */
export const SYNC_INBOX_LATE_BACKLOG_CAP = 20_000;
/** A held row whose newest candidate message is older than this: inboxReset held_too_long. */
export const SYNC_INBOX_HOLD_MS = 30_000;
/** While a row is held: the response's retryAfterMs (pull again then; not hasMore, which would loop). */
export const SYNC_INBOX_HELD_RETRY_MS = 2_000;

/** The rows-only Activity read (routes/channels.ts readInboxRowsForSync), injected by the route. */
export type SyncInboxRowsReader = (ids: readonly string[], options?: { sourceStateIds?: readonly string[] }) => Promise<Pick<InboxItemsResult, "backend" | "targetLatestSeqs" | "sourceStates"> & { items: InboxItem[] }>;

/**
 * Test seams. The API tests drive this module through the route, so they set
 * them here rather than inject them; production never does.
 */
const testSeams: {
  newsCap: number | null;
  scanCap: number | null;
  backlogCap: number | null;
  lateBacklogCap: number | null;
  targetLatest: ((latest: ReadonlyMap<string, string>) => ReadonlyMap<string, string>) | null;
  sourceStates: ((states: InboxSourceStates) => InboxSourceStates) | null;
  holdMs: number | null;
} = { newsCap: null, scanCap: null, backlogCap: null, lateBacklogCap: null, targetLatest: null, sourceStates: null, holdMs: null };

/** Tests only: small caps (null restores the constants). */
export function __setSyncInboxCapsForTests(caps: { newsCap?: number | null; scanCap?: number | null; backlogCap?: number | null; lateBacklogCap?: number | null }): void {
  if (caps.lateBacklogCap !== undefined) testSeams.lateBacklogCap = caps.lateBacklogCap;
  if (caps.newsCap !== undefined) testSeams.newsCap = caps.newsCap;
  if (caps.backlogCap !== undefined) testSeams.backlogCap = caps.backlogCap;
  if (caps.scanCap !== undefined) testSeams.scanCap = caps.scanCap;
}

/**
 * Tests only: rewrite the target latest seqs the message arm compares against
 * (e.g. hold a target behind, as a lagging RisingWave would). null restores.
 */
export function __setSyncInboxTargetLatestForTests(override: typeof testSeams.targetLatest): void {
  testSeams.targetLatest = override;
}

/** Tests only: the hold before held_too_long (null restores SYNC_INBOX_HOLD_MS). */
export function __setSyncInboxHoldMsForTests(holdMs: number | null): void {
  testSeams.holdMs = holdMs;
}

/**
 * Tests only: rewrite the Done watermarks and mutes the log arm reads from the
 * row read (e.g. the copy of a read model that has not ingested a Done). null restores.
 */
export function __setSyncInboxSourceStatesForTests(override: typeof testSeams.sourceStates): void {
  testSeams.sourceStates = override;
}

const holdMsNow = () => testSeams.holdMs ?? SYNC_INBOX_HOLD_MS;
const newsCap = () => testSeams.newsCap ?? SYNC_INBOX_NEWS_CAP;
const scanCap = () => testSeams.scanCap ?? SYNC_INBOX_SCAN_CAP;
const backlogCap = () => testSeams.backlogCap ?? SYNC_INBOX_BACKLOG_CAP;
const lateBacklogCap = () => testSeams.lateBacklogCap ?? SYNC_INBOX_LATE_BACKLOG_CAP;

export function inboxRowId(item: InboxItem): string {
  return ((item.kind === "thread" || item.kind === "task") ? item.threadChannelId : item.channelId).toLowerCase();
}

/** The current message position: the messages sequence and the horizon of the same read (PRIMARY ONLY, see ./syncHorizon). */
async function mintMessagePosition(traceQuery: DbQueryTracer): Promise<SyncMessagePosition> {
  const result = await traceQuery("sync.inbox_rows.mint", () => getDb().execute(sql`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
      (SELECT CASE WHEN s.is_called THEN s.last_value ELSE 0 END FROM public.messages_seq_seq s)::text AS high_seq
  `), () => ({}));
  const row = result.rows[0] as { horizon?: unknown; high_seq?: unknown } | undefined;
  return { seq: BigInt(String(row?.high_seq ?? "0")), horizon: syncHorizonFromDatabase(row?.horizon) };
}

type Candidate = { id: string; minSeq: bigint; maxSeq: bigint; maxCreatedAt: Date; late: boolean };

type MessageArmRead = {
  horizon: SyncMessagePosition["horizon"];
  /** The walk's messages of the viewer's server. */
  serverRows: number;
  /** Messages that finished in the late window (insert_xid in [mh, H)), counted up to the late backlog cap + 1. */
  lateBacklog: number;
  /** Messages walked after the position, and the last seq walked (null: none). */
  scanned: number;
  scanEnd: bigint | null;
  news: Candidate[];
  newsCount: number;
  late: Array<{ id: string; seq: bigint; createdAt: Date }>;
};

/**
 * Whether message `m` (a messages row alias) is one the viewer's Activity can
 * show a row for: in one of their channels or DMs; in a thread / task they
 * follow (unfollowed but not Done too: Activity All lists those) below a
 * parent they can read (as /messages/sync checks it); or mentioning them.
 * Joint channels and their threads are excluded, and so is anything archived
 * or deleted. Each check is a primary-key or index probe per message.
 */
function eligibleMessageSql(m: SQL, viewer: SyncViewer): SQL {
  return sql`EXISTS (
    SELECT 1 FROM channels c
    WHERE c.id = ${m}.channel_id
      AND c.server_id = ${viewer.serverId}::uuid
      AND c.type IN ('channel', 'private', 'dm', 'thread', 'task')
      AND c.deleted_at IS NULL AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM joint_channel_servers jp WHERE jp.local_channel_id = c.id AND jp.status = 'active')
      AND (
        (c.type IN ('channel', 'private', 'dm')
          AND EXISTS (SELECT 1 FROM channel_humans ch WHERE ch.channel_id = c.id AND ch.user_id = ${viewer.userId}::uuid))
        OR (c.type IN ('thread', 'task')
          AND EXISTS (
            SELECT 1 FROM thread_follows f
            WHERE f.thread_channel_id = c.id AND f.follower_type = 'user' AND f.follower_id = ${viewer.userId}::uuid
              AND NOT (f.unfollowed_at IS NOT NULL AND f.done_at IS NOT NULL)
          )
          AND EXISTS (
            SELECT 1 FROM channels pc
            LEFT JOIN channel_humans pch ON pch.channel_id = pc.id AND pch.user_id = ${viewer.userId}::uuid
            WHERE pc.id = COALESCE(
                (SELECT pm.channel_id FROM messages pm WHERE pm.id = c.parent_message_id),
                CASE WHEN c.type = 'task' THEN c.parent_channel_id END
              )
              AND pc.server_id = ${viewer.serverId}::uuid AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
              AND pc.type <> 'joint' AND (pc.type = 'channel' OR pch.user_id IS NOT NULL)
          ))
        OR EXISTS (
          SELECT 1 FROM message_mentions mm
          WHERE mm.message_id = ${m}.id AND ${inboxPersonalMentionSql(sql`mm`, viewer.userId)}
        )
      )
  )`;
}

/**
 * The message arm's one statement: the horizon, the messages sequence, the
 * walk after the position (with the conversations it found, the first page
 * by smallest new seq, and their count up to the cap) and the late rows.
 * PRIMARY ONLY (getDb()), like every horizon read.
 */
async function readMessageArm(viewer: SyncViewer, position: SyncMessagePosition, historyCutoff: Date | undefined, traceQuery: DbQueryTracer): Promise<MessageArmRead> {
  const mseq = position.seq.toString();
  const inWindow = (m: SQL) => (historyCutoff ? sql`AND ${m}.created_at > ${historyCutoff}` : sql``);
  const startedAt = performance.now();
  const result = await traceQuery("sync.inbox_rows.messages", () => getDb().execute(sql`
    WITH horizon AS MATERIALIZED (
      SELECT pg_snapshot_xmin(pg_current_snapshot()) AS h
    ),
    -- Every finished message after the position, in seq order (idx_messages_seq), up to the cap.
    scan AS MATERIALIZED (
      SELECT m.id, m.channel_id, m.server_id, m.seq, m.created_at
      FROM messages m
      WHERE m.seq > ${mseq}::bigint
        AND (m.insert_xid IS NULL OR m.insert_xid < (SELECT h FROM horizon))
      ORDER BY m.seq
      LIMIT ${scanCap()}
    ),
    scan_meta AS (
      SELECT count(*)::int AS scanned, max(seq)::text AS scan_end,
        (count(*) FILTER (WHERE server_id = ${viewer.serverId}::uuid))::int AS server_rows
      FROM scan
    ),
    -- The late window's size (every message that finished in [mh, H), late or not), bounded
    -- and index-only on idx_messages_insert_xid: checked before the late scan.
    late_backlog AS MATERIALIZED (
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM messages m
        WHERE m.insert_xid >= ${position.horizon}::xid8 AND m.insert_xid < (SELECT h FROM horizon)
        LIMIT ${lateBacklogCap() + 1}
      ) counted
    ),
    news AS MATERIALIZED (
      SELECT s.channel_id AS id, min(s.seq) AS min_seq, max(s.seq) AS max_seq, max(s.created_at) AS max_created_at
      FROM scan s
      WHERE ${eligibleMessageSql(sql`s`, viewer)} ${inWindow(sql`s`)}
      GROUP BY s.channel_id
    ),
    news_page AS (
      SELECT * FROM news ORDER BY min_seq, id LIMIT ${SYNC_INBOX_ROWS_PER_PULL + 1}
    ),
    news_count AS (
      SELECT count(*)::int AS n FROM (SELECT 1 FROM news LIMIT ${newsCap() + 1}) capped
    ),
    -- Walked in xid order (idx_messages_insert_xid): an old or forged horizon reads the cap + 1.
    -- Not at all past the late backlog cap (a one-time filter): that pull resets anyway.
    late AS (
      SELECT m.channel_id AS id, m.seq, m.created_at
      FROM messages m
      WHERE (SELECT n FROM late_backlog) <= ${lateBacklogCap()}
        AND m.insert_xid >= ${position.horizon}::xid8 AND m.insert_xid < (SELECT h FROM horizon)
        AND m.seq <= ${mseq}::bigint
        AND ${eligibleMessageSql(sql`m`, viewer)} ${inWindow(sql`m`)}
      ORDER BY m.insert_xid
      LIMIT ${syncLateCap() + 1}
    )
    SELECT h.h::text AS horizon, lb.n AS late_backlog, sm.scanned, sm.scan_end, sm.server_rows, nc.n AS news_count, r.*
    FROM horizon h
    CROSS JOIN late_backlog lb
    CROSS JOIN scan_meta sm
    CROSS JOIN news_count nc
    LEFT JOIN (
      SELECT p.id::text AS id, p.min_seq::text AS min_seq, p.max_seq::text AS max_seq, p.max_created_at AS created_at, FALSE AS late FROM news_page p
      UNION ALL
      SELECT l.id::text, l.seq::text, l.seq::text, l.created_at, TRUE FROM late l
    ) r ON TRUE
  `), (r) => ({ rows_count: r.rows.length }));
  type Row = { horizon: unknown; late_backlog: unknown; server_rows: unknown; scanned: unknown; scan_end: string | null; news_count: unknown; id: string | null; min_seq: string | null; max_seq: string | null; created_at: unknown; late: unknown };
  const walkMs = Math.round(performance.now() - startedAt);
  const rows = result.rows as Row[];
  const head = rows[0];
  const read: MessageArmRead = {
    horizon: syncHorizonFromDatabase(head?.horizon),
    serverRows: Number(head?.server_rows ?? 0),
    lateBacklog: Number(head?.late_backlog ?? 0),
    scanned: Number(head?.scanned ?? 0),
    scanEnd: head?.scan_end ? BigInt(head.scan_end) : null,
    news: [],
    newsCount: Number(head?.news_count ?? 0),
    late: [],
  };
  // The decision data for a (server_id, seq) index (open it if walk rows p99 > 5,000 or walk ms p99 > 200).
  addTraceEvent("sync.inbox_rows.walked", {
    "sync.inbox_rows.walk_rows": read.scanned,
    "sync.inbox_rows.walk_ms": walkMs,
    "sync.inbox_rows.walk_server_rows": read.serverRows,
    // The late window's message count (capped at the late backlog cap + 1); the statement's time is walk_ms.
    "sync.inbox_rows.late_backlog": read.lateBacklog,
    "sync.inbox_rows.late_backlog_capped": read.lateBacklog > lateBacklogCap(),
  });
  for (const row of rows) {
    if (row.id === null || row.min_seq === null || row.max_seq === null) continue;
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
    if (row.late === true || row.late === "t") read.late.push({ id: row.id, seq: BigInt(row.min_seq), createdAt });
    else read.news.push({ id: row.id, minSeq: BigInt(row.min_seq), maxSeq: BigInt(row.max_seq), maxCreatedAt: createdAt, late: false });
  }
  return read;
}

/** The latest seq still in PG of each held conversation among its candidates (a candidate deleted since is no longer needed). */
async function stillNeeded(held: readonly Candidate[], since: bigint, traceQuery: DbQueryTracer): Promise<Map<string, bigint>> {
  if (held.length === 0) return new Map();
  const floor = held.reduce((low, c) => (c.minSeq < low ? c.minSeq : low), since + 1n);
  const result = await traceQuery("sync.inbox_rows.held_need", () => getDb().execute(sql`
    SELECT m.channel_id::text AS id, max(m.seq)::text AS seq
    FROM messages m
    WHERE m.channel_id = ANY(${uuidArray(held.map((c) => c.id))}) AND m.seq >= ${floor.toString()}::bigint
    GROUP BY m.channel_id
  `), (r) => ({ rows_count: r.rows.length }));
  const need = new Map<string, bigint>();
  const maxOf = new Map(held.map((c) => [c.id, c.maxSeq]));
  for (const row of result.rows as Array<{ id: string; seq: string }>) {
    const max = maxOf.get(row.id);
    if (max === undefined) continue;
    const seq = BigInt(row.seq);
    need.set(row.id, seq < max ? seq : max);
  }
  return need;
}

/** The test stand-in has no RisingWave: its targets' latest seqs are Postgres's (always caught up). */
async function referenceTargetLatest(ids: readonly string[]): Promise<Map<string, string>> {
  const result = await getDb().execute(sql`
    SELECT m.channel_id::text AS id, max(m.seq)::text AS seq FROM messages m WHERE m.channel_id = ANY(${uuidArray(ids)}) GROUP BY m.channel_id
  `);
  return new Map((result.rows as Array<{ id: string; seq: string }>).map((row) => [row.id, row.seq]));
}

/**
 * Each candidate's latest seq in the read model that served its rows: null for
 * a Postgres answer (the authority: always caught up). A RisingWave answer
 * comes with them (the rows-only read); the test stand-in reads the
 * reference; a production RisingWave answer without them is a broken read
 * (thrown, so the pull degrades and traces it, rather than holding every row).
 */
async function targetLatestOf(read: Awaited<ReturnType<SyncInboxRowsReader>>, ids: readonly string[], forceBehind: boolean): Promise<ReadonlyMap<string, string> | null> {
  if (read.backend !== "risingwave") return null;
  // The staging hold (withSyncInboxRows `stagingHeld`): no target has caught up.
  if (forceBehind) return new Map();
  let latest = read.targetLatestSeqs;
  if (!latest) {
    if (!getActivityReadSourceOverride()) throw new Error("sync_inbox_rows_target_latest_missing");
    latest = await referenceTargetLatest(ids);
  }
  return testSeams.targetLatest ? testSeams.targetLatest(latest) : latest;
}

type MessageArm =
  | { reset: SyncInboxResetReason }
  | { reset: null; rows: Map<string, InboxItem>; next: SyncMessagePosition; hasMore: boolean; held: ReadonlySet<string> };

async function runMessageArm(viewer: SyncViewer, position: SyncMessagePosition, readRows: SyncInboxRowsReader, traceQuery: DbQueryTracer, now: Date, stagingHeld: boolean): Promise<MessageArm> {
  const historyCutoff = getHistoryCutoff(await getServerPlan(viewer.serverId));
  const holdMs = holdMsNow();
  const read = await readMessageArm(viewer, position, historyCutoff, traceQuery);
  if (read.serverRows > backlogCap() || read.lateBacklog > lateBacklogCap()) return { reset: "too_many" };
  if (read.newsCount > newsCap() || read.late.length > syncLateCap()) return { reset: "too_many" };
  const lateById = new Map<string, Candidate>();
  for (const row of read.late) {
    const c = lateById.get(row.id);
    if (!c) lateById.set(row.id, { id: row.id, minSeq: row.seq, maxSeq: row.seq, maxCreatedAt: row.createdAt, late: true });
    else {
      if (row.seq < c.minSeq) c.minSeq = row.seq;
      if (row.seq > c.maxSeq) c.maxSeq = row.seq;
      if (row.createdAt > c.maxCreatedAt) c.maxCreatedAt = row.createdAt;
    }
  }
  // Late rows are not paged (they sit below the position): more conversations than one read is a reset.
  if (lateById.size > SYNC_INBOX_ROWS_PER_PULL) return { reset: "too_many" };
  const candidates = new Map(lateById);
  let firstLeftOut: Candidate | null = null;
  for (const c of read.news) {
    const known = candidates.get(c.id);
    if (!known && candidates.size >= SYNC_INBOX_ROWS_PER_PULL) {
      firstLeftOut ??= c;
      continue;
    }
    candidates.set(c.id, known
      ? { ...known, maxSeq: c.maxSeq > known.maxSeq ? c.maxSeq : known.maxSeq, maxCreatedAt: c.maxCreatedAt > known.maxCreatedAt ? c.maxCreatedAt : known.maxCreatedAt }
      : c);
  }
  // The page holds one more than can be taken: that one is left out too.
  if (!firstLeftOut && read.news.length > SYNC_INBOX_ROWS_PER_PULL) firstLeftOut = read.news[SYNC_INBOX_ROWS_PER_PULL]!;
  // The walk stopped at its cap: messages after scanEnd are not looked at yet.
  const walkFull = read.scanned >= scanCap();
  let hasMore = firstLeftOut !== null || walkFull;

  const ids = [...candidates.keys()];
  const answer = ids.length > 0 ? await readRows(ids) : { items: [] as InboxItem[] };
  const targetLatest = ids.length > 0 ? await targetLatestOf(answer, ids, stagingHeld) : null;
  const behind = targetLatest === null ? [] : [...candidates.values()].filter((c) => {
    const latest = targetLatest.get(c.id);
    return latest === undefined || BigInt(latest) < c.maxSeq;
  });
  const need = await stillNeeded(behind, position.seq, traceQuery);
  const held = behind.filter((c) => {
    const needed = need.get(c.id);
    const latest = targetLatest?.get(c.id);
    return needed !== undefined && (latest === undefined || BigInt(latest) < needed);
  });
  if (held.length > SYNC_INBOX_ROWS_PER_PULL) return { reset: "too_many" };
  if (held.some((c) => now.getTime() - c.maxCreatedAt.getTime() > holdMs)) return { reset: "held_too_long" };

  const heldIds = new Set(held.map((c) => c.id));
  const rows = new Map<string, InboxItem>();
  for (const item of answer.items) {
    const id = inboxRowId(item);
    if (candidates.has(id) && !heldIds.has(id)) rows.set(id, item);
  }
  // Everything walked is looked at: the bound is the walk's end (or the position, for an empty walk).
  let bound = read.scanEnd ?? position.seq;
  if (firstLeftOut && firstLeftOut.minSeq - 1n < bound) bound = firstLeftOut.minSeq - 1n;
  for (const c of held) if (c.minSeq - 1n < bound) bound = c.minSeq - 1n;
  const nextSeq = bound > position.seq ? bound : position.seq;
  const nextHorizon = held.some((c) => c.late) ? position.horizon : read.horizon;
  // Page only when the walk moved on: with a held row at the position every page would walk
  // the same messages again (the horizon moves on every read, so it does not count).
  hasMore &&= nextSeq > position.seq;
  return { reset: null, rows, next: { seq: nextSeq, horizon: nextHorizon }, hasMore, held: heldIds };
}

type LogTarget = { id: string; seq: number; after: number; kind: "done" | "left" | "stale"; position: string | null };

/**
 * The log arm's rows: one per change_log change about a conversation, the
 * first SYNC_INBOX_ROWS_PER_PULL ids. First the viewer's own state
 * (`conversation`, a channel scope removed); then, in the room left, the
 * changes of what a row shows: a channel list row (renamed, archived: a
 * channel `delete` is `left` when the row is gone, also over the viewer's own
 * `stale` change of that row) and a task (its status, on its conversation's
 * row, `taskConversations`).
 *
 * `inboxRowEntries` (readSyncChanges): a conversation's Done watermark from
 * an `inbox_row` change (a Done's only: a mention Done, or a Done under newer
 * activity, that set no Done marker): a Done at that position, as a Done
 * marker's is (a row above it stays an upsert). A thread
 * Done marker without a position takes it too (more exact than the latest seq).
 */
function logTargets(
  changes: readonly SyncChange[],
  inboxRowEntries: ReadonlyMap<string, SyncInboxRowEntry>,
  taskConversations: ReadonlyMap<string, string>,
): LogTarget[] {
  const targets = new Map<string, LogTarget>();
  const add = (target: LogTarget) => {
    if (!targets.has(target.id) && targets.size >= SYNC_INBOX_ROWS_PER_PULL) return;
    targets.set(target.id, target);
  };
  changes.forEach((change, index) => {
    if (change.entity === "conversation") {
      const conversation = change as SyncConversationChange;
      const watermark = inboxRowEntries.get(change.id)?.position ?? null;
      const marked = conversation.done?.done === true || conversation.follow?.threadDone === true;
      add({
        id: change.id.toLowerCase(), seq: change.seq, after: index,
        kind: marked || watermark !== null ? "done" : "stale",
        position: marked ? conversation.done?.doneFrontierSeq ?? watermark : watermark,
      });
    } else if (change.entity === "scope" && change.op === "removed" && change.scopeKind === "channel") {
      add({ id: change.id.toLowerCase(), seq: change.seq, after: index, kind: "left", position: null });
    }
  });
  changes.forEach((change, index) => {
    let id: string | undefined;
    let kind: LogTarget["kind"] = "stale";
    if (change.entity === "channel") {
      id = change.id;
      if (change.op === "delete") kind = "left";
    } else if (change.entity === "task" && change.op === "upsert") {
      id = taskConversations.get(change.id.toLowerCase());
    }
    if (id === undefined) return;
    id = id.toLowerCase();
    const before = targets.get(id);
    // The viewer's own state of the same row (above) says more: keep it. Except a channel
    // delete over a `stale` one (say a read, or a re-add, and an archive in the same pull):
    // `stale` sends nothing for a row that is gone, so it becomes `left`, after the channel delete.
    if (before && !(before.kind === "stale" && kind === "left")) return;
    add({ id, seq: change.seq, after: index, kind, position: null });
  });
  return [...targets.values()];
}

/**
 * The viewer's Activity row id of each changed task: its live task
 * conversation in the viewer's server, else (a pre-v2 task) its host
 * message's thread. A task without either has no row. Primary keys and
 * idx_channels_task_id / idx_channels_active_thread_parent only.
 */
async function taskConversationIds(changes: readonly SyncChange[], viewer: SyncViewer, traceQuery: DbQueryTracer): Promise<Map<string, string>> {
  const ids = [...new Set(changes.filter((change) => change.entity === "task" && change.op === "upsert").map((change) => change.id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const result = await traceQuery("sync.inbox_rows.task_conversations", () => getDb().execute(sql`
    SELECT t.id::text AS id, COALESCE(
      (SELECT c.id FROM channels c WHERE c.task_id = t.id AND c.type = 'task' AND c.deleted_at IS NULL AND c.server_id = ${viewer.serverId}::uuid LIMIT 1),
      (SELECT c.id FROM channels c WHERE t.message_id IS NOT NULL AND c.parent_message_id = t.message_id AND c.type = 'thread' AND c.deleted_at IS NULL LIMIT 1)
    )::text AS conversation_id
    FROM tasks t
    WHERE t.id = ANY(${uuidArray(ids)})
  `), (r) => ({ rows_count: r.rows.length }));
  const map = new Map<string, string>();
  for (const row of result.rows as Array<{ id: string; conversation_id: string | null }>) {
    if (row.conversation_id !== null) map.set(row.id, row.conversation_id);
  }
  return map;
}

/**
 * A Done thread's position (its storage conversation's latest seq): the follow
 * state carries none. A channel / DM's comes with the change (doneFrontierSeq).
 */
async function latestSeqs(ids: readonly string[], traceQuery: DbQueryTracer): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await traceQuery("sync.inbox_rows.done_position", () => getDb().execute(sql`
    SELECT c.id::text AS id, (
      SELECT max(m.seq) FROM messages m WHERE m.channel_id = COALESCE(j.canonical_channel_id, c.id)
    )::text AS seq
    FROM channels c
    LEFT JOIN joint_channel_servers p ON p.local_channel_id = c.id AND p.server_id = c.server_id AND p.status = 'active'
    LEFT JOIN joint_channels j ON j.id = p.joint_channel_id AND j.status = 'active'
    WHERE c.id = ANY(${uuidArray(ids)})
  `), (r) => ({ rows_count: r.rows.length }));
  const seqs = new Map<string, string>();
  for (const row of result.rows as Array<{ id: string; seq: string | null }>) if (row.seq !== null) seqs.set(row.id, row.seq);
  return seqs;
}

/** A row at or below a Done position: the read model has not applied the Done yet. */
function atOrBelow(row: InboxItem, position: string): boolean {
  return row.latestActivitySeq === null || BigInt(row.latestActivitySeq) <= BigInt(position);
}

/** The viewer's Done watermarks and mutes of these rows in Postgres (the authority), by primary key. */
async function postgresSourceStates(viewer: SyncViewer, ids: readonly string[], traceQuery: DbQueryTracer): Promise<InboxSourceStates> {
  const result = await traceQuery("sync.inbox_rows.source_states", () => getDb().execute(sql`
    SELECT 's' AS t, s.target_channel_id::text AS id, s.target_kind AS kind, s.done_through_seq::text AS seq, NULL::boolean AS muted
    FROM inbox_suppression_states s
    WHERE s.receiver_type = 'user' AND s.receiver_id = ${viewer.userId}::uuid
      AND s.target_kind IN (${sql.join(INBOX_SOURCE_SUPPRESSION_KINDS.map((kind) => sql`${kind}`), sql`, `)})
      AND s.target_channel_id = ANY(${uuidArray(ids)})
    UNION ALL
    SELECT 'm', mu.source_channel_id::text, NULL, mu.mute_from_seq::text, mu.activity_muted
    FROM inbox_target_mute_states mu
    WHERE mu.receiver_type = 'user' AND mu.receiver_id = ${viewer.userId}::uuid AND mu.source_channel_id = ANY(${uuidArray(ids)})
  `), (r) => ({ rows_count: r.rows.length }));
  const rows = result.rows as Array<{ t: string; id: string; kind: string | null; seq: string | null; muted: unknown }>;
  return canonicalInboxSourceStates(
    rows.filter((row) => row.t === "s").map((row) => ({ id: row.id, kind: row.kind ?? "", seq: row.seq })),
    rows.filter((row) => row.t === "m").map((row) => ({ id: row.id, muted: row.muted === true || row.muted === "t", fromSeq: row.seq })),
  );
}

/**
 * The rows whose read model has not caught up with the viewer's own
 * `inbox_row` changes (a Done watermark, a mute): the row read's copy of
 * those inputs (the CDC tables the serving chain reads, in the same
 * RisingWave statement as the rows, so the rows are at least that new)
 * differs from Postgres's, read after it. A Postgres answer is the authority
 * (none held); the test stand-in reads Postgres's (none held, unless a test
 * rewrites it); a production RisingWave answer without them is a broken read
 * (thrown: the pull degrades). The staging hold (withSyncInboxRows `stagingHeld`) holds them all.
 *
 * Not for a retracted message (a channel-scope row): the change is the
 * message's content, and its log row names the conversation only; checking it
 * needs the message id in the log row and RisingWave's copy of that message
 * read in the same statement (rw_messages by id).
 */
async function behindOwnChanges(
  answer: Awaited<ReturnType<SyncInboxRowsReader>>,
  ids: readonly string[],
  viewer: SyncViewer,
  traceQuery: DbQueryTracer,
  stagingHeld: boolean,
): Promise<Set<string>> {
  if (ids.length === 0 || answer.backend !== "risingwave") return new Set();
  if (stagingHeld) return new Set(ids);
  const authority = await postgresSourceStates(viewer, ids, traceQuery);
  let served = answer.sourceStates;
  if (!served) {
    if (!getActivityReadSourceOverride()) throw new Error("sync_inbox_rows_source_states_missing");
    served = authority;
  }
  if (testSeams.sourceStates) served = testSeams.sourceStates(served);
  return new Set(ids.filter((id) => served.suppression.get(id) !== authority.suppression.get(id) || served.mute.get(id) !== authority.mute.get(id)));
}

type LogArm = { after: Map<number, SyncInboxRowChange[]>; donePositions: Map<string, string>; held: Set<string> };

async function logArmChanges(
  changes: readonly SyncChange[],
  inboxRowEntries: ReadonlyMap<string, SyncInboxRowEntry>,
  viewer: SyncViewer,
  readRows: SyncInboxRowsReader,
  traceQuery: DbQueryTracer,
  stagingHeld: boolean,
): Promise<LogArm> {
  const targets = logTargets(changes, inboxRowEntries, await taskConversationIds(changes, viewer, traceQuery));
  const arm: LogArm = { after: new Map(), donePositions: new Map(), held: new Set() };
  if (targets.length === 0) return arm;
  const ownIds = targets.filter((target) => inboxRowEntries.get(target.id)?.own === true).map((target) => target.id);
  // Their read model inputs only for the rows with the viewer's own changes (the other reads skip them).
  const answer = await readRows(targets.map((target) => target.id), ownIds.length > 0 ? { sourceStateIds: ownIds } : undefined);
  arm.held = await behindOwnChanges(answer, ownIds, viewer, traceQuery, stagingHeld);
  const rows = new Map(answer.items.map((item) => [inboxRowId(item), item]));
  const positions = await latestSeqs(targets.filter((target) => target.kind === "done" && target.position === null).map((target) => target.id), traceQuery);
  for (const target of targets) {
    // Held (its read model is behind the viewer's change): withSyncInboxRows stops the log before it.
    if (arm.held.has(target.id)) continue;
    const row = rows.get(target.id);
    // No position known: no delete (never an unconditional one for a Done).
    const donePosition = target.kind === "done" ? target.position ?? positions.get(target.id) ?? null : null;
    let change: SyncInboxRowChange | null = null;
    if (donePosition !== null && (!row || atOrBelow(row, donePosition))) {
      change = { seq: target.seq, entity: "inbox_row", id: target.id, op: "delete", position: donePosition, reason: "done" };
      arm.donePositions.set(target.id, donePosition);
    } else if (row) change = { seq: target.seq, entity: "inbox_row", id: target.id, op: "upsert", row, source: "log" };
    else if (target.kind === "left") change = { seq: target.seq, entity: "inbox_row", id: target.id, op: "delete", position: null, reason: "left" };
    if (change) arm.after.set(target.after, [...(arm.after.get(target.after) ?? []), change]);
  }
  return arm;
}

/** Keep the last change per inbox_row id (the highest seq: the order is by seq). */
function oneChangePerRow(changes: readonly SyncChange[]): SyncChange[] {
  const last = new Map<string, number>();
  changes.forEach((change, index) => { if (change.entity === "inbox_row") last.set(change.id, index); });
  return changes.filter((change, index) => change.entity !== "inbox_row" || last.get(change.id) === index);
}

export type SyncInboxRowsResult = {
  cursor: SyncChangesCursor;
  hasMore: boolean;
  changes: SyncChange[];
  inboxReset: SyncInboxReset | null;
  /** Set while a row is held: pull again after this long. */
  retryAfterMs: number | null;
  stats: { messageRows: number; logRows: number; held: number; failed: boolean };
};

/**
 * The inbox_row part of a capable pull: `read` and `changes` are the log's
 * (readSyncChanges, then the route's row builders); returns the response's
 * cursor (with its message position), changes and inboxReset.
 */
export async function withSyncInboxRows(input: {
  viewer: SyncViewer;
  since: ParsedSyncCursor | null;
  read: SyncChangesRead;
  changes: readonly SyncChange[];
  readRows: SyncInboxRowsReader;
  traceQuery?: DbQueryTracer;
  now?: Date;
  /**
   * Staging only, a testing aid for client teams (inboxReset held_too_long and
   * retryAfterMs are otherwise only seen while RisingWave lags): every row the
   * pull finds is read as behind, so it is held (retryAfterMs) and, past the
   * hold, the pull resets held_too_long. The route sets it from
   * SYNC_INBOX_STAGING_HELD_FEATURE_FLAG_KEY, read only on DEPLOYMENT_ENV=staging.
   */
  stagingHeld?: boolean;
}): Promise<SyncInboxRowsResult> {
  const { since, read } = input;
  const traceQuery = input.traceQuery ?? untracedDbQuery;
  const stats = { messageRows: 0, logRows: 0, held: 0, failed: false };
  const cursorWith = (messages: SyncMessagePosition) => formatSyncChangesCursor(read.position.seq, read.position.horizon, read.position.counted, messages);
  const asBefore = (messages: SyncMessagePosition, reason: SyncInboxResetReason | null): SyncInboxRowsResult => ({
    cursor: cursorWith(messages),
    hasMore: read.hasMore,
    changes: [...input.changes],
    inboxReset: reason ? { reason, snapshots: ["inbox"] } : null,
    // The read model is behind: retake the snapshot after a short delay, not from it at once.
    retryAfterMs: reason === "held_too_long" ? SYNC_INBOX_HELD_RETRY_MS : null,
    stats,
  });
  const minted = async (reason: SyncInboxResetReason | null) => asBefore(await mintMessagePosition(traceQuery), reason);
  // A first pull, or a full reset: the client takes every snapshot (inbox included) from here.
  if (!since || read.reset) return minted(null);
  if (!since.messages) return minted("init");
  const position = since.messages;

  try {
    // The log arm first: the message arm reads its rows after, so a row both read is the newer read's.
    const now = input.now ?? new Date();
    const log = await logArmChanges(input.changes, read.inboxRowEntries, input.viewer, input.readRows, traceQuery, input.stagingHeld === true);
    // A log-held row past the hold (aged from its newest inbox_row row: an older
    // one the read model has long applied does not count): retake the snapshot,
    // the log goes on as without the capability.
    const holdMs = holdMsNow();
    const logHeld = [...log.held].map((id) => read.inboxRowEntries.get(id)!).filter(Boolean);
    if (logHeld.some((entry) => now.getTime() - entry.lastAt.getTime() > holdMs)) return minted("held_too_long");
    const arm = await runMessageArm(input.viewer, position, input.readRows, traceQuery, now, input.stagingHeld === true);
    if (arm.reset) return minted(arm.reset);
    stats.held = arm.held.size + log.held.size;
    // Log-held rows: the response's log part stops before the first of their
    // inbox_row rows (every change from there on comes again next pull, rebuilt
    // then), or, for a late one, stays at the cursor's (seq and horizon), so
    // the next pull reads it again; nothing of the log goes now.
    let logPosition = read.position;
    let logCut: number | null = null;
    if (logHeld.length > 0) {
      const first = logHeld.reduce((low, entry) => (entry.firstSeq < low ? entry.firstSeq : low), logHeld[0]!.firstSeq);
      if (logHeld.some((entry) => entry.late) || first <= since.seq) {
        logPosition = { seq: since.seq, horizon: since.horizon, counted: false };
        logCut = Number.NEGATIVE_INFINITY;
      } else {
        logPosition = { seq: first - 1n, horizon: read.position.horizon, counted: false };
        logCut = Number(first);
      }
    }
    const changes: SyncChange[] = [];
    input.changes.forEach((change, index) => {
      if (logCut !== null && change.seq >= logCut) return;
      changes.push(change);
      for (const row of log.after.get(index) ?? []) {
        // A held row is not sent by either arm: its read model is behind its newest message.
        if (row.op === "upsert" && arm.held.has(row.id)) continue;
        changes.push(row);
        stats.logRows += 1;
      }
    });
    // After the log's changes, at the response's cursor seq.
    const seq = Number(logPosition.seq);
    for (const [id, row] of arm.rows) {
      if (log.held.has(id)) continue;
      const done = log.donePositions.get(id);
      if (done !== undefined && atOrBelow(row, done)) continue;
      changes.push({ seq, entity: "inbox_row", id, op: "upsert", row, source: "message" });
      stats.messageRows += 1;
    }
    return {
      cursor: formatSyncChangesCursor(logPosition.seq, logPosition.horizon, logPosition.counted, arm.next),
      // A held log does not page (pulling at once would loop): retryAfterMs.
      hasMore: (logCut === null && read.hasMore) || arm.hasMore,
      changes: oneChangePerRow(changes),
      inboxReset: null,
      retryAfterMs: arm.held.size > 0 || log.held.size > 0 ? SYNC_INBOX_HELD_RETRY_MS : null,
      stats,
    };
  } catch (error) {
    // The rows could not be read (RisingWave down or overloaded): the log's
    // changes as without the capability, nothing skipped (the position stays).
    stats.failed = true;
    addTraceEvent("sync.inbox_rows.read_failed", { error: error instanceof Error ? error.message : String(error) });
    return asBefore(position, null);
  }
}
