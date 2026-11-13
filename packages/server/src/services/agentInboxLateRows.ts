// Late rows of an external agent's inbox: messages whose transaction committed
// after an /events acknowledgement had moved the read position past their seq.
//
// messages.seq is allocated at INSERT, but transactions commit in another
// order. A pull returns the rows above the read position, oldest first and
// contiguous per conversation, and the ack moves the read position to the
// highest seq handed over. A smaller-seq row still in flight while the pull
// read sat below the read position for good.
//
// Every pull takes pg_current_snapshot() (primary) before it reads any row.
// When its batch is acknowledged, a skip record keeps, per conversation the
// ack moved, the range (from, to] it moved over, the rows handed over in it,
// and that snapshot. In (from, to] every row the pull could see was handed over
// (the reads are contiguous from `from`), so a row that snapshot could not see
// (pg_visible_in_snapshot false for its insert_xid) and that was not handed
// over is exactly a skipped row. A row that committed between the snapshot and
// the read was handed over, so the handed list rules it out: the snapshot need
// not be the read's own. Later pulls look those ranges up
// (idx_messages_channel_seq) and hand the skipped rows over once they commit.
// Only /events' own advances are recorded, so rows the agent read through
// history (which also moves the read position) are never handed over again.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentInboxLatePending, agentInboxSkipRecords } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import type { AgentReadPositionAdvance } from "./channelService";

/** Late rows handed over per pull at most (also the agent_inbox_late_pending cap). */
export const AGENT_INBOX_LATE_MATCH_CAP = 100;

/**
 * How long a skip record is kept at least once no transaction of its snapshot
 * is in flight. A record may be deleted only when no row it covers can still
 * commit. The xmin condition covers every transaction that had an id when the
 * snapshot was taken: it waits for the current xmin to pass recorded_xid, the
 * id of the acknowledgement that wrote the record. Xids are assigned in order,
 * so every transaction that held one at snapshot time has a lower id. (Not the
 * snapshot's xmax: that is latestCompletedXid + 1, not the next xid to be
 * assigned, so a transaction already running may have an id at or above it
 * and not be in xip.) The grace covers one that took its seq just before the
 * snapshot and its transaction id just after (both inside one INSERT, so
 * microseconds apart). This relies on a seq being followed promptly by its
 * row. prepareSystemMessageForOrderedDelivery reserves a seq first and inserts
 * later, so persistPreparedSystemMessage refuses a reservation older than
 * PREPARED_SYSTEM_MESSAGE_MAX_AGE_MS, which must stay below this grace.
 */
export const AGENT_INBOX_SKIP_RECORD_GRACE_MS = 60_000;

/** Records with no recorded_xid (written before migration 0596) are kept at least this long. */
export const AGENT_INBOX_LEGACY_SKIP_RECORD_GRACE_MS = 60 * 60_000;

/**
 * Skip records kept per agent at most. They pile up only while a long
 * transaction holds every snapshot's xmin (none can be deleted); past the cap
 * the oldest are dropped, logged and counted: a row they still covered that
 * commits later is then not recovered.
 */
export const AGENT_INBOX_SKIP_RECORD_CAP = 1_000;

let matchCapForTests: number | null = null;
let recordCapForTests: number | null = null;

/** Tests only: smaller caps (null restores a default). */
export function __setAgentInboxLateCapsForTests(caps: { match?: number | null; records?: number | null }): void {
  if (caps.match !== undefined) matchCapForTests = caps.match;
  if (caps.records !== undefined) recordCapForTests = caps.records;
}

function matchCap(): number {
  return matchCapForTests ?? AGENT_INBOX_LATE_MATCH_CAP;
}

function recordCap(): number {
  return recordCapForTests ?? AGENT_INBOX_SKIP_RECORD_CAP;
}

/** A pg_snapshot as PostgreSQL prints it (xmin:xmax:xip,...). */
export type AgentInboxPullSnapshot = string & { readonly __brand: "AgentInboxPullSnapshot" };

/** A late row handed over by a batch, and the skip record it came from. */
export type AgentInboxLateHanded = { recordId: string; conversationId: string; seq: number };

export type AgentInboxLateRow = AgentInboxLateHanded & {
  createdAt: Date;
  /** How far below the read position the ack set it sat. */
  seqLag: number;
};

export type AgentInboxLateScan = {
  /** Late rows to hand over, oldest record first; at most AGENT_INBOX_LATE_MATCH_CAP. */
  rows: AgentInboxLateRow[];
  /** More late rows than the cap: the rest come on the next pull. */
  paged: boolean;
  /** Skip records still kept for this agent after this scan (grows while a long transaction runs). */
  liveRecords: number;
};

type SkipRange = { conversationId: string; storageId: string; from: number; to: number; handed: number[] };

/**
 * The snapshot a pull takes before it reads any row. PRIMARY ONLY: on a
 * standby the snapshot describes replay, not the writer's in-flight
 * transactions.
 */
export async function readAgentInboxPullSnapshot(): Promise<AgentInboxPullSnapshot> {
  const result = await getDb().execute(sql`SELECT pg_current_snapshot()::text AS snapshot`);
  const snapshot = (result.rows[0] as { snapshot?: unknown } | undefined)?.snapshot;
  if (typeof snapshot !== "string" || !/^\d+:\d+:[\d,]*$/.test(snapshot)) throw new Error("agent_inbox_snapshot_invalid");
  return snapshot as AgentInboxPullSnapshot;
}

/**
 * This pull's late rows (PRIMARY ONLY, like the snapshot). Then deletes the
 * skip records that can no longer cover a late row: no transaction of their
 * snapshot is in flight, the grace has passed, and this scan, which saw all
 * their late rows, found none left.
 */
export async function scanAgentInboxLateRows(agentId: string): Promise<AgentInboxLateScan> {
  const db = getDb();
  const cap = matchCap();
  const result = await db.execute(sql`
    WITH ranges AS MATERIALIZED (
      SELECT r.id, r.snapshot::pg_snapshot AS snap, r.created_at,
        x."conversationId" AS conversation_id, x."storageId" AS storage_id, x."from" AS from_seq, x."to" AS to_seq,
        ARRAY(SELECT jsonb_array_elements_text(x.handed)::bigint) AS handed
      FROM agent_inbox_skip_records r
      CROSS JOIN LATERAL jsonb_to_recordset(r.ranges)
        AS x("conversationId" uuid, "storageId" uuid, "from" bigint, "to" bigint, handed jsonb)
      WHERE r.agent_id = ${agentId}
    )
    SELECT g.id::text AS "recordId", g.conversation_id::text AS "conversationId",
      m.seq::text AS seq, m.created_at AS "createdAt", (g.to_seq - m.seq)::text AS "seqLag"
    FROM ranges g
    CROSS JOIN LATERAL (
      SELECT m.seq, m.created_at
      FROM messages m
      WHERE m.channel_id = g.storage_id
        AND m.seq > g.from_seq AND m.seq <= g.to_seq
        AND m.insert_xid IS NOT NULL
        AND NOT pg_visible_in_snapshot(m.insert_xid, g.snap)
        AND NOT (m.seq = ANY(g.handed))
      -- One idx_messages_channel_seq probe per range; unflattened, the planner
      -- may join every insert_xid row against the ranges instead.
      OFFSET 0
    ) m
    ORDER BY g.created_at, g.id, m.seq
    LIMIT ${cap + 1}
  `);
  const matches = (result.rows as Array<Record<string, unknown>>).map((row) => ({
    recordId: String(row.recordId),
    conversationId: String(row.conversationId),
    seq: Number(row.seq),
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
    seqLag: Number(row.seqLag),
  }));
  const paged = matches.length > cap;
  const rows = matches.slice(0, cap);
  if (!paged) {
    // See AGENT_INBOX_SKIP_RECORD_GRACE_MS for why both conditions are needed.
    const withRows = [...new Set(rows.map((row) => row.recordId))];
    await db.execute(sql`
      DELETE FROM agent_inbox_skip_records r
      WHERE r.agent_id = ${agentId}
        AND r.created_at < now() - make_interval(secs => ${AGENT_INBOX_SKIP_RECORD_GRACE_MS / 1000})
        AND (
          pg_snapshot_xmin(pg_current_snapshot()) > r.recorded_xid
          -- Records written before recorded_xid existed (migration 0596): the
          -- old condition, held for an hour, past any insert still in flight.
          OR (
            r.recorded_xid IS NULL
            AND r.created_at < now() - make_interval(secs => ${AGENT_INBOX_LEGACY_SKIP_RECORD_GRACE_MS / 1000})
            AND pg_snapshot_xmin(pg_current_snapshot()) >= pg_snapshot_xmax(r.snapshot::pg_snapshot)
          )
        )
        AND NOT (r.id = ANY(${`{${withRows.join(",")}}`}::uuid[]))
    `);
  } else {
    console.warn(`agent inbox late rows paged: agent=${agentId} cap=${cap}`);
  }
  const [live] = await db.select({ count: sql<number>`count(*)::int` })
    .from(agentInboxSkipRecords)
    .where(eq(agentInboxSkipRecords.agentId, agentId));
  return { rows, paged, liveRecords: Number(live?.count ?? 0) };
}

/** One aggregate event per pull that scanned; no ids. */
export function emitAgentInboxLateRowsTrace(route: string, scan: AgentInboxLateScan, handedOver: number, dropped: number): void {
  const now = Date.now();
  let maxAgeMs = 0;
  let maxSeqLag = 0;
  for (const row of scan.rows) {
    maxAgeMs = Math.max(maxAgeMs, now - row.createdAt.getTime());
    maxSeqLag = Math.max(maxSeqLag, row.seqLag);
  }
  addTraceEvent("external_agent.inbox_late_rows.scanned", {
    route,
    late_count: scan.rows.length,
    handed_over_count: handedOver,
    dropped_count: dropped,
    paged: scan.paged,
    // How late: since the row was written, and how far below the read position it sat.
    max_age_ms: maxAgeMs,
    max_seq_lag: maxSeqLag,
    // Skip records kept for the agent: rises while a long transaction holds them.
    live_skip_records: scan.liveRecords,
  });
}

/**
 * A batch was acknowledged: record the ranges its ack moved the read position
 * over (with the rows handed over in them) under the pull's snapshot, and mark
 * the batch's late rows handed over in their own records.
 */
export async function recordAgentInboxAck(
  agentId: string,
  input: {
    snapshot: AgentInboxPullSnapshot;
    advances: readonly AgentReadPositionAdvance[];
    lateHanded: readonly AgentInboxLateHanded[];
  },
): Promise<void> {
  const db = getDb();
  if (input.advances.length > 0) {
    await db.insert(agentInboxSkipRecords).values({
      id: randomUUID(),
      agentId,
      snapshot: input.snapshot,
      ranges: input.advances.map((advance): SkipRange => ({
        conversationId: advance.conversationId,
        storageId: advance.storageId,
        from: advance.from,
        to: advance.to,
        handed: [...advance.acked].sort((a, b) => a - b),
      })),
    });
    const dropped = await db.execute(sql`
      DELETE FROM agent_inbox_skip_records
      WHERE id IN (
        SELECT id FROM agent_inbox_skip_records
        WHERE agent_id = ${agentId}
        ORDER BY created_at DESC, id DESC
        OFFSET ${recordCap()}
      )
      RETURNING id
    `);
    if (dropped.rows.length > 0) {
      console.error(`agent inbox skip records over cap: agent=${agentId} cap=${recordCap()} dropped=${dropped.rows.length}; a late row they covered is no longer recovered`);
      addTraceEvent("external_agent.inbox_skip_records.dropped", { dropped_count: dropped.rows.length, cap: recordCap() });
    }
  }
  const byRecord = new Map<string, AgentInboxLateHanded[]>();
  for (const row of input.lateHanded) byRecord.set(row.recordId, [...(byRecord.get(row.recordId) ?? []), row]);
  for (const [recordId, handed] of byRecord) {
    await db.transaction(async (tx) => {
      const [record] = await tx.select({ ranges: agentInboxSkipRecords.ranges })
        .from(agentInboxSkipRecords)
        .where(and(eq(agentInboxSkipRecords.id, recordId), eq(agentInboxSkipRecords.agentId, agentId)))
        .for("update")
        .limit(1);
      if (!record) return;
      const ranges = record.ranges.map((range) => {
        const add = handed
          .filter((row) => row.conversationId === range.conversationId && row.seq > range.from && row.seq <= range.to)
          .map((row) => row.seq);
        return add.length === 0 ? range : { ...range, handed: [...new Set([...range.handed, ...add])].sort((a, b) => a - b) };
      });
      await tx.update(agentInboxSkipRecords).set({ ranges }).where(eq(agentInboxSkipRecords.id, recordId));
    });
  }
}

/**
 * Cursor mode: the batch is not acknowledged yet; keep its snapshot and late
 * rows. `cursor` is the response's last_seen_seq: only a later since at or
 * above it acknowledges the late rows (they sit below the previous cursor, so a
 * client repeating that one after losing this response must not acknowledge
 * them by seq).
 */
export async function recordAgentInboxLatePending(
  agentId: string,
  input: { snapshot: AgentInboxPullSnapshot; late: readonly AgentInboxLateHanded[]; cursor: number | null },
): Promise<void> {
  const now = new Date();
  const late = input.late.map((row) => ({ recordId: row.recordId, conversationId: row.conversationId, seq: row.seq }));
  await getDb().insert(agentInboxLatePending)
    .values({ agentId, snapshot: input.snapshot, late, cursor: input.cursor, updatedAt: now })
    .onConflictDoUpdate({ target: agentInboxLatePending.agentId, set: { snapshot: input.snapshot, late, cursor: input.cursor, updatedAt: now } });
}

/**
 * Cursor mode, at the next request: its since acknowledged `advances` of the
 * previous batch. Records them under that batch's snapshot; the batch's late
 * rows count as handed over only if since reached the batch's cursor.
 */
export async function commitAgentInboxLatePending(
  agentId: string,
  input: { since: number; advances: readonly AgentReadPositionAdvance[] },
): Promise<void> {
  const db = getDb();
  const [pending] = await db.select().from(agentInboxLatePending).where(eq(agentInboxLatePending.agentId, agentId)).limit(1);
  if (!pending) {
    if (input.advances.length > 0) {
      console.warn(`agent inbox ack without a pending snapshot: agent=${agentId}; rows this ack passed are not recorded`);
    }
    return;
  }
  const received = pending.cursor === null || input.since >= Number(pending.cursor);
  await recordAgentInboxAck(agentId, {
    snapshot: pending.snapshot as AgentInboxPullSnapshot,
    advances: input.advances,
    lateHanded: received ? pending.late : [],
  });
}
