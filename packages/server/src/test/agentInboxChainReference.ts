/**
 * TEST-ONLY reference for the agent inbox chain.
 *
 * Agent resume recovery (channelService.getAgentUnreadCounts and
 * messageService.getAgentResumeCatchupMessages) reads ONE source: the agent inbox
 * view of the unified RisingWave chain (`rw_agent_inbox_v7`, read through
 * channelService.readAgentInboxChainRows). CI has no RisingWave, so this derives
 * the same rows from Postgres with the SAME semantics as the view, and tests pass
 * them as the chain.
 *
 * This is a stand-in for the RW view, not a product path. KEEP IT IN SYNC with the
 * SQL it mirrors:
 *   - infra/risingwave/sql/078-task-conversations.sql
 *                                                rw_agent_inbox_v7, rw_inbox_mention_v7,
 *                                                rw_conversation_parent_v1
 *   - infra/risingwave/sql/075-inbox-cursor-decouple.sql
 *                                                rw_inbox_normal_v5, rw_inbox_muted_prefix_v2
 *   - infra/risingwave/sql/064-agent-inbox-v3.sql
 *                                                rw_agent_inbox_v3
 *   - infra/risingwave/sql/063-chain-v5.sql      rw_muted_subs_v1
 *   - infra/risingwave/sql/063-unified-inbox-chain.sql
 *                                                rw_message_target_v3, rw_receiver_cursors_v1,
 *                                                rw_subs_v2, rw_target_latest_v4, rw_target_eligible_v1
 *   - infra/risingwave/sql/061-inbox-derivation-chain.sql
 *                                                rw_thread_parent_v3
 * Each CTE below is named after the view it mirrors, restricted to one agent.
 *
 * Summary of the semantics (all the view's, none invented here):
 *   - subscriptions: channel_agents memberships (non-thread, not deleted/archived)
 *     and active agent thread follows. A muted membership (inbox_target_mute_states
 *     activity_muted) only admits messages with seq < mute_from_seq (NULL admits all).
 *   - unread: seq > cursor (COALESCE(last_read_seq8, last_read_seq)), excluding the
 *     agent's own sends, system messages whose causal actor is the agent, and the
 *     noise subtypes channel.self_unfollow_thread / task.deleted_summary. No join bound.
 *   - mention arm (v7): message_mentions for the agent with seq > cursor that
 *     notify (notifiable_at_send, or notified_at set later). A mention
 *     stored under a joint local projection id (the SENDER's projection) is first
 *     mapped to its canonical storage, then fanned out to every local target like
 *     messages. Visible through membership, parent membership, an active follow, or
 *     notified_at -- the notified outsider admission only for a target that is not
 *     a joint projection. A row that exists only through this arm has
 *     subscribed = false.
 *   - free-plan eligibility is per target: a free-plan target whose latest message
 *     is older than 30 days has no row at all.
 *   - joint projections: target_id is the local projection, storage_channel_id the
 *     canonical channel (active joint_channel_servers + joint_channels); messages and
 *     mentions are counted from storage.
 *   - thread parent columns: parent_message_id is COALESCE(rw_thread_parent_v3's,
 *     the thread's own channels.parent_message_id) -- the canonical parent for a
 *     joint local thread projection; parent_channel_* is the LOCAL parent as
 *     rw_thread_parent_v3 resolves it.
 *   - task conversations (channels.type = 'task'): sub-conversations like threads
 *     (rw_conversation_parent_v1: parent = channels.parent_channel_id, no parent
 *     message), kind 'task' in the output. taskNumber / taskTitle are not view
 *     columns: the reader adds them from Postgres; here they are joined directly.
 *   - offered rows only (rw_agent_inbox_v7): the agent is joined (membership or
 *     active follow, joined_at not null) and the row offers unread: the admitted
 *     stream has unread (subscribed and unread_count > 0), OR mention_unread > 0 and
 *     the mention lies beyond the admitted stream (not subscribed, or
 *     max_mention_seq > latest_seq -- a mention after mute_from_seq pierces the
 *     mute, the rw_inbox_items_v9 rule for humans); the target is not deleted; a
 *     thread row only when its parent is not deleted and the agent belongs to it,
 *     or it is a public channel of the row's server. offered_unread = subscribed ?
 *     unread_count (+1 when a pierced mention exists) : mention_unread;
 *     activity_seq = GREATEST(latest_seq, max_mention_seq).
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db/index";
import type { AgentInboxChainRow } from "../services/channelService";

const NOISE_SUBTYPES = sql`('channel.self_unfollow_thread', 'task.deleted_summary')`;

export async function referenceAgentInboxChain(agentId: string): Promise<AgentInboxChainRow[]> {
  const agent = sql`${agentId}::text`;
  const unreadPredicate = sql`m.seq > COALESCE(rc.last_read_seq, 0)
    AND NOT (m.sender_type = 'agent' AND m.sender_id = ${agent})
    AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'agent' AND m.causal_actor_id = ${agent}, FALSE)
    AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ${NOISE_SUBTYPES})`;

  const result = await getDb().execute(sql`
    WITH proj AS (
      SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
      FROM joint_channel_servers AS s
      JOIN joint_channels AS j ON j.id = s.joint_channel_id
      WHERE s.status = 'active' AND j.status = 'active'
    ), chan_map AS (
      SELECT c.id AS storage_id, c.id AS target_id, FALSE AS projected
      FROM channels AS c
      LEFT JOIN proj AS p ON p.local_channel_id = c.id
      WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND p.local_channel_id IS NULL
      UNION ALL
      SELECT p.canonical_channel_id, p.local_channel_id, TRUE FROM proj AS p
    ), mention_storage AS (         -- rw_inbox_mention_v7: a sender-projection id -> canonical storage
      SELECT m.*, COALESCE(pj.canonical_channel_id, m.channel_id) AS storage_id
      FROM message_mentions AS m
      LEFT JOIN proj AS pj ON pj.local_channel_id = m.channel_id
    ), message_target AS (          -- rw_message_target_v3
      SELECT map.target_id, m.seq, m.created_at, m.sender_type, m.sender_id,
             m.message_type, m.causal_actor_type, m.causal_actor_id, m.system_subtype
      FROM messages AS m
      JOIN chan_map AS map ON m.channel_id = map.storage_id
    ), target_latest AS (           -- rw_target_latest_v4
      SELECT target_id, MAX(seq) AS latest_seq, MAX(created_at) AS latest_at
      FROM message_target GROUP BY target_id
    ), target_eligible AS (         -- rw_target_eligible_v1
      SELECT c.id AS target_id
      FROM channels AS c
      LEFT JOIN target_latest AS tl ON tl.target_id = c.id
      LEFT JOIN servers AS sv ON sv.id = c.server_id
      WHERE tl.target_id IS NULL
         OR COALESCE(sv.plan, 'free') <> 'free'
         OR tl.latest_at > NOW() - INTERVAL '30 days'
    ), receiver_cursors AS (        -- rw_receiver_cursors_v1 (agent arm)
      SELECT channel_id, COALESCE(last_read_seq8, CAST(last_read_seq AS BIGINT)) AS last_read_seq
      FROM agent_channel_read_cursors
      WHERE agent_id::text = ${agent}
    ), subs AS (                    -- rw_subs_v2 (agent arms)
      SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind, c.id AS target_id, c.server_id
      FROM channel_agents AS ca
      JOIN channels AS c ON ca.channel_id = c.id AND c.type <> 'thread'
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      LEFT JOIN inbox_target_mute_states AS mu
        ON mu.receiver_type = 'agent' AND mu.receiver_id = ca.agent_id
       AND mu.source_channel_id = c.id AND mu.activity_muted
      WHERE ca.agent_id::text = ${agent} AND mu.receiver_id IS NULL
      UNION ALL
      SELECT 'thread', c.id, c.server_id
      FROM thread_follows AS tf
      JOIN channels AS c ON tf.thread_channel_id = c.id
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      WHERE tf.follower_type = 'agent' AND tf.follower_id::text = ${agent} AND tf.unfollowed_at IS NULL
    ), muted_subs AS (              -- rw_muted_subs_v1 (agent arm)
      SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind, c.id AS target_id, c.server_id,
             mu.mute_from_seq
      FROM channel_agents AS ca
      JOIN channels AS c ON ca.channel_id = c.id AND c.type <> 'thread'
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      JOIN inbox_target_mute_states AS mu
        ON mu.receiver_type = 'agent' AND mu.receiver_id = ca.agent_id
       AND mu.source_channel_id = c.id AND mu.activity_muted
      WHERE ca.agent_id::text = ${agent}
    ), normal AS (                  -- rw_inbox_normal_v5
      SELECT s.kind, s.target_id, s.server_id,
             MAX(m.seq) AS latest_seq,
             COUNT(*) FILTER (WHERE ${unreadPredicate}) AS unread_count,
             MIN(m.seq) FILTER (WHERE ${unreadPredicate}) AS first_unread_seq
      FROM subs AS s
      JOIN target_eligible AS g ON g.target_id = s.target_id
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = s.target_id
      LEFT JOIN message_target AS m ON m.target_id = s.target_id
      GROUP BY s.kind, s.target_id, s.server_id, rc.last_read_seq
    ), muted_prefix AS (            -- rw_inbox_muted_prefix_v2
      SELECT s.kind, s.target_id, s.server_id,
             MAX(m.seq) AS latest_seq,
             COUNT(*) FILTER (WHERE ${unreadPredicate}) AS unread_count,
             MIN(m.seq) FILTER (WHERE ${unreadPredicate}) AS first_unread_seq
      FROM muted_subs AS s
      JOIN target_eligible AS g ON g.target_id = s.target_id
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = s.target_id
      JOIN message_target AS m
        ON m.target_id = s.target_id AND (s.mute_from_seq IS NULL OR m.seq < s.mute_from_seq)
      GROUP BY s.kind, s.target_id, s.server_id, rc.last_read_seq
    ), thread_parent AS (           -- rw_conversation_parent_v1 (rw_thread_parent_v3 + task conversations)
      SELECT c.id AS thread_channel_id, c.parent_message_id, m.channel_id AS parent_channel_id,
             pc.name AS parent_channel_name, pc.type AS parent_channel_type
      FROM channels AS c
      JOIN messages AS m ON m.id = c.parent_message_id
      JOIN channels AS pc ON pc.id = m.channel_id
      LEFT JOIN proj AS px ON px.local_channel_id = c.id
      WHERE c.type = 'thread' AND px.local_channel_id IS NULL
      UNION ALL
      SELECT lt.id, ct.parent_message_id, COALESCE(pl.local_channel_id, m.channel_id),
             pc2.name, pc2.type
      FROM channels AS lt
      JOIN proj AS p ON p.local_channel_id = lt.id
      JOIN channels AS ct ON ct.id = p.canonical_channel_id
      JOIN messages AS m ON m.id = ct.parent_message_id
      LEFT JOIN proj AS pl ON pl.canonical_channel_id = m.channel_id AND pl.server_id = lt.server_id
      JOIN channels AS pc2 ON pc2.id = COALESCE(pl.local_channel_id, m.channel_id)
      WHERE lt.type = 'thread'
      UNION ALL
      SELECT tc.id, NULL::uuid, tc.parent_channel_id, tpc.name, tpc.type
      FROM channels AS tc
      JOIN channels AS tpc ON tpc.id = tc.parent_channel_id
      WHERE tc.type = 'task'
    ), mention AS (                 -- rw_inbox_mention_v7 (agent arm)
      SELECT CASE WHEN c.type IN ('thread', 'task') THEN 'thread' WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
             map.target_id, c.server_id,
             COUNT(*) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
               AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)) AS mention_unread,
             MAX(mm.message_seq) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
               AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)) AS max_mention_seq
      FROM mention_storage AS mm
      JOIN chan_map AS map ON map.storage_id = mm.storage_id
      JOIN target_eligible AS g ON g.target_id = map.target_id
      JOIN channels AS c ON c.id = map.target_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
      LEFT JOIN channel_agents AS visa ON visa.channel_id = map.target_id AND visa.agent_id = mm.target_id
      LEFT JOIN thread_parent AS tp ON tp.thread_channel_id = map.target_id
      LEFT JOIN channel_agents AS pvisa ON pvisa.channel_id = tp.parent_channel_id AND pvisa.agent_id = mm.target_id
      LEFT JOIN thread_follows AS mf ON mf.thread_channel_id = map.target_id AND mf.follower_type = 'agent'
       AND mf.follower_id = mm.target_id AND mf.unfollowed_at IS NULL
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = map.target_id
      WHERE mm.target_type = 'agent' AND mm.target_id::text = ${agent}
        AND ((c.type NOT IN ('thread', 'task') AND visa.agent_id IS NOT NULL)
          OR (c.type IN ('thread', 'task') AND (pvisa.agent_id IS NOT NULL OR mf.follower_id IS NOT NULL))
          OR (mm.notified_at IS NOT NULL AND NOT map.projected))
      GROUP BY 1, 2, 3
    ), n AS (
      SELECT kind, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM normal
      UNION ALL
      SELECT kind, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM muted_prefix
    ), u AS (
      SELECT COALESCE(n.kind, mn.kind) AS kind,
             COALESCE(n.target_id, mn.target_id) AS target_id,
             COALESCE(n.server_id, mn.server_id) AS server_id,
             COALESCE(n.unread_count, 0) AS unread_count,
             n.first_unread_seq, n.latest_seq,
             COALESCE(mn.mention_unread, 0) AS mention_unread,
             mn.max_mention_seq,
             (n.target_id IS NOT NULL) AS subscribed
      FROM n
      FULL JOIN mention AS mn ON n.kind = mn.kind AND n.target_id = mn.target_id
      -- 065: a mention beyond the admitted stream pierces a mute (rw_inbox_items_v9 rule).
      WHERE (n.target_id IS NOT NULL AND COALESCE(n.unread_count, 0) > 0)
         OR (COALESCE(mn.mention_unread, 0) > 0
             AND (n.target_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)))
    )
    SELECT CASE WHEN u.kind = 'thread' AND c.type = 'task' THEN 'task' ELSE u.kind END AS kind,
           u.target_id::text AS target_id,
           conv_task.task_number AS task_number, conv_task.title AS task_title,
           COALESCE(p.canonical_channel_id, u.target_id)::text AS storage_channel_id,
           u.server_id::text AS server_id,
           c.name AS channel_name, c.type AS channel_type,
           COALESCE(tp.parent_message_id, c.parent_message_id)::text AS parent_message_id,
           tp.parent_channel_id::text AS parent_channel_id, tp.parent_channel_name, tp.parent_channel_type,
           CAST(COALESCE(rc.last_read_seq, 0) AS BIGINT) AS last_read_seq,
           u.unread_count, u.first_unread_seq, u.latest_seq,
           u.mention_unread, u.max_mention_seq, u.subscribed,
           CASE WHEN u.subscribed
                THEN u.unread_count + CASE WHEN u.mention_unread > 0 AND u.max_mention_seq > COALESCE(u.latest_seq, 0) THEN 1 ELSE 0 END
                ELSE u.mention_unread END AS offered_unread,
           GREATEST(COALESCE(u.latest_seq, 0), COALESCE(u.max_mention_seq, 0)) AS activity_seq,
           CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END AS joined_at
    FROM u
    JOIN channels AS c ON c.id = u.target_id AND c.deleted_at IS NULL
    LEFT JOIN tasks AS conv_task ON c.type = 'task' AND conv_task.id = c.task_id
    LEFT JOIN proj AS p ON p.local_channel_id = u.target_id
    LEFT JOIN thread_parent AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
    LEFT JOIN channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL
    LEFT JOIN channel_agents AS pca
      ON pca.channel_id = tp.parent_channel_id AND pca.agent_id::text = ${agent}
    LEFT JOIN receiver_cursors AS rc ON rc.channel_id = u.target_id
    LEFT JOIN channel_agents AS ca
      ON ca.channel_id = u.target_id AND ca.agent_id::text = ${agent} AND u.kind <> 'thread'
    LEFT JOIN thread_follows AS tf
      ON tf.thread_channel_id = u.target_id AND tf.follower_type = 'agent'
     AND tf.follower_id::text = ${agent} AND tf.unfollowed_at IS NULL AND u.kind = 'thread'
    WHERE (CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END) IS NOT NULL
      AND (u.kind <> 'thread' OR (
            pc.id IS NOT NULL
            AND (pca.agent_id IS NOT NULL OR (pc.type = 'channel' AND pc.server_id = u.server_id))
          ))
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return rows.map((row) => ({
    targetId: String(row.target_id),
    storageChannelId: String(row.storage_channel_id),
    kind: row.kind as AgentInboxChainRow["kind"],
    serverId: String(row.server_id),
    channelName: String(row.channel_name),
    channelType: row.channel_type as AgentInboxChainRow["channelType"],
    parentMessageId: row.parent_message_id == null ? null : String(row.parent_message_id),
    parentChannelId: row.parent_channel_id == null ? null : String(row.parent_channel_id),
    parentChannelName: row.parent_channel_name == null ? null : String(row.parent_channel_name),
    parentChannelType: row.parent_channel_type == null ? null : String(row.parent_channel_type),
    lastReadSeq: Number(row.last_read_seq),
    unreadCount: Number(row.unread_count),
    firstUnreadSeq: num(row.first_unread_seq),
    latestSeq: num(row.latest_seq),
    mentionUnread: Number(row.mention_unread),
    maxMentionSeq: num(row.max_mention_seq),
    subscribed: row.subscribed === true,
    offeredUnread: Number(row.offered_unread),
    activitySeq: Number(row.activity_seq),
    joinedAt: new Date(row.joined_at as string | Date),
    ...(row.kind === "task"
      ? { taskNumber: num(row.task_number), taskTitle: row.task_title == null ? null : String(row.task_title) }
      : {}),
  }));
}
