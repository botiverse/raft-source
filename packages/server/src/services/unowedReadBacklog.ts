/**
 * "Unread is not owed": an agent's read position in a conversation where it
 * owes nothing may move past messages it was never shown one by one.
 *
 * On a Computer a read position moves only when the model is shown a message
 * (`agent:model-seen`) or the agent reads or replies itself. Channel traffic
 * that arrives while the agent is not running, without addressing it, is never
 * shown: a start woken by a DM gets only the unread counts, and the startup
 * catch-up is a few of the oldest rows. So such conversations stay "unread" for
 * months, and an agent that pulls with ack-as-read (a cloud agent) replays all
 * of it (#raft-antiproton:9f9d85b0).
 *
 * The rule, shared by the switch to the cloud and by a completed first turn:
 * a conversation is settled to `throughSeq` unless the agent owes something in
 * it up to there: it is a DM (or a thread in one), it has an unread @mention of
 * the agent, or an unread message that assigns the agent a task. Raise-only,
 * with the version bump a join uses (raiseReadPositionForJoin).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import {
  agentChannelReadCursors,
  channels,
  jointChannelServers,
  jointChannels,
  messageMentions,
  messages,
} from "../db/schema";

/** A conversation (the agent's local id, as its read position is keyed) and how far it may be settled. */
export interface UnowedReadBacklogTarget {
  channelId: string;
  throughSeq: number;
}

export interface UnowedReadBacklogSettled {
  /** Conversations whose read position moved. */
  conversations: number;
  /** Messages that stopped counting as unread. */
  messages: number;
  /** Conversations behind their target that were left unread because the agent owes something there. */
  keptConversations: number;
}

const NONE: UnowedReadBacklogSettled = { conversations: 0, messages: 0, keptConversations: 0 };

/** Every conversation the agent has a read position in, settled through its latest message. */
export async function readPositionLatestTargets(executor: DatabaseExecutor, agentId: string): Promise<UnowedReadBacklogTarget[]> {
  const result = await executor.execute(sql`
    SELECT cursors.channel_id AS "channelId",
      (SELECT max(${messages.seq}) FROM ${messages} WHERE ${messages.channelId} = ${storageChannelIdSql(sql`cursors.channel_id`)})::bigint AS "latestSeq"
    FROM ${agentChannelReadCursors} AS cursors
    WHERE cursors.agent_id = ${agentId}::uuid
  `);
  return (result.rows as Array<{ channelId: string; latestSeq: string | number | null }>)
    .filter((row) => row.latestSeq !== null)
    .map((row) => ({ channelId: String(row.channelId), throughSeq: Number(row.latestSeq) }));
}

/** A joint channel's messages live under its canonical channel; the read position is on this server's projection. */
function storageChannelIdSql(localChannelId: SQL): SQL {
  return sql`COALESCE((
    SELECT ${jointChannels.canonicalChannelId}
    FROM ${jointChannelServers}
    INNER JOIN ${jointChannels} ON ${jointChannels.id} = ${jointChannelServers.jointChannelId} AND ${jointChannels.status} = 'active'
    WHERE ${jointChannelServers.localChannelId} = ${localChannelId} AND ${jointChannelServers.status} = 'active'
    LIMIT 1
  ), ${localChannelId})`;
}

/**
 * The `(target_id, through_seq)` input rows of one read, at most one per
 * conversation (the highest through seq). Null when nothing is behind.
 */
function backlogInput(targets: readonly UnowedReadBacklogTarget[]): SQL | null {
  const byChannel = new Map<string, number>();
  for (const target of targets) {
    if (!Number.isSafeInteger(target.throughSeq) || target.throughSeq <= 0) continue;
    byChannel.set(target.channelId, Math.max(byChannel.get(target.channelId) ?? 0, target.throughSeq));
  }
  if (byChannel.size === 0) return null;
  return sql.join(
    [...byChannel].map(([channelId, throughSeq]) => sql`(${channelId}::uuid, ${throughSeq}::bigint)`),
    sql`, `,
  );
}

/**
 * The one definition of "owes" (CTEs `input`, `scoped`, `candidates`, `behind`):
 * each target conversation behind the agent's read position up to its through
 * seq, with whether the agent owes something there in that range (`is_dm`,
 * `has_unread_mention`, `has_unread_task`). Both the settle below and
 * owedReadBacklogTargets read these rows. With `createdSince`, only messages
 * created at or after it count as owed: a DM owes only when one of its unread
 * messages is that recent, a mention or task only when its message is. The
 * settle never passes it.
 */
function behindBacklogCtes(agentId: string, input: SQL, createdSince: Date | null = null): SQL {
  const since = createdSince ? createdSince.toISOString() : null;
  const recentDmMessage = since
    ? sql` AND EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.channelId} = scoped.storage_id
            AND ${messages.seq} > scoped.last_read_seq
            AND ${messages.seq} <= scoped.through_seq
            AND ${messages.createdAt} >= ${since}::timestamptz
        )`
    : sql``;
  const recentMention = since
    ? sql` AND EXISTS (
            SELECT 1 FROM ${messages} AS mentioned
            WHERE mentioned.id = ${messageMentions.messageId} AND mentioned.created_at >= ${since}::timestamptz
          )`
    : sql``;
  const recentTask = since ? sql` AND ${messages.createdAt} >= ${since}::timestamptz` : sql``;
  return sql`
    WITH input(target_id, through_seq) AS (VALUES ${input}),
    scoped AS (
      SELECT input.target_id, input.through_seq,
        COALESCE(cursor.last_read_seq, 0)::bigint AS last_read_seq,
        ${storageChannelIdSql(sql`input.target_id`)} AS storage_id
      FROM input
      LEFT JOIN ${agentChannelReadCursors} AS cursor
        ON cursor.agent_id = ${agentId}::uuid AND cursor.channel_id = input.target_id
    ), candidates AS (
      SELECT scoped.target_id, scoped.storage_id, scoped.last_read_seq,
        LEAST(scoped.through_seq, (SELECT max(${messages.seq}) FROM ${messages} WHERE ${messages.channelId} = scoped.storage_id))::bigint AS settle_seq,
        ((conversation.type = 'dm' OR COALESCE(parent.type = 'dm', false))${recentDmMessage}) AS is_dm,
        EXISTS (
          SELECT 1 FROM ${messageMentions}
          WHERE ${messageMentions.targetType} = 'agent'
            AND ${messageMentions.targetId} = ${agentId}::uuid
            AND ${messageMentions.channelId} = scoped.storage_id
            AND ${messageMentions.messageSeq} > scoped.last_read_seq
            AND ${messageMentions.messageSeq} <= scoped.through_seq${recentMention}
        ) AS has_unread_mention,
        EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.channelId} = scoped.storage_id
            AND ${messages.taskAssigneeType} = 'agent'
            AND ${messages.taskAssigneeId} = ${agentId}
            AND ${messages.seq} > scoped.last_read_seq
            AND ${messages.seq} <= scoped.through_seq${recentTask}
        ) AS has_unread_task
      FROM scoped
      INNER JOIN ${channels} AS conversation ON conversation.id = scoped.target_id
      LEFT JOIN ${channels} AS parent ON parent.id = conversation.parent_channel_id
    ), behind AS (
      SELECT * FROM candidates WHERE settle_seq IS NOT NULL AND settle_seq > last_read_seq
    )`;
}

/**
 * The target conversations where the agent owes something past its read
 * position, up to each through seq: a DM (or a thread in one), an unread
 * @mention of the agent, or an unread message assigning it a task. The
 * complement of what settleUnowedReadBacklog settles; reads only. A message
 * the agent was shown (`agent:model-seen`), read itself (`raft message read
 * --unread`, `raft inbox read`, an `/events` ack; not a hosted agent's
 * `raft message check`, which its daemon answers: RFC 081 §3) or replied after
 * is behind the read position and owes nothing here. With
 * `createdSince`, only what was created at or after it is owed.
 */
export async function owedReadBacklogTargets(
  executor: DatabaseExecutor,
  agentId: string,
  targets: readonly UnowedReadBacklogTarget[],
  options: { createdSince?: Date } = {},
): Promise<string[]> {
  const input = backlogInput(targets);
  if (!input) return [];
  const result = await executor.execute(sql`${behindBacklogCtes(agentId, input, options.createdSince ?? null)}
    SELECT behind.target_id AS "channelId" FROM behind
    WHERE behind.is_dm OR behind.has_unread_mention OR behind.has_unread_task
  `);
  return (result.rows as Array<{ channelId: string }>).map((row) => String(row.channelId));
}

export async function settleUnowedReadBacklog(
  executor: DatabaseExecutor,
  agentId: string,
  targets: readonly UnowedReadBacklogTarget[],
): Promise<UnowedReadBacklogSettled> {
  const input = backlogInput(targets);
  if (!input) return NONE;
  const result = await executor.execute(sql`${behindBacklogCtes(agentId, input)},
    settled AS (
      SELECT behind.target_id, behind.settle_seq,
        (SELECT count(*) FROM ${messages}
          WHERE ${messages.channelId} = behind.storage_id
            AND ${messages.seq} > behind.last_read_seq
            AND ${messages.seq} <= behind.settle_seq)::int AS skipped
      FROM behind
      WHERE NOT behind.is_dm AND NOT behind.has_unread_mention AND NOT behind.has_unread_task
    ), raised AS (
      INSERT INTO agent_channel_read_cursors (agent_id, channel_id, last_read_seq, read_state_version, updated_at)
      SELECT ${agentId}::uuid, settled.target_id, settled.settle_seq, 1, now() FROM settled
      ON CONFLICT (agent_id, channel_id) DO UPDATE SET
        last_read_seq = EXCLUDED.last_read_seq,
        read_state_version = agent_channel_read_cursors.read_state_version + 1,
        updated_at = now()
      WHERE EXCLUDED.last_read_seq > agent_channel_read_cursors.last_read_seq
      RETURNING channel_id
    )
    SELECT
      (SELECT count(*) FROM raised)::int AS conversations,
      (SELECT COALESCE(sum(settled.skipped), 0) FROM settled INNER JOIN raised ON raised.channel_id = settled.target_id)::int AS messages,
      (SELECT count(*) FROM behind WHERE is_dm OR has_unread_mention OR has_unread_task)::int AS kept
  `);
  const [row] = result.rows as Array<{ conversations: number | string; messages: number | string; kept: number | string }>;
  return {
    conversations: Number(row?.conversations ?? 0),
    messages: Number(row?.messages ?? 0),
    keptConversations: Number(row?.kept ?? 0),
  };
}
