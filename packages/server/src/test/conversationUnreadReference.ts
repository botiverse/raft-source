/**
 * TEST-ONLY reference for the sidebar unread view.
 *
 * GET /channels/unread (bare and summary) and GET /servers/unread-summary read ONE
 * source: rw_conversation_unread_v4 (plus, for the summary, a request-time public
 * channel `hasNew` arm), through channelService's conversation unread reader. CI
 * has no RisingWave, so this derives the same rows from Postgres with the SAME
 * semantics as the view; src/test/setup/risingWaveReadReference.ts installs it for
 * every server test (and the e2e server) through the seam in
 * services/conversationUnreadSource.ts.
 *
 * This is a stand-in for the RW view, not a product path. KEEP IT IN SYNC with the
 * SQL it mirrors:
 *   - infra/risingwave/sql/078-task-conversations.sql
 *                                                rw_conversation_unread_v4, rw_inbox_mention_v7,
 *                                                rw_conversation_parent_v1
 *   - infra/risingwave/sql/075-inbox-cursor-decouple.sql
 *                                                rw_inbox_normal_v5
 *   - infra/risingwave/sql/066-conversation-unread-v1.sql
 *                                                rw_inbox_muted_full_v1
 *   - infra/risingwave/sql/063-chain-v5.sql      rw_muted_subs_v1
 *   - infra/risingwave/sql/063-unified-inbox-chain.sql
 *                                                rw_message_target_v3, rw_receiver_cursors_v1,
 *                                                rw_subs_v2, rw_target_latest_v4, rw_target_eligible_v1
 *   - infra/risingwave/sql/061-inbox-derivation-chain.sql
 *                                                rw_thread_parent_v3, rw_message_preview_v1
 *   - channelService readConversationUnreadSummaryRows / readSidebarUnreadTotals
 *                                                (the reader's WHERE and the public arm)
 * Each CTE below is named after the view it mirrors, restricted to one user.
 *
 * Summary of the semantics (all the view's, none invented here):
 *   - subscriptions: channel_humans memberships (non-thread, not deleted/archived),
 *     split into unmuted (rw_subs_v2) and muted (rw_muted_subs_v1) -- the muted arm
 *     keeps the FULL count (no mute_from_seq cut) -- and active user thread follows.
 *   - unread: seq > cursor (user_channel_read_cursors.last_read_seq), excluding the
 *     user's own sends, system messages whose causal actor is the user (a NULL
 *     causal actor never excludes), and the noise subtypes
 *     channel.self_unfollow_thread / task.deleted_summary.
 *   - task conversations (channels.type = 'task') are sub-conversations like
 *     threads (rw_conversation_parent_v1): reached through a follow, parent = the
 *     task's channel (channels.parent_channel_id); their rows say kind 'task'
 *     and their unread counts chat messages only (the reply basis: no
 *     lifecycle lines; rw_task_conversation_unread_v1).
 *   - mention arm (v6): message_mentions for the user (any admission flag). A
 *     mention stored under a joint local projection id (the SENDER's projection) is
 *     first mapped to its canonical storage, then fanned out to every local target.
 *     Visible through membership, parent membership, an active follow, or
 *     notified_at -- the notified outsider admission only for a non-projected target;
 *     mention_unread counts seq > cursor among the mentions that notify
 *     (notifiable_at_send, or notified_at set later; 078), total_mentions all of
 *     them. A row that
 *     exists only through this arm has subscribed = false.
 *   - free-plan eligibility is per target: a free-plan target whose latest message
 *     is older than 30 days has no row at all (both arms).
 *   - joint projections: target_id is the LOCAL projection; messages and mentions
 *     are counted from the canonical storage channel.
 *   - a thread / task conversation row exists only while followed, not done, under a
 *     live (not deleted, not archived) parent the user can see: public, or a member.
 *   - public arm (reader, not view): the server's live public ('channel') channels
 *     the user has not joined, eligible, whose latest seq is past the user's cursor.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../db/index";
import type {
  ConversationUnreadRow,
  ConversationUnreadSource,
  ConversationUnreadSummaryQuery,
  SidebarUnreadTotalsQuery,
} from "../services/conversationUnreadSource";

const NOISE_SUBTYPES = sql`('channel.self_unfollow_thread', 'task.deleted_summary')`;

// The view keys every row by uuid::text, which is always the canonical lowercase
// form; any other spelling matches nothing there. Checking that here lets the
// SQL compare as uuid (so the per-user indexes apply) without changing the answer.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Every rw_conversation_unread_v4 row of one user, restricted to the given servers.
 *
 * Cost is bounded by the user's own targets (memberships, follows, mentions in the
 * given servers), never by the size of messages/channels: the view's per-target
 * aggregates (rw_target_latest_v4, rw_target_eligible_v1, the unread counts) are
 * evaluated only for those targets, through (channel_id, seq) / (channel_id,
 * created_at) index probes. Three shortcuts, each unable to change the output:
 *   - a thread row survives the final filter only while subscribed and not done, so
 *     done follows are dropped up front (a mention-only thread row never survives);
 *   - u.server_id is always the target channel's server_id, so the server filter is
 *     applied to each arm before aggregation instead of after;
 *   - latest_at only matters for free-plan eligibility, so it is read only there.
 */
export async function referenceConversationUnreadViewRows(
  userId: string,
  serverIds: readonly string[],
): Promise<ConversationUnreadRow[]> {
  if (serverIds.length === 0 || !CANONICAL_UUID.test(userId)) return [];
  const user = sql`${userId}::uuid`;
  const servers = sql`ARRAY[${sql.join(serverIds.map((id) => sql`${id}::text`), sql`, `)}]::text[]`;
  const unreadPredicate = sql`m.seq > COALESCE(rc.last_read_seq, 0)
    AND NOT (m.sender_type = 'user' AND m.sender_id = ${userId}::text)
    AND NOT COALESCE(m.message_type = 'system' AND m.causal_actor_type = 'user' AND m.causal_actor_id = ${userId}::text, FALSE)
    AND (m.system_subtype IS NULL OR m.system_subtype NOT IN ${NOISE_SUBTYPES})`;

  const result = await getDb().execute(sql`
    WITH proj AS (
      SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
      FROM joint_channel_servers AS s
      JOIN joint_channels AS j ON j.id = s.joint_channel_id
      WHERE s.status = 'active' AND j.status = 'active'
    ), receiver_cursors AS (        -- rw_receiver_cursors_v1 (user arm)
      SELECT channel_id, CAST(last_read_seq AS BIGINT) AS last_read_seq
      FROM user_channel_read_cursors
      WHERE user_id = ${user}
    ), subs AS (                    -- rw_subs_v2 (user arms)
      SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind, c.id AS target_id, c.server_id,
             st.done_at
      FROM channel_humans AS ch
      JOIN channels AS c ON ch.channel_id = c.id AND c.type <> 'thread'
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      LEFT JOIN inbox_target_mute_states AS mu
        ON mu.receiver_type = 'user' AND mu.receiver_id = ch.user_id
       AND mu.source_channel_id = c.id AND mu.activity_muted
      LEFT JOIN user_channel_inbox_states AS st
        ON st.user_id = ch.user_id AND st.channel_id = c.id
      WHERE ch.user_id = ${user} AND mu.receiver_id IS NULL AND c.server_id::text = ANY(${servers})
      UNION ALL
      SELECT 'thread', c.id, c.server_id, tf.done_at
      FROM thread_follows AS tf
      JOIN channels AS c ON tf.thread_channel_id = c.id
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      WHERE tf.follower_type = 'user' AND tf.follower_id = ${user} AND tf.unfollowed_at IS NULL
        AND tf.done_at IS NULL AND c.server_id::text = ANY(${servers})
    ), muted_subs AS (              -- rw_muted_subs_v1 (user arm)
      SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind, c.id AS target_id, c.server_id,
             st.done_at
      FROM channel_humans AS ch
      JOIN channels AS c ON ch.channel_id = c.id AND c.type <> 'thread'
       AND c.deleted_at IS NULL AND c.archived_at IS NULL
      JOIN inbox_target_mute_states AS mu
        ON mu.receiver_type = 'user' AND mu.receiver_id = ch.user_id
       AND mu.source_channel_id = c.id AND mu.activity_muted
      LEFT JOIN user_channel_inbox_states AS st
        ON st.user_id = ch.user_id AND st.channel_id = c.id
      WHERE ch.user_id = ${user} AND c.server_id::text = ANY(${servers})
    ), mention_storage AS (         -- rw_inbox_mention_v7: a sender-projection id -> canonical storage
      -- idx_message_mentions_inbox columns plus whether the mention notifies (the
      -- mention_unread filter); notified_at as an admission is read per row below,
      -- and only where membership/follow visibility does not already admit the row.
      SELECT m.channel_id, m.message_seq, COALESCE(pj.canonical_channel_id, m.channel_id) AS storage_id,
             (m.notifiable_at_send OR m.notified_at IS NOT NULL) AS notifies
      FROM message_mentions AS m
      LEFT JOIN proj AS pj ON pj.local_channel_id = m.channel_id
      WHERE m.target_type = 'user' AND m.target_id = ${user}
    ), mention_map AS (             -- chan_map rows reachable from the user's mentions
      SELECT c.id AS storage_id, c.id AS target_id, FALSE AS projected
      FROM channels AS c
      WHERE c.id IN (SELECT storage_id FROM mention_storage)
        AND c.deleted_at IS NULL AND c.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM proj AS p WHERE p.local_channel_id = c.id)
      UNION ALL
      SELECT p.canonical_channel_id, p.local_channel_id, TRUE
      FROM proj AS p
      WHERE p.canonical_channel_id IN (SELECT storage_id FROM mention_storage)
    ), cand AS (                    -- every target this user's rows can have
      SELECT target_id FROM subs
      UNION
      SELECT target_id FROM muted_subs
      UNION
      SELECT map.target_id
      FROM mention_map AS map
      WHERE (SELECT c.server_id::text FROM channels AS c
             WHERE c.id = map.target_id AND c.deleted_at IS NULL AND c.archived_at IS NULL) = ANY(${servers})
    ), target_latest AS (           -- rw_target_latest_v4 + rw_target_eligible_v1, per candidate
      -- chan_map gives a target at most one storage: its canonical channel when it is an
      -- active projection, else itself while live (local_channel_id is unique).
      -- latest_message_id comes from this probe instead of the view's join on seq. That
      -- relies on messages.seq being unique, which holds only because every row takes
      -- nextval('messages_seq_seq'): there is NO unique constraint on seq.
      SELECT t.target_id, t.storage_id, lt.seq AS latest_seq, lt.id AS latest_message_id,
             (lt.seq IS NULL OR t.plan <> 'free' OR l.latest_at > NOW() - INTERVAL '30 days') AS eligible
      FROM (
        SELECT c.id AS target_id, COALESCE(sv.plan, 'free') AS plan,
               CASE WHEN p.local_channel_id IS NOT NULL THEN p.canonical_channel_id
                    WHEN c.deleted_at IS NULL AND c.archived_at IS NULL THEN c.id END AS storage_id
        FROM cand AS k
        JOIN channels AS c ON c.id = k.target_id
        LEFT JOIN proj AS p ON p.local_channel_id = c.id
        LEFT JOIN servers AS sv ON sv.id = c.server_id
      ) AS t
      LEFT JOIN LATERAL (
        SELECT m.seq, m.id FROM messages AS m WHERE m.channel_id = t.storage_id ORDER BY m.seq DESC LIMIT 1
      ) AS lt ON TRUE
      CROSS JOIN LATERAL (
        SELECT CASE WHEN t.plan = 'free'
                    THEN (SELECT MAX(m.created_at) FROM messages AS m WHERE m.channel_id = t.storage_id) END AS latest_at
      ) AS l
    ), target_unread AS (           -- the view's unread count, for subscribed targets only
      -- A task conversation's is on the reply basis (rw_task_conversation_unread_v1):
      -- chat messages only, no lifecycle lines.
      SELECT tl.target_id,
             (SELECT COUNT(*) FROM messages AS m
              WHERE m.channel_id = tl.storage_id AND ${unreadPredicate}
                AND (m.message_type = 'chat'
                     OR NOT EXISTS (SELECT 1 FROM channels AS tc WHERE tc.id = tl.target_id AND tc.type = 'task'))) AS unread
      FROM target_latest AS tl
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = tl.target_id
      WHERE tl.eligible
        AND tl.target_id IN (SELECT target_id FROM subs UNION ALL SELECT target_id FROM muted_subs)
    ), normal AS (                  -- rw_inbox_normal_v5
      SELECT s.kind, s.target_id, s.server_id, s.done_at,
             MAX(g.latest_seq) AS latest_seq,
             CAST(SUM(COALESCE(tu.unread, 0)) AS BIGINT) AS unread_count
      FROM subs AS s
      JOIN target_latest AS g ON g.target_id = s.target_id AND g.eligible
      LEFT JOIN target_unread AS tu ON tu.target_id = s.target_id
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = s.target_id
      GROUP BY s.kind, s.target_id, s.server_id, s.done_at, rc.last_read_seq
    ), muted_full AS (              -- rw_inbox_muted_full_v1
      SELECT s.kind, s.target_id, s.server_id, s.done_at,
             MAX(g.latest_seq) AS latest_seq,
             CAST(SUM(COALESCE(tu.unread, 0)) AS BIGINT) AS unread_count
      FROM muted_subs AS s
      JOIN target_latest AS g ON g.target_id = s.target_id AND g.eligible
      LEFT JOIN target_unread AS tu ON tu.target_id = s.target_id
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = s.target_id
      GROUP BY s.kind, s.target_id, s.server_id, s.done_at, rc.last_read_seq
    ), thread_parent AS (           -- rw_conversation_parent_v1 (rw_thread_parent_v3 + task conversations), for candidates
      SELECT c.id AS thread_channel_id, m.channel_id AS parent_channel_id
      FROM channels AS c
      JOIN messages AS m ON m.id = c.parent_message_id
      JOIN channels AS pc ON pc.id = m.channel_id
      LEFT JOIN proj AS px ON px.local_channel_id = c.id
      WHERE c.type = 'thread' AND px.local_channel_id IS NULL AND c.id IN (SELECT target_id FROM cand)
      UNION ALL
      SELECT lt.id, COALESCE(pl.local_channel_id, m.channel_id)
      FROM channels AS lt
      JOIN proj AS p ON p.local_channel_id = lt.id
      JOIN channels AS ct ON ct.id = p.canonical_channel_id
      JOIN messages AS m ON m.id = ct.parent_message_id
      LEFT JOIN proj AS pl ON pl.canonical_channel_id = m.channel_id AND pl.server_id = lt.server_id
      JOIN channels AS pc2 ON pc2.id = COALESCE(pl.local_channel_id, m.channel_id)
      WHERE lt.type = 'thread' AND lt.id IN (SELECT target_id FROM cand)
      UNION ALL
      SELECT tc.id, tc.parent_channel_id
      FROM channels AS tc
      JOIN channels AS tpc ON tpc.id = tc.parent_channel_id
      WHERE tc.type = 'task' AND tc.id IN (SELECT target_id FROM cand)
    ), mention_vis AS (             -- rw_inbox_mention_v7's per-target joins, evaluated once per target
      -- channel_humans (channel_id, user_id) and thread_follows (thread, type, follower)
      -- are unique, so each EXISTS stands for the view's 0-or-1-row LEFT JOIN.
      SELECT map.storage_id, map.target_id, map.projected, c.type, c.server_id,
             EXISTS (SELECT 1 FROM channel_humans AS visu
                     WHERE visu.channel_id = map.target_id AND visu.user_id = ${user}) AS member,
             (tp.parent_channel_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM channel_humans AS pvisu
               WHERE pvisu.channel_id = tp.parent_channel_id AND pvisu.user_id = ${user})) AS parent_member,
             EXISTS (SELECT 1 FROM thread_follows AS mf
                     WHERE mf.thread_channel_id = map.target_id AND mf.follower_type = 'user'
                       AND mf.follower_id = ${user} AND mf.unfollowed_at IS NULL) AS following
      FROM mention_map AS map
      JOIN target_latest AS g ON g.target_id = map.target_id AND g.eligible
      JOIN channels AS c ON c.id = map.target_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
      LEFT JOIN thread_parent AS tp ON tp.thread_channel_id = map.target_id
      WHERE c.server_id::text = ANY(${servers})
    ), mention AS (                 -- rw_inbox_mention_v7 (user arm)
      SELECT CASE WHEN v.type IN ('thread', 'task') THEN 'thread' WHEN v.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
             v.target_id, v.server_id,
             COUNT(*) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0) AND mm.notifies) AS mention_unread,
             COUNT(*) AS total_mentions
      FROM mention_storage AS mm
      JOIN mention_vis AS v ON v.storage_id = mm.storage_id
      LEFT JOIN receiver_cursors AS rc ON rc.channel_id = v.target_id
      WHERE (v.type NOT IN ('thread', 'task') AND v.member)
         OR (v.type IN ('thread', 'task') AND (v.parent_member OR v.following))
         -- (target, channel_id, message_seq) is one mention row: seq identifies the
         -- message and (message_id, target_type, target_id) is unique.
         OR (NOT v.projected AND EXISTS (
               SELECT 1 FROM message_mentions AS nm
               WHERE nm.target_type = 'user' AND nm.target_id = ${user}
                 AND nm.channel_id = mm.channel_id AND nm.message_seq = mm.message_seq
                 AND nm.notified_at IS NOT NULL))
      GROUP BY 1, 2, 3
    ), n AS (
      SELECT kind, target_id, server_id, done_at, latest_seq, unread_count FROM normal
      UNION ALL
      SELECT kind, target_id, server_id, done_at, latest_seq, unread_count FROM muted_full
    ), u AS (
      SELECT COALESCE(n.kind, mn.kind) AS kind,
             COALESCE(n.target_id, mn.target_id) AS target_id,
             COALESCE(n.server_id, mn.server_id) AS server_id,
             (n.target_id IS NOT NULL) AS subscribed,
             n.done_at,
             n.latest_seq,
             COALESCE(n.unread_count, 0) AS unread_count,
             COALESCE(mn.mention_unread, 0) AS mention_unread,
             COALESCE(mn.total_mentions, 0) AS total_mentions
      FROM n
      FULL JOIN mention AS mn ON mn.target_id = n.target_id
    )
    SELECT u.server_id::text AS server_id, u.target_id::text AS target_id,
           CASE WHEN u.kind = 'thread' AND uc_target.type = 'task' THEN 'task' ELSE u.kind END AS kind,
           u.subscribed,
           u.unread_count, u.mention_unread, u.total_mentions,
           COALESCE(u.latest_seq, tl.latest_seq)::text AS latest_seq,
           tl.latest_message_id::text AS latest_message_id,
           (uc.user_id IS NOT NULL) AS cursor_present,
           CAST(uc.last_read_seq AS BIGINT)::text AS last_read_seq,
           uc.read_state_version
    FROM u
    LEFT JOIN channels AS uc_target ON uc_target.id = u.target_id
    LEFT JOIN target_latest AS tl ON tl.target_id = u.target_id
    LEFT JOIN user_channel_read_cursors AS uc ON uc.user_id = ${user} AND uc.channel_id = u.target_id
    LEFT JOIN thread_parent AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
    LEFT JOIN channels AS pc ON pc.id = tp.parent_channel_id
    LEFT JOIN channel_humans AS pch ON pch.channel_id = tp.parent_channel_id AND pch.user_id = ${user}
    WHERE u.server_id::text = ANY(${servers})
      AND (u.kind <> 'thread'
        OR (u.subscribed AND u.done_at IS NULL
            AND pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
            AND (pc.type = 'channel' OR pch.user_id IS NOT NULL)))
  `);
  return mapRows((result as unknown as { rows: Record<string, unknown>[] }).rows, false);
}

/** The reader's request-time public arm: non-joined public channels with something past the cursor. */
async function referencePublicHasNewRows(userId: string, serverId: string): Promise<ConversationUnreadRow[]> {
  if (!CANONICAL_UUID.test(userId) || !CANONICAL_UUID.test(serverId)) return [];
  const user = sql`${userId}::uuid`;
  const result = await getDb().execute(sql`
    WITH proj AS (
      SELECT s.local_channel_id, j.canonical_channel_id
      FROM joint_channel_servers AS s
      JOIN joint_channels AS j ON j.id = s.joint_channel_id
      WHERE s.status = 'active' AND j.status = 'active'
    ), candidate AS (               -- live non-joined public channels, with their chan_map storage
      SELECT c.id, c.server_id, COALESCE(sv.plan, 'free') AS plan,
             COALESCE(p.canonical_channel_id, c.id) AS storage_id
      FROM channels AS c
      LEFT JOIN servers AS sv ON sv.id = c.server_id
      LEFT JOIN channel_humans AS ch ON ch.channel_id = c.id AND ch.user_id = ${user}
      LEFT JOIN proj AS p ON p.local_channel_id = c.id
      WHERE c.server_id = ${serverId}::uuid
        AND c.type = 'channel'
        AND c.deleted_at IS NULL
        AND c.archived_at IS NULL
        AND ch.user_id IS NULL
    ), target_latest AS (           -- rw_target_latest_v4, per candidate
      SELECT cd.*,
             (SELECT m.seq FROM messages AS m WHERE m.channel_id = cd.storage_id ORDER BY m.seq DESC LIMIT 1) AS latest_seq,
             CASE WHEN cd.plan = 'free'
                  THEN (SELECT MAX(m.created_at) FROM messages AS m WHERE m.channel_id = cd.storage_id) END AS latest_at
      FROM candidate AS cd
    )
    SELECT tl.server_id::text AS server_id, tl.id::text AS target_id, 'channel' AS kind, FALSE AS subscribed,
           0 AS unread_count, 0 AS mention_unread, 0 AS total_mentions,
           tl.latest_seq::text AS latest_seq, NULL AS latest_message_id,
           (uc.user_id IS NOT NULL) AS cursor_present,
           CAST(uc.last_read_seq AS BIGINT)::text AS last_read_seq,
           uc.read_state_version
    FROM target_latest AS tl
    LEFT JOIN user_channel_read_cursors AS uc ON uc.channel_id = tl.id AND uc.user_id = ${user}
    WHERE tl.latest_seq IS NOT NULL
      -- rw_target_eligible_v1 (a target with messages)
      AND (tl.plan <> 'free' OR tl.latest_at > NOW() - INTERVAL '30 days')
      AND tl.latest_seq > COALESCE(CAST(uc.last_read_seq AS BIGINT), 0)
  `);
  return mapRows((result as unknown as { rows: Record<string, unknown>[] }).rows, true);
}

function mapRows(rows: Record<string, unknown>[], hasNew: boolean): ConversationUnreadRow[] {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return rows.map((row) => ({
    serverId: String(row.server_id),
    targetId: String(row.target_id),
    kind: row.kind as ConversationUnreadRow["kind"],
    subscribed: row.subscribed === true,
    unreadCount: Number(row.unread_count),
    mentionUnread: Number(row.mention_unread),
    totalMentions: Number(row.total_mentions),
    hasNew,
    latestSeq: text(row.latest_seq),
    latestMessageId: text(row.latest_message_id),
    cursorPresent: row.cursor_present === true,
    lastReadSeq: text(row.last_read_seq),
    readStateVersion: row.read_state_version === null || row.read_state_version === undefined
      ? null
      : Number(row.read_state_version),
  }));
}

/** The reader's queries, answered from the reference rows. */
export const referenceConversationUnreadSource: ConversationUnreadSource = {
  async summaryRows({ serverId, userId, includePublicNew }: ConversationUnreadSummaryQuery) {
    const rows = (await referenceConversationUnreadViewRows(userId, [serverId]))
      .filter((row) => row.unreadCount > 0 || row.totalMentions > 0);
    return includePublicNew ? [...rows, ...await referencePublicHasNewRows(userId, serverId)] : rows;
  },
  async sidebarTotals({ serverIds, userId }: SidebarUnreadTotalsQuery) {
    const totals = new Map<string, number>();
    for (const row of await referenceConversationUnreadViewRows(userId, serverIds)) {
      if (!row.subscribed || row.kind === "thread" || row.kind === "task" || row.unreadCount <= 0) continue;
      totals.set(row.serverId, (totals.get(row.serverId) ?? 0) + row.unreadCount);
    }
    return [...totals].map(([serverId, unreadCount]) => ({ serverId, unreadCount }));
  },
};
