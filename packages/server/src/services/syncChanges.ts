// GET /api/sync/changes, the read side of change_log (0450_change_log.sql):
// the change rows after a client's cursor that one viewer (human U in server
// S) may see, in one statement with the sync horizon, mapped and coalesced to
// the changes the response lists. Rebuilding the rows of the changed entities
// is the route's (routes/sync.ts): it reuses the list endpoints' builders.
//
// Cursor `c1.<seq>.<horizon>[.k]`: every change row with seq <= <seq> whose
// transaction is below <horizon> has been delivered. A read with that cursor
// returns, under its own horizon H (see ./syncHorizon):
//   - the page: seq > <seq>, xid < H, ORDER BY seq LIMIT limit (+1 to tell
//     whether there is more);
//   - the late rows: seq <= <seq>, <horizon> <= xid < H, rows that committed
//     after the previous read passed their seq (at most syncLateCap(), read
//     in xid order through change_log_xid_idx, so a forged old horizon costs
//     the cap, then a reset).
// The next cursor is c1.<max(seq, largest page seq)>.<H>, which keeps the
// invariant, so a client never needs to tell late rows from page rows. `.k`
// marks the later pages of one pull (hasMore): the too_many count already
// ran on its first page and is skipped.
//
// Scope filter: channel rows of the viewer's visible conversations (by the
// channel id or a thread's parent id, joint canonical storage ids included,
// plus the channels they saw that were deleted within retention),
// server rows of S, and the viewer's own user rows for S or for every server.
// A user row is always the viewer's own, so a scope_removed for a channel they
// can no longer see still reaches them. A channel that leaves a broad
// audience (0456) also logs channel_public_lost / channel_guest_lost in the
// server scope, delivered to that audience only (non-guests / guests).
// Channel rows that are not about one of the viewer's own channels in S (a
// joint's canonical storage the viewer does not map, another server's
// projection) are left out, but for one kind: an agent's member row on
// another active projection of a joint the viewer sees (its own projection
// active too). A joint roster lists every projection's agents, and the
// channel_agents trigger logs each under its own projection, so those rows
// are read too (their own arm) and named under the viewer's projection; the
// route rebuilds them through the roster builder like any member row.
//
// Reset (no changes, cursor = the current position, client resnapshots):
// too_old when rows after the cursor were dropped by retention; forced when
// change_log_force_reset(S) wrote a reset row after it, or the viewer's own
// stream in S was reset (their role changed to or from guest, 0456); too_many
// when more late rows than the cap qualify, or more than SYNC_SCOPED_ROWS_CAP
// scoped rows follow the cursor (counted only on a pull's first page, when it
// is full).

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  SYNC_CHANNEL_SCOPE_SNAPSHOTS,
  SYNC_SNAPSHOT_NAMES,
  type ServerId,
  type SyncChangesCursor,
  type SyncConversationChange,
  type SyncConversationDoneState,
  type SyncConversationFollowState,
  type SyncConversationReadState,
  type SyncResetReason,
  type SyncRowEntity,
  type SyncScopeChange,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelHumans, channels, jointChannels, jointChannelServers } from "../db/schema";
import { parseSyncHorizon, snapshotXidSpan, syncHorizonFromDatabase, syncLateCap, type SyncHorizon } from "./syncHorizon";
import { uuidArray, visibleConversationRootIds, visibleRootChannelIds } from "./visibilityService";
import { untracedDbQuery, type DbQueryTracer } from "../tracing/dbQueryTrace";

export const SYNC_CHANGES_DEFAULT_LIMIT = 500;
export const SYNC_CHANGES_MAX_LIMIT = 1000;
/** More scoped rows than this after the cursor: reset too_many instead of paging them. */
export const SYNC_SCOPED_ROWS_CAP = 50_000;

let scopedRowsCapOverrideForTests: number | null = null;

function scopedRowsCap(): number {
  return scopedRowsCapOverrideForTests ?? SYNC_SCOPED_ROWS_CAP;
}

/** Tests only: a small too_many threshold. null restores SYNC_SCOPED_ROWS_CAP. */
export function __setSyncScopedRowsCapForTests(cap: number | null): void {
  scopedRowsCapOverrideForTests = cap;
}
/** The scope_id of the guest_access reset row (0458_change_log_visibility_followups). */
const GUEST_ACCESS_RESET_SCOPE = "00000000-0000-0000-0000-000000000000";
/** change_log keeps 8 daily partitions (change_log_maintain keep_days). */
const CHANGE_LOG_RETENTION_DAYS = 8;

const INT8_MAX = (1n << 63n) - 1n;
const CURSOR_RE = /^c1\.(0|[1-9][0-9]{0,18})\.([0-9]+)(\.k)?$/;

/** `counted`: a later page of a pull (`.k`), whose first page ran the too_many count. */
export type ParsedSyncCursor = { seq: bigint; horizon: SyncHorizon; counted: boolean };

/** A client-echoed cursor, or null when it is not one this server issued (version, digits, range). */
export function parseSyncChangesCursor(value: unknown): ParsedSyncCursor | null {
  if (typeof value !== "string") return null;
  const match = CURSOR_RE.exec(value);
  if (!match) return null;
  const seq = BigInt(match[1]!);
  const horizon = parseSyncHorizon(match[2]);
  if (seq > INT8_MAX || !horizon) return null;
  return { seq, horizon, counted: match[3] !== undefined };
}

/** The producing adapter for cursors. */
export function formatSyncChangesCursor(seq: bigint, horizon: SyncHorizon, counted = false): SyncChangesCursor {
  return `c1.${seq}.${horizon}${counted ? ".k" : ""}` as SyncChangesCursor;
}

/** A changed entity whose current row the route rebuilds for the viewer (upsert), or its removal. */
export type PendingRowChange = {
  seq: number;
  entity: SyncRowEntity;
  /** Channel ids are the viewer's local projection ids; member ids are `<localChannelId>:<kind>:<id>`. */
  id: string;
  op: "upsert" | "delete";
  /**
   * An upsert whose row is not in this viewer's list: `delete` when the viewer
   * saw the entity before (their own channels and orders, a channel that left
   * their audience); `drop` for server-wide rows (agents, members, machines),
   * where a delete would name an entity the viewer was never shown.
   */
  ifMissing: "delete" | "drop";
};

export type PendingSyncChange = PendingRowChange | SyncConversationChange | SyncScopeChange;

export type SyncChangesRead = {
  cursor: SyncChangesCursor;
  hasMore: boolean;
  reset: SyncResetReason | null;
  /** In output order (seq of each entity's last row); row entities still to be built. */
  changes: PendingSyncChange[];
  stats: { rowsScanned: number; lateRows: number; horizonLag: number | null; skippedRows: number };
};

type StatementRow = {
  horizon: unknown;
  server_id: string | null;
  scope_kind: string | null;
  parent_id: string | null;
  xmax: unknown;
  min_seq: unknown;
  min_xid: unknown;
  high_seq: unknown;
  forced: unknown;
  scoped_count: unknown;
  seq: unknown;
  entity: string | null;
  entity_id: string | null;
  op: string | null;
  ref_seq: unknown;
  late: unknown;
};

type ChangeRow = {
  seq: bigint;
  entity: string;
  entityId: string;
  op: string;
  refSeq: number | null;
  serverId: string | null;
  scopeKind: string;
  parentId: string | null;
};

function bigintOrNull(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(value as string | number | bigint);
}

function isTrue(value: unknown): boolean {
  return value === true || value === "t";
}

/**
 * Rows of change_log in the viewer's scopes matching `where`, the first `limit`
 * by seq. One arm per scope, each served by its own index (channel ids and
 * the server/user scope by (scope_kind, scope_id, seq), thread parents by
 * (parent_id, seq)), so the cost follows the viewer's scoped rows rather than
 * every row after the cursor, which an OR over the scopes with ORDER BY seq
 * LIMIT would scan. UNION, not UNION ALL: a thread row can match both its own
 * id and its parent's.
 */
function scopedRows(
  viewer: { userId: string; serverId: ServerId },
  visibleIds: SQL,
  peerProjectionIds: SQL | null,
  where: SQL,
  columns: SQL,
  limit: number,
  order: "seq" | "xid" = "seq",
): SQL {
  const orderBy = order === "xid" ? sql`c.xid` : sql`c.seq`;
  const arm = (scope: SQL) => sql`(SELECT ${columns} FROM public.change_log c WHERE ${scope} AND ${where} ORDER BY ${orderBy} LIMIT ${limit})`;
  // Agent member rows of the other projections of the viewer's joints (by the
  // same scope index), only when the viewer sees a joint.
  const peerAgents = peerProjectionIds
    ? sql`UNION ${arm(sql`c.scope_kind = 'channel' AND c.scope_id = ANY(${peerProjectionIds}) AND c.entity = 'channel_member' AND split_part(c.entity_id, ':', 2) = 'agent'`)}`
    : sql``;
  return sql`
    SELECT * FROM (
      ${arm(sql`c.scope_kind = 'channel' AND c.scope_id = ANY(${visibleIds})`)}
      UNION ${arm(sql`c.scope_kind = 'channel' AND c.parent_id = ANY(${visibleIds})`)}
      UNION ${arm(sql`c.scope_kind = 'server' AND c.scope_id = ${viewer.serverId}::uuid`)}
      UNION ${arm(sql`c.scope_kind = 'user' AND c.scope_id = ${viewer.userId}::uuid AND (c.server_id = ${viewer.serverId}::uuid OR c.server_id IS NULL)`)}
      ${peerAgents}
    ) scoped
    ORDER BY seq
    LIMIT ${limit}`;
}

/**
 * One statement: the horizon, the reset facts and (with a cursor) the page and
 * the late rows, so all of them describe the snapshot the rows were read from.
 * PRIMARY ONLY (getDb()): a standby's snapshot is not the writer's, so its
 * horizon would let in-flight primary rows be skipped (see ./syncHorizon).
 */
function syncChangesStatement(input: {
  since: ParsedSyncCursor | null;
  viewer: { userId: string; serverId: ServerId; isGuest: boolean };
  visibleIds: SQL;
  /** The other active projections of the viewer's joints (null: none). */
  peerProjectionIds: SQL | null;
  limit: number;
  lateCap: number;
  /** Whether to count the scoped rows after the cursor (too_many): a pull's first page only. */
  countScoped: boolean;
  scopedCap: number;
}): SQL {
  const highSeq = sql`(SELECT CASE WHEN s.is_called THEN s.last_value ELSE 0 END FROM public.change_log_seq_seq s)`;
  if (!input.since) {
    return sql`
      WITH sync_horizon AS MATERIALIZED (
        SELECT pg_snapshot_xmin(s.snap) AS h, pg_snapshot_xmax(s.snap) AS xmax
        FROM (SELECT pg_current_snapshot() AS snap) s
      )
      SELECT h.h::text AS horizon, h.xmax::text AS xmax, ${highSeq}::text AS high_seq
      FROM sync_horizon h
    `;
  }
  const { since, viewer, visibleIds, peerProjectionIds, limit, lateCap } = input;
  const sinceSeq = since.seq.toString();
  const columns = sql`c.seq, c.entity, c.entity_id, c.op, c.ref_seq, c.server_id, c.scope_kind, c.parent_id`;
  return sql`
    WITH sync_horizon AS MATERIALIZED (
      SELECT pg_snapshot_xmin(s.snap) AS h, pg_snapshot_xmax(s.snap) AS xmax
      FROM (SELECT pg_current_snapshot() AS snap) s
    ),
    sync_page AS (
      SELECT p.*, FALSE AS late FROM (
        ${scopedRows(viewer, visibleIds, peerProjectionIds, sql`c.seq > ${sinceSeq}::bigint AND c.xid < (SELECT h FROM sync_horizon)`, columns, limit + 1)}
      ) p
    ),
    -- Late rows are few (transactions in flight at the previous read), and
    -- the xid range bounds them: walked in xid order (change_log_xid_idx),
    -- so even a forged horizon reads at most the cap + 1, then resets.
    -- Per scope arm, so each viewer gets the cheaper of the xid range
    -- (change_log_xid_idx, dense scopes) and its own scope index (sparse
    -- scopes): an old or forged horizon stops at the cap either way. A horizon
    -- below every retained row is too_old (sync_head.min_xid) before this runs.
    sync_late AS (
      SELECT l.*, TRUE AS late FROM (
        ${scopedRows(viewer, visibleIds, peerProjectionIds, sql`c.xid >= ${since.horizon}::xid8 AND c.xid < (SELECT h FROM sync_horizon) AND c.seq <= ${sinceSeq}::bigint AND ${since.horizon}::xid8 >= (SELECT min(x.xid) FROM public.change_log x)`, columns, lateCap + 1, "xid")}
      ) l
    ),
    sync_head AS MATERIALIZED (
      SELECT
        (SELECT min(m.seq) FROM public.change_log m) AS min_seq,
        (SELECT min(x.xid) FROM public.change_log x)::text AS min_xid,
        ${highSeq} AS high_seq,
        EXISTS (
          SELECT 1 FROM public.change_log f
          WHERE f.scope_kind = 'server' AND f.scope_id = ${viewer.serverId}::uuid AND f.op = 'reset'
            AND f.seq > ${sinceSeq}::bigint AND f.xid < (SELECT h FROM sync_horizon)
        ) OR EXISTS (
          SELECT 1 FROM public.change_log f
          WHERE f.scope_kind = 'user' AND f.scope_id = ${viewer.userId}::uuid AND f.server_id = ${viewer.serverId}::uuid
            AND f.op = 'reset' AND f.seq > ${sinceSeq}::bigint AND f.xid < (SELECT h FROM sync_horizon)
        ) OR (${viewer.isGuest} AND EXISTS (
          -- The guest feature flag changed (0458): who it affects is decided by
          -- rule evaluation, so every guest viewer resnapshots.
          SELECT 1 FROM public.change_log f
          WHERE f.scope_kind = 'server' AND f.scope_id = ${GUEST_ACCESS_RESET_SCOPE}::uuid AND f.op = 'reset'
            -- Also a row that committed after the previous read passed its seq:
            -- no late arm carries this scope, so the window is checked here.
            AND (f.seq > ${sinceSeq}::bigint OR f.xid >= ${since.horizon}::xid8) AND f.xid < (SELECT h FROM sync_horizon)
        )) AS forced,
        -- Counted only on a pull's first page, and only when it is full: the
        -- common read stays one page, a long pull counts once.
        CASE WHEN ${input.countScoped} AND (SELECT count(*) FROM sync_page) > ${limit} THEN (
          SELECT count(*) FROM (
            ${scopedRows(viewer, visibleIds, peerProjectionIds, sql`c.seq > ${sinceSeq}::bigint AND c.xid < (SELECT h FROM sync_horizon)`, sql`c.seq`, input.scopedCap + 1)}
          ) counted
        ) END AS scoped_count
    )
    SELECT h.h::text AS horizon, h.xmax::text AS xmax,
      head.min_seq::text AS min_seq, head.min_xid AS min_xid, head.high_seq::text AS high_seq, head.forced, head.scoped_count::text AS scoped_count,
      r.seq::text AS seq, r.entity, r.entity_id, r.op, r.ref_seq::text AS ref_seq, r.late,
      r.server_id::text AS server_id, r.scope_kind, r.parent_id::text AS parent_id
    FROM sync_horizon h
    CROSS JOIN sync_head head
    LEFT JOIN (SELECT * FROM sync_page UNION ALL SELECT * FROM sync_late) r ON TRUE
  `;
}

/**
 * Top-level channels of S deleted within the log's retention that the viewer
 * saw: public channels (non-guests) and channels they belong to (a soft delete keeps the membership rows). A
 * deleted channel is no longer visible, so without these its own delete row
 * would never pass the scope filter and clients would keep it.
 */
async function recentlyDeletedChannelIds(viewer: SyncViewer): Promise<string[]> {
  const result = await getDb().execute(sql`
    SELECT c.id::text AS id
    FROM ${channels} c
    WHERE c.server_id = ${viewer.serverId}
      AND c.deleted_at IS NOT NULL
      AND c.deleted_at > now() - ${`${CHANGE_LOG_RETENTION_DAYS} days`}::interval
      AND c.parent_channel_id IS NULL
      AND (
        (c.type = 'channel' AND ${!viewer.isGuest})
        OR EXISTS (SELECT 1 FROM ${channelHumans} ch WHERE ch.channel_id = c.id AND ch.user_id = ${viewer.userId})
      )
  `);
  return (result.rows as Array<{ id: string }>).map((row) => row.id);
}

/** The viewer: a human of S, and whether they are a guest there. */
export type SyncViewer = { userId: string; serverId: ServerId; isGuest: boolean };

function scopeSnapshots(kind: "channel" | "server") {
  return kind === "channel" ? [...SYNC_CHANNEL_SCOPE_SNAPSHOTS] : [...SYNC_SNAPSHOT_NAMES];
}

/** The kind of conversation state each change_log entity is about (its sub-object on the change). */
const CONVERSATION_KINDS: ReadonlyMap<string, ConversationKind> = new Map([
  ["read_state", "read"],
  ["inbox_state", "done"],
  ["followed_thread", "follow"],
]);
type ConversationKind = "read" | "done" | "follow";
const ROW_ENTITIES = new Set<string>(["channel", "channel_member", "server_member", "agent", "machine", "sidebar_order", "server_order", "message"]);
/**
 * An upsert the viewer's list does not hold is dropped, not deleted: the
 * server-wide rows, and a message (RFC 082 §4.4) the viewer cannot read (its
 * id is never named to them).
 */
const DROP_IF_MISSING_ENTITIES = new Set<string>(["server_member", "agent", "machine", "message"]);

/**
 * A mapped change and, for channel changes, the channel it is about (checked
 * to be the viewer's). A conversation change also names its kind and the
 * channel id its state row is keyed by: the change_log row's entity_id (the
 * triggers log the state row's own channel_id), before the joint mapping.
 */
type MappedRow = {
  change: PendingSyncChange;
  channel?: { id: string; local: boolean; serverId: string | null };
  conversation?: { kind: ConversationKind; stateId: string };
};

/**
 * One change_log row as a change, or null for rows the response does not
 * carry (unknown entities and ops, thread and task conversation rows, an
 * audience-lost row for the other audience).
 */
function mapChangeRow(
  row: ChangeRow,
  viewer: SyncViewer,
  localByStorage: ReadonlyMap<string, string>,
  localByPeerProjection: ReadonlyMap<string, string> = new Map(),
): MappedRow | null {
  const seq = Number(row.seq);
  const channelRef = (channelId: string) => {
    const mapped = localByStorage.get(channelId);
    return { id: mapped ?? channelId, local: mapped !== undefined || row.serverId === viewer.serverId, serverId: row.serverId };
  };
  if (row.op === "scope_added" || row.op === "scope_removed") {
    if (row.entity !== "channel" && row.entity !== "server") return null;
    const channel = row.entity === "channel" ? channelRef(row.entityId) : undefined;
    return {
      change: {
        seq,
        entity: "scope",
        id: channel?.id ?? row.entityId,
        op: row.op === "scope_added" ? "added" : "removed",
        scopeKind: row.entity,
        snapshots: scopeSnapshots(row.entity),
      },
      channel,
    };
  }
  const kind = CONVERSATION_KINDS.get(row.entity);
  if (kind) {
    const channel = channelRef(row.entityId);
    return {
      change: { seq, entity: "conversation", id: channel.id, op: "stale", refSeq: row.refSeq },
      conversation: { kind, stateId: row.entityId },
    };
  }
  if (row.entity === "channel_public_lost" || row.entity === "channel_guest_lost") {
    // Each goes to the audience that lost the channel: it saw the id, so a
    // channel it no longer sees is a delete.
    if ((row.entity === "channel_guest_lost") !== viewer.isGuest) return null;
    return {
      change: { seq, entity: "channel", id: row.entityId, op: "upsert", ifMissing: "delete" },
      channel: { id: row.entityId, local: true, serverId: viewer.serverId },
    };
  }
  if (!ROW_ENTITIES.has(row.entity) || (row.op !== "upsert" && row.op !== "delete")) return null;
  const entity = row.entity as SyncRowEntity;
  const ifMissing = DROP_IF_MISSING_ENTITIES.has(entity) ? "drop" : "delete";
  if (entity === "channel") {
    // Threads and task conversations are not channel list rows (their state
    // travels as `conversation`).
    if (row.parentId !== null) return null;
    const channel = channelRef(row.entityId);
    return { change: { seq, entity, id: channel.id, op: row.op, ifMissing }, channel };
  }
  if (entity === "channel_member") {
    const [channelId, ...member] = row.entityId.split(":");
    // Another projection's agent row: the viewer's projection of that joint.
    const peerLocal = row.scopeKind === "channel" && member[0] === "agent" ? localByPeerProjection.get(channelId!) : undefined;
    const channel = peerLocal ? { id: peerLocal, local: true, serverId: viewer.serverId } : channelRef(channelId!);
    return { change: { seq, entity, id: [channel.id, ...member].join(":"), op: row.op, ifMissing }, channel };
  }
  return { change: { seq, entity, id: row.entityId, op: row.op, ifMissing } };
}

/**
 * The channel ids, of those whose row named no server (joint membership rows
 * log none), that are channels of S. Anything else (a canonical storage
 * channel or another server's projection) is not the viewer's channel.
 */
/**
 * The viewer's server's projection of each canonical joint channel, whatever
 * the projection's or the joint's status: a revoke logged under the canonical
 * id (the joint membership's trigger, 0450) arrives after the viewer lost the
 * channel, so the visible map no longer has it.
 */
async function localProjectionsOfCanonical(ids: readonly string[], serverId: ServerId): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ canonicalId: jointChannels.canonicalChannelId, localId: jointChannelServers.localChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(inArray(jointChannels.canonicalChannelId, [...new Set(ids)]), eq(jointChannelServers.serverId, serverId)));
  return new Map(rows.map((row) => [row.canonicalId, row.localId]));
}

/**
 * The other active projections of the viewer's visible joints (its own
 * projection and the joint active), each to the viewer's projection: one
 * query over the viewer's joint roots. A joint whose projection on S is
 * disconnected is not among them, so it gets none of its peers' rows.
 */
async function localProjectionsOfPeers(jointLocalIds: readonly string[], serverId: ServerId): Promise<Map<string, string>> {
  if (jointLocalIds.length === 0) return new Map();
  const result = await getDb().execute(sql`
    SELECT peer.local_channel_id::text AS peer_id, mine.local_channel_id::text AS local_id
    FROM ${jointChannelServers} mine
    JOIN ${jointChannels} j ON j.id = mine.joint_channel_id AND j.status = 'active'
    JOIN ${jointChannelServers} peer ON peer.joint_channel_id = mine.joint_channel_id
      AND peer.status = 'active' AND peer.server_id <> ${serverId}::uuid
    WHERE mine.local_channel_id = ANY(${uuidArray(jointLocalIds)})
      AND mine.server_id = ${serverId}::uuid
      AND mine.status = 'active'
  `);
  return new Map((result.rows as Array<{ peer_id: string; local_id: string }>).map((row) => [row.peer_id, row.local_id]));
}

async function channelIdsInServer(ids: readonly string[], serverId: ServerId): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb().select({ id: channels.id }).from(channels)
    .where(and(inArray(channels.id, [...new Set(ids)]), eq(channels.serverId, serverId)));
  return new Set(rows.map((row) => row.id));
}

/**
 * Group by (entity, id), keep each group's last row, in that row's seq order.
 * A conversation keeps the last read position of its group as refSeq: an
 * inbox or follow change after a read move does not hide where the read went.
 * Its kinds are the union of its group's (`kinds`, by the conversation's
 * output id): each one gets its current state attached.
 */
function coalesce(rows: readonly MappedRow[]): { changes: PendingSyncChange[]; kinds: Map<string, ConversationKinds> } {
  const last = new Map<string, PendingSyncChange>();
  const kinds = new Map<string, ConversationKinds>();
  for (const { change, conversation } of [...rows].sort((a, b) => a.change.seq - b.change.seq)) {
    const key = `${change.entity}\u0000${change.id}`;
    const previous = last.get(key);
    const value = change.entity === "conversation" && change.refSeq === null && previous?.entity === "conversation"
      ? { ...change, refSeq: previous.refSeq }
      : change;
    if (conversation) {
      const seen = kinds.get(change.id) ?? {};
      seen[conversation.kind] = conversation.stateId;
      kinds.set(change.id, seen);
    }
    // Delete first, so the Map's order follows each group's last row.
    last.delete(key);
    last.set(key, value);
  }
  return { changes: [...last.values()], kinds };
}

/** The kinds a conversation's group saw, each with the channel id its state row is keyed by. */
type ConversationKinds = Partial<Record<ConversationKind, string>>;

type ConversationStates = {
  read: Map<string, SyncConversationReadState>;
  done: Map<string, SyncConversationDoneState>;
  follow: Map<string, SyncConversationFollowState>;
};

/**
 * The viewer's current state for the page's conversations: one query per
 * kind that occurs, each over the page's state ids (at most the page size)
 * by the state table's primary key. A missing row is absent from its map.
 */
async function readConversationStates(
  viewer: SyncViewer,
  kinds: ReadonlyMap<string, ConversationKinds>,
  traceQuery: DbQueryTracer,
): Promise<ConversationStates> {
  const idsOf = (kind: ConversationKind) => [...new Set([...kinds.values()].flatMap((k) => k[kind] ?? []))];
  const readIds = idsOf("read");
  const doneIds = idsOf("done");
  const followIds = idsOf("follow");
  const states: ConversationStates = { read: new Map(), done: new Map(), follow: new Map() };
  const db = getDb();
  // One after another, not in parallel: each is a few ms by primary key, and a
  // sync pull must not hold three pool connections at once (reconnect waves).
  if (readIds.length > 0) await traceQuery(
      "sync.changes_conversation_read",
      () => db.execute(sql`
        SELECT rc.channel_id::text AS id, rc.last_read_seq AS read_seq, rc.read_state_version AS version,
               rc.marked_unread
        FROM user_channel_read_cursors rc
        WHERE rc.user_id = ${viewer.userId}::uuid AND rc.channel_id = ANY(${uuidArray(readIds)})
      `),
      (r) => ({ input_count: readIds.length, rows_count: r.rows.length }),
    ).then((r) => {
      for (const row of r.rows as Array<{ id: string; read_seq: unknown; version: unknown; marked_unread: unknown }>) {
        states.read.set(row.id, {
          readSeq: Number(row.read_seq),
          readStateVersion: Number(row.version),
          ...(row.marked_unread === true ? { markedUnread: true as const } : {}),
        });
      }
    });
    // doneFrontierSeq: the inbox row's (fetchReadStateAuthorityRows in
    // channelService, the PG serving path): the latest message seq of the
    // scope's own storage channel (a joint projection's canonical channel),
    // else its parent message's seq. SYNC: keep the two in step.
  if (doneIds.length > 0) await traceQuery(
      "sync.changes_conversation_done",
      () => db.execute(sql`
        SELECT s.channel_id::text AS id, (s.done_at IS NOT NULL) AS done,
          COALESCE(lm.seq, parent_message.seq)::text AS done_frontier_seq
        FROM user_channel_inbox_states s
        JOIN channels c ON c.id = s.channel_id
        LEFT JOIN joint_channel_servers joint_projection
          ON joint_projection.local_channel_id = c.id
         AND joint_projection.server_id = c.server_id
         AND joint_projection.status = 'active'
        LEFT JOIN joint_channels joint_storage
          ON joint_storage.id = joint_projection.joint_channel_id
         AND joint_storage.status = 'active'
        LEFT JOIN channels storage_scope
          ON storage_scope.id = COALESCE(joint_storage.canonical_channel_id, c.id)
        LEFT JOIN messages parent_message
          ON parent_message.id = storage_scope.parent_message_id
        LEFT JOIN LATERAL (
          SELECT m.seq FROM messages m
          WHERE m.channel_id = COALESCE(joint_storage.canonical_channel_id, c.id)
          ORDER BY m.seq DESC
          LIMIT 1
        ) lm ON TRUE
        WHERE s.user_id = ${viewer.userId}::uuid AND s.channel_id = ANY(${uuidArray(doneIds)})
      `),
      (r) => ({ input_count: doneIds.length, rows_count: r.rows.length }),
    ).then((r) => {
      for (const row of r.rows as Array<{ id: string; done: unknown; done_frontier_seq: string | null }>) {
        states.done.set(row.id, { done: isTrue(row.done), doneFrontierSeq: row.done_frontier_seq ?? null });
      }
    });
  if (followIds.length > 0) await traceQuery(
      "sync.changes_conversation_follow",
      () => db.execute(sql`
        SELECT f.thread_channel_id::text AS id, (f.unfollowed_at IS NULL) AS followed, (f.done_at IS NOT NULL) AS thread_done
        FROM thread_follows f
        WHERE f.thread_channel_id = ANY(${uuidArray(followIds)}) AND f.follower_type = 'user' AND f.follower_id = ${viewer.userId}::uuid
      `),
      (r) => ({ input_count: followIds.length, rows_count: r.rows.length }),
    ).then((r) => {
      for (const row of r.rows as Array<{ id: string; followed: unknown; thread_done: unknown }>) {
        states.follow.set(row.id, { followed: isTrue(row.followed), threadDone: isTrue(row.thread_done) });
      }
    });
  return states;
}

/** Each conversation change with the current state of every kind its group saw (a missing row: left out). */
async function withConversationStates(
  changes: PendingSyncChange[],
  kinds: ReadonlyMap<string, ConversationKinds>,
  viewer: SyncViewer,
  traceQuery: DbQueryTracer,
): Promise<PendingSyncChange[]> {
  if (kinds.size === 0) return changes;
  const states = await readConversationStates(viewer, kinds, traceQuery);
  return changes.map((change) => {
    if (change.entity !== "conversation") return change;
    const seen = kinds.get(change.id);
    if (!seen) return change;
    const read = seen.read === undefined ? undefined : states.read.get(seen.read);
    const done = seen.done === undefined ? undefined : states.done.get(seen.done);
    const follow = seen.follow === undefined ? undefined : states.follow.get(seen.follow);
    return { ...change, ...(read && { read }), ...(done && { done }), ...(follow && { follow }) };
  });
}

export async function readSyncChanges(input: {
  viewer: SyncViewer;
  since: ParsedSyncCursor | null;
  limit: number;
  traceQuery?: DbQueryTracer;
}): Promise<SyncChangesRead> {
  const { viewer, since, limit } = input;
  const traceQuery = input.traceQuery ?? untracedDbQuery;
  const lateCap = syncLateCap();
  const scopedCap = scopedRowsCap();
  // Visible conversations with the joint storage map (includeThreads: the map
  // is only built with it; the parentless threads it adds are visible too).
  const roots = since ? await visibleRootChannelIds({ type: "user", id: viewer.userId, serverId: viewer.serverId }) : null;
  const localByStorage = new Map<string, string>();
  for (const [localId, storageId] of roots?.jointStorageByLocalId ?? []) localByStorage.set(storageId, localId);

  const visibleIds = roots ? [...visibleConversationRootIds(roots), ...await recentlyDeletedChannelIds(viewer)] : [];
  const localByPeerProjection = await localProjectionsOfPeers(
    (roots?.roots ?? []).filter((root) => root.type === "joint" && roots!.jointStorageByLocalId.has(root.id)).map((root) => root.id),
    viewer.serverId,
  );

  const result = await traceQuery(
    "sync.changes_by_viewer",
    () => getDb().execute(syncChangesStatement({
      since,
      viewer,
      visibleIds: uuidArray(visibleIds),
      peerProjectionIds: localByPeerProjection.size > 0 ? uuidArray([...localByPeerProjection.keys()]) : null,
      limit,
      lateCap,
      countScoped: !since?.counted,
      scopedCap,
    })),
    (rows) => ({ rows_count: rows.rows.length }),
  );
  const rows = result.rows as StatementRow[];
  const head = rows[0];
  const horizon = syncHorizonFromDatabase(head?.horizon);
  const horizonLag = snapshotXidSpan(horizon, head?.xmax);
  const highSeq = bigintOrNull(head?.high_seq) ?? 0n;
  const current = formatSyncChangesCursor(highSeq, horizon);
  const stats = { rowsScanned: 0, lateRows: 0, horizonLag, skippedRows: 0 };
  if (!since) return { cursor: current, hasMore: false, reset: null, changes: [], stats };

  const page: ChangeRow[] = [];
  const late: ChangeRow[] = [];
  for (const row of rows) {
    if (row.seq === null || row.seq === undefined) continue; // the head row of an empty read
    const change: ChangeRow = {
      seq: BigInt(row.seq as string),
      entity: row.entity!,
      entityId: row.entity_id!,
      op: row.op!,
      refSeq: row.ref_seq === null || row.ref_seq === undefined ? null : Number(row.ref_seq),
      serverId: row.server_id,
      scopeKind: row.scope_kind!,
      parentId: row.parent_id,
    };
    (isTrue(row.late) ? late : page).push(change);
  }
  page.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  stats.rowsScanned = page.length + late.length;
  stats.lateRows = late.length;

  // Retention dropped rows after the cursor: the oldest kept row is past it
  // (an empty log: anything allocated past it is gone). A seq hole left by a
  // rolled-back transaction right at the retention edge can make this fire
  // for a cursor that missed nothing: a harmless extra resnapshot.
  const minSeq = bigintOrNull(head?.min_seq);
  const oldestKept = minSeq ?? highSeq + 1n;
  const resetRow = (row: ChangeRow) => row.op === "reset"
    && (row.scopeKind === "server" || (row.scopeKind === "user" && row.serverId === viewer.serverId));
  let reset: SyncResetReason | null = null;
  if (since.seq < oldestKept - 1n) reset = "too_old";
  // A horizon older than every retained row while retained rows sit at or below
  // the cursor's seq: its late window would span the whole retention (an old
  // cursor, or a forged one). A cursor taken before every retained row (e.g. on
  // an empty log) has no rows at or below its seq, so its late window is empty
  // and it is not too_old: every row written after a read has a newer xid.
  const minXid = bigintOrNull(head?.min_xid);
  if (minXid !== null && minSeq !== null && since.seq >= minSeq && BigInt(since.horizon) < minXid) reset = "too_old";
  if (reset === null && (isTrue(head?.forced) || late.some(resetRow))) reset = "forced";
  if (reset === null && (late.length > lateCap || Number(head?.scoped_count ?? 0) > scopedCap)) reset = "too_many";
  if (reset) return { cursor: current, hasMore: false, reset, changes: [], stats };

  const hasMore = page.length > limit;
  if (hasMore) page.length = limit;
  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : since.seq;
  const cursorSeq = lastSeq > since.seq ? lastSeq : since.seq;

  // A scope removal under a canonical id the visible map lacks: map it through
  // the viewer's server's projection, so leaving a joint channel is never lost.
  const unmappedRemovals = [...late, ...page]
    .filter((row) => row.op === "scope_removed" && row.entity === "channel" && row.serverId === null && !localByStorage.has(row.entityId))
    .map((row) => row.entityId);
  const removedProjections = await localProjectionsOfCanonical(unmappedRemovals, viewer.serverId);
  const mapped: MappedRow[] = [];
  for (const row of [...late, ...page]) {
    const projection = row.op === "scope_removed" ? removedProjections.get(row.entityId) : undefined;
    const change = mapChangeRow(row, viewer, projection ? new Map([[row.entityId, projection]]) : localByStorage, localByPeerProjection);
    if (change) mapped.push(change);
    else stats.skippedRows += 1;
  }
  // Channel changes about a channel that is not one of the viewer's own in S
  // (an unmapped canonical storage channel, another server's projection).
  const unresolved = mapped.filter((m) => m.channel && !m.channel.local && m.channel.serverId === null).map((m) => m.channel!.id);
  const inServer = await channelIdsInServer(unresolved, viewer.serverId);
  const kept: MappedRow[] = [];
  for (const row of mapped) {
    const { channel } = row;
    if (channel && !channel.local && !(channel.serverId === null && inServer.has(channel.id))) {
      stats.skippedRows += 1;
      continue;
    }
    kept.push(row);
  }
  const { changes, kinds } = coalesce(kept);
  return {
    // A later page of this pull skips the too_many count its first page ran.
    cursor: formatSyncChangesCursor(cursorSeq, horizon, hasMore),
    hasMore,
    reset: null,
    changes: await withConversationStates(changes, kinds, viewer, traceQuery),
    stats,
  };
}
