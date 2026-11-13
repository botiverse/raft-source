-- 078: task conversations are sub-conversations of the inbox chain.
--
-- Task v2 gives a task its own conversation: a channels row with
-- type = 'task', task_id = the task, parent_channel_id = the channel that holds
-- the task (on a joint channel: one canonical conversation on the storage
-- channel plus one local conversation per participating server, linked through
-- joint_channels / joint_channel_servers exactly like a joint thread). Its
-- replies are ordinary messages; follows are thread_follows rows
-- (thread_channel_id = the follower's local conversation, parent_message_id
-- NULL, parent_task_id = the task); Done/suppression uses the thread kinds
-- (followed_thread / public_thread_mention). There is no parent message.
--
-- Before 078 the chain special-cased threads (type = 'thread') wherever a
-- conversation is reached through a parent: a task conversation's follow made
-- a subscription row (rw_subs_v2 does not look at the type) but
--   - rw_thread_parent_v3 needs a parent message, so it had no parent: the
--     items/serving/agent inbox/sidebar parent conditions dropped it, the
--     watermark never counted it;
--   - rw_inbox_mention_v6 classified it as a 'channel' and required a direct
--     membership of the conversation (none exists), so a mention inside it was
--     lost unless notified.
-- So Activity, the agent inbox and the sidebar never showed a task
-- conversation.
--
-- 078 treats type IN ('thread', 'task') as a sub-conversation everywhere:
--   rw_conversation_parent_v1   NEW. rw_thread_parent_v3 plus one row per task
--                               conversation: its parent channel straight from
--                               channels.parent_channel_id (the LOCAL parent on
--                               every face, so no joint mapping is needed), no
--                               parent message, and its task_id.
--   rw_task_conversation_replies_v1
--                               NEW. Per task conversation target, its replies:
--                               chat messages only (lifecycle lines are system
--                               messages and do not count), as the task row's
--                               reply count (taskService) counts them.
--   rw_inbox_mention_v7         <- 067 rw_inbox_mention_v6: a task conversation is
--                               kind 'thread' and visible through its parent
--                               channel or a follow, like a thread.
--                               mention_unread / max_mention_seq count only a
--                               mention that notifies (notifiable_at_send, or
--                               notified_at set later), as Postgres has_mention
--                               does (v6 counted every visible mention; through
--                               them items' present, totals, the agent inbox and
--                               conversation unread follow). total_mentions is
--                               unchanged. New first_mention_message_id: the
--                               lowest-seq such mention after the read cursor
--                               (the member row's anchor).
--   rw_activity_watermark_v7    <- 077 rw_activity_watermark_v6 (followed task
--                               conversations are structural targets).
--   rw_task_conversation_unread_v1
--                               NEW. Per (receiver, followed task conversation),
--                               its unread on the reply basis: chat messages
--                               after the read cursor, not the receiver's own.
--                               Lifecycle lines (system messages) are not "new",
--                               as they are not replies; a mention on one (the
--                               assignment notice) still reaches its target
--                               through the mention arm (has_mention).
--   rw_inbox_items_v13          <- 076 rw_inbox_items_v11 + 077 rw_inbox_items_v12
--                               folded into one view, on mention v7 and the
--                               conversation parent. Passes through
--                               first_mention_message_id and exposes the mention
--                               suppression position present already joins (sm)
--                               as mention_done_through_seq; present unchanged.
--   rw_inbox_preview_need_v1    NEW. The message seqs the inbox views show a
--                               preview of: each items row's latest, first
--                               unread and latest mention seq, each followed
--                               task conversation's first unread seq, each
--                               target's latest seq, and the arms' latest seq.
--   rw_inbox_preview_seq_v1     NEW. rw_message_preview_v1 for those seqs only.
--   rw_inbox_preview_parent_v1  NEW. rw_message_preview_v1 for the parent
--                               messages of rw_conversation_parent_v1 only.
--                               serving and conversation unread join these two
--                               instead of rw_message_preview_v1 (the whole
--                               message table): a backfill then scans the
--                               message table once per small view instead of
--                               once per preview join (serving had five), and
--                               the join state holds a few million rows, not
--                               every message. Every seq or id they look up is
--                               in the small view by construction, so the
--                               output is the same.
--   rw_inbox_serving_v9         <- 077 rw_inbox_serving_v8: a task conversation row
--                               has kind = 'task'; its parent_channel_* is the
--                               task's channel; task_number / task_status /
--                               task_claimed_by_* come from its task (rw_tasks);
--                               its reply_count is its chat messages
--                               (rw_task_conversation_replies_v1), a thread's
--                               stays every message; its unread_count and
--                               first_unread_message_id are on the same basis
--                               (rw_task_conversation_unread_v1);
--                               a thread row's task comes from rw_tasks by the
--                               parent message (as the Postgres read and
--                               074 do), not from the parent message's legacy
--                               columns. Display times (last_message_at,
--                               last_activity_at, last_reply_at, activity_at) are
--                               the highest-seq message's created_at (lm, the
--                               row the preview and last_message_id come from),
--                               not MAX(created_at): an imported or bridged
--                               message with an old timestamp made them
--                               disagree. present and the WHERE are unchanged.
--                               New columns first_mention_message_id (NULL on a
--                               mention_only row: an outsider's anchor ignores the
--                               read cursor and respects done_through_seq, so the
--                               server resolves it for the page) and
--                               mention_done_through_seq.
--   rw_activity_totals_v7       <- 077 rw_activity_totals_v6 (kind 'task' counts).
--   rw_agent_inbox_v7           <- 076 rw_agent_inbox_v6 (kind 'task' rows).
--   rw_conversation_unread_v4   <- 076 rw_conversation_unread_v3 (kind 'task' rows,
--                               whose unread_count is rw_task_conversation_unread_v1's).
--                               Its muted arm is 066's rw_inbox_muted_full_v1, not
--                               075's rw_inbox_muted_full_v2 (same columns and
--                               semantics), so it builds where only v1 exists.
-- Inside the chain a task conversation keeps the internal kind 'thread' (the
-- arms, the mention arm, items, and the suppression target kinds key on it);
-- only the reader-facing views (serving, agent inbox, conversation unread)
-- output 'task', from rw_channels.type.
--
-- Unchanged and shared with the previous generation: rw_message_target_v3,
-- rw_target_latest_v4, rw_target_eligible_v1, rw_subs_v2, rw_muted_subs_v1,
-- rw_receiver_cursors_v1, rw_thread_parent_v3, rw_message_preview_v1, 075's
-- arms rw_inbox_normal_v5 and rw_inbox_muted_prefix_v2, 066's
-- rw_inbox_muted_full_v1 (075's rw_inbox_muted_full_v2 is not read by 078)
-- and 074's rw_followed_threads_v5 (threads only: the followed-threads list
-- reads its task conversations from Postgres, a small per-user read, so the
-- large followed-threads view is not rebuilt). None of them tests the
-- conversation type, except the membership arms of
-- rw_subs_v2 / rw_muted_subs_v1, `type <> 'thread'`: a task conversation has
-- no channel_humans / channel_agents rows, so they emit nothing for it.
--
-- Output columns of totals, agent inbox and conversation unread are unchanged,
-- and serving only adds first_mention_message_id / mention_done_through_seq, so
-- the server switch is a rename (with the previous generation as the transition
-- fallback, where task conversations are simply absent and the server reads the
-- two new serving columns as NULL). The
-- task's id and title are not columns: the server reads them for the page from
-- Postgres by the conversation id.
--
-- CDC prerequisite (the local bootstrap creates it): rw_channels carries
-- parent_channel_id and task_id, and rw_message_mentions_v2 carries message_id
-- (a CDC table declared with (*) has every upstream column). On a cluster whose rw_channels predates them,
-- add them first (ALTER TABLE rw_channels ADD COLUMN parent_channel_id
-- CHARACTER VARYING; ALTER TABLE rw_channels ADD COLUMN task_id CHARACTER
-- VARYING) and let CDC fill them. rw_tasks (074's prerequisite) is unchanged.
--
-- Apply after 063-unified-inbox-chain (rw_message_target_v3, rw_target_latest_v4,
-- rw_target_eligible_v1, rw_subs_v2, rw_receiver_cursors_v1), 063-chain-v5
-- (rw_muted_subs_v1), 066 (rw_inbox_muted_full_v1), 075 (the other arms) and
-- 061 (rw_thread_parent_v3, rw_message_preview_v1). Build order and names: README.
--
-- Retirement (RFC 062 rule 4): once 078 is built in every environment and
-- traces show no inbox.rw.unified_chain_view_fallback naming a 078 view, drop
-- the previous generation leaf-first, never CASCADE, with SHOW CREATE receipts:
-- rw_activity_totals_v6, rw_inbox_serving_v8 (and its index), rw_inbox_items_v12,
-- rw_inbox_items_v11, rw_activity_watermark_v6, rw_agent_inbox_v6 (and its
-- index), rw_conversation_unread_v3 (and its index), rw_inbox_mention_v6; in
-- the same change remove them from the server's transition list. Keep 075's
-- rw_inbox_normal_v5 / rw_inbox_muted_prefix_v2 and 066's rw_inbox_muted_full_v1
-- (do not drop it with the 066/068 leftovers): 078 reads them. 075's
-- rw_inbox_muted_full_v2 is no longer read by this chain. Who: the RisingWave
-- inbox DRI, through the DDL window process (docs/operations); when: within two
-- release cycles of 078 serving every environment.

-- One row per sub-conversation with its LOCAL parent channel. A materialized
-- view (not a plain view): six views below look it up, and each would otherwise
-- hold its own join state over rw_channels.
CREATE MATERIALIZED VIEW rw_conversation_parent_v1 AS
SELECT tp.thread_channel_id, tp.parent_message_id, tp.parent_channel_id,
       tp.parent_channel_name, tp.parent_channel_type,
       CAST(NULL AS CHARACTER VARYING) AS task_id
FROM rw_thread_parent_v3 AS tp
UNION ALL
SELECT c.id AS thread_channel_id, CAST(NULL AS CHARACTER VARYING) AS parent_message_id,
       c.parent_channel_id, pc.name AS parent_channel_name, pc.type AS parent_channel_type,
       c.task_id
FROM rw_channels AS c
JOIN rw_channels AS pc ON pc.id = c.parent_channel_id
WHERE c.type = 'task';

-- A task conversation's reply count: its chat messages (people and agents), not
-- its lifecycle lines (system messages), on every target (a joint projection
-- counts the canonical conversation's messages, like rw_target_latest_v4).
CREATE MATERIALIZED VIEW rw_task_conversation_replies_v1 AS
SELECT m.target_id, COUNT(*) FILTER (WHERE m.message_type = 'chat') AS reply_count
FROM rw_message_target_v3 AS m
JOIN rw_channels AS c ON c.id = m.target_id AND c.type = 'task'
GROUP BY m.target_id;

-- A task conversation's unread on the reply basis, per follower: its chat
-- messages after the follower's read cursor, not the follower's own. The arms'
-- unread_count (rw_inbox_normal_v5) also counts lifecycle lines, which made a
-- row read "1 reply, 3 new". The arm stays as it is: the agent inbox and the
-- presence/latest columns read it. Same shape as the arm (075: the cursor is a
-- join condition), restricted to task conversations up front; a task
-- conversation's subscriptions are all follows (rw_subs_v2's thread arms; no
-- membership or mute rows exist for one).
CREATE MATERIALIZED VIEW rw_task_conversation_unread_v1 AS
SELECT s.receiver_type, s.receiver_id, s.target_id,
       COUNT(u.seq) FILTER (WHERE u.message_type = 'chat'
         AND NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)) AS unread_count,
       MIN(u.seq) FILTER (WHERE u.message_type = 'chat'
         AND NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)) AS first_unread_seq
FROM rw_subs_v2 AS s
JOIN rw_channels AS c ON c.id = s.target_id AND c.type = 'task'
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
LEFT JOIN rw_message_target_v3 AS u
  ON u.target_id = s.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
GROUP BY s.receiver_type, s.receiver_id, s.target_id, rc.last_read_seq;

-- mention_unread / max_mention_seq / first_mention_message_id count only a
-- mention that notifies (notifiable at send, or notified later), as the
-- Postgres has_mention read does. total_mentions (has_any_mention) still counts
-- every visible mention.
CREATE MATERIALIZED VIEW rw_inbox_mention_v7 AS
WITH proj AS (
  SELECT s.local_channel_id, s.server_id, j.canonical_channel_id
  FROM rw_joint_channel_servers AS s
  JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id
  WHERE s.status = 'active' AND j.status = 'active'
), chan_map AS (
  SELECT c.id AS storage_id, c.id AS target_id, FALSE AS projected
  FROM rw_channels AS c
  LEFT JOIN proj AS p ON p.local_channel_id = c.id
  WHERE c.deleted_at IS NULL AND c.archived_at IS NULL AND p.local_channel_id IS NULL
  UNION ALL
  SELECT p.canonical_channel_id, p.local_channel_id, TRUE FROM proj AS p
), mm AS (
  SELECT m.*, COALESCE(pj.canonical_channel_id, m.channel_id) AS storage_id
  FROM rw_message_mentions_v2 AS m
  LEFT JOIN proj AS pj ON pj.local_channel_id = m.channel_id
)
SELECT CASE WHEN c.type IN ('thread', 'task') THEN 'thread' WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       mm.target_type AS receiver_type, CAST(mm.target_id AS VARCHAR) AS receiver_id,
       map.target_id AS target_id, c.server_id,
       COUNT(*) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
         AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)) AS mention_unread,
       MAX(mm.message_seq) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
         AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)) AS max_mention_seq,
       COUNT(*) AS total_mentions,
       CAST(first_value(mm.message_id ORDER BY mm.message_seq) FILTER (WHERE mm.message_seq > COALESCE(rc.last_read_seq, 0)
         AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)) AS VARCHAR) AS first_mention_message_id
FROM mm
JOIN chan_map AS map ON map.storage_id = mm.storage_id
JOIN rw_target_eligible_v1 AS g ON g.target_id = map.target_id
JOIN rw_channels AS c ON c.id = map.target_id AND c.deleted_at IS NULL AND c.archived_at IS NULL
LEFT JOIN rw_channel_humans AS visu ON visu.channel_id = map.target_id AND mm.target_type = 'user' AND CAST(visu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS visa ON visa.channel_id = map.target_id AND mm.target_type = 'agent' AND CAST(visa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = map.target_id
LEFT JOIN rw_channel_humans AS pvisu ON pvisu.channel_id = tp.parent_channel_id AND mm.target_type = 'user' AND CAST(pvisu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS pvisa ON pvisa.channel_id = tp.parent_channel_id AND mm.target_type = 'agent' AND CAST(pvisa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_thread_follows AS mf ON mf.thread_channel_id = map.target_id AND mf.follower_type = mm.target_type AND CAST(mf.follower_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR) AND mf.unfollowed_at IS NULL
LEFT JOIN rw_receiver_cursors_v1 AS rc ON rc.receiver_type = mm.target_type AND rc.receiver_id = CAST(mm.target_id AS VARCHAR) AND rc.channel_id = map.target_id
WHERE (c.type NOT IN ('thread', 'task') AND (visu.user_id IS NOT NULL OR visa.agent_id IS NOT NULL))
   OR (c.type IN ('thread', 'task') AND (pvisu.user_id IS NOT NULL OR pvisa.agent_id IS NOT NULL OR mf.follower_id IS NOT NULL))
   OR (mm.notified_at IS NOT NULL AND NOT map.projected)
GROUP BY 1, 2, 3, 4, 5;

CREATE MATERIALIZED VIEW rw_activity_watermark_v7 AS
WITH structural AS (
  SELECT 'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id, c.id AS target_id, c.server_id
  FROM rw_channel_humans AS ch
  JOIN rw_channels AS c ON ch.channel_id = c.id AND c.type NOT IN ('thread', 'task') AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT 'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id
  FROM rw_channel_agents AS ca
  JOIN rw_channels AS c ON ca.channel_id = c.id AND c.type NOT IN ('thread', 'task') AND c.deleted_at IS NULL AND c.archived_at IS NULL
  UNION ALL
  SELECT tf.follower_type, CAST(tf.follower_id AS VARCHAR), c.id, c.server_id
  FROM rw_thread_follows AS tf
  JOIN rw_channels AS c ON tf.thread_channel_id = c.id AND c.deleted_at IS NULL AND c.archived_at IS NULL
  JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = c.id
  JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
  LEFT JOIN rw_channel_humans AS pch
    ON tf.follower_type = 'user' AND pch.channel_id = tp.parent_channel_id AND pch.user_id = tf.follower_id
  LEFT JOIN rw_channel_agents AS pca
    ON tf.follower_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND pca.agent_id = tf.follower_id
  WHERE tf.unfollowed_at IS NULL
    AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL)
), ranked AS (
  SELECT s.receiver_type, s.receiver_id, s.server_id, tl.latest_seq,
         ROW_NUMBER() OVER (PARTITION BY s.receiver_type, s.receiver_id, s.server_id ORDER BY tl.latest_seq DESC) AS rk
  FROM structural AS s
  JOIN rw_target_latest_v4 AS tl ON tl.target_id = s.target_id
)
SELECT receiver_type, receiver_id, server_id, MIN(latest_seq) AS watermark_seq
FROM ranked WHERE rk <= 500
GROUP BY receiver_type, receiver_id, server_id
HAVING COUNT(*) >= 500;

-- 076's items on mention v7, with 077's parent condition on sub-conversation
-- rows in the same view (077 layered it as items_v12 over items_v11 only to
-- avoid rebuilding items; the mention arm changes here anyway).
CREATE MATERIALIZED VIEW rw_inbox_items_v13 AS
WITH n AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_normal_v5
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_muted_prefix_v2
), sup AS (
  SELECT receiver_type, receiver_id, target_kind, target_channel_id, MAX(done_through_seq) AS done_through_seq, MAX(done_at) AS sup_done_at
  FROM rw_inbox_suppression_states GROUP BY 1, 2, 3, 4
), b AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind, COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type, COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id, COALESCE(n.target_id, mn.target_id) AS target_id, COALESCE(n.server_id, mn.server_id) AS server_id, n.unread_count, n.first_unread_seq, n.latest_seq, n.latest_at, n.last_read AS last_read_seq, COALESCE(mn.mention_unread, 0) AS mention_unread, mn.max_mention_seq, COALESCE(mn.total_mentions, 0) AS total_mentions, mn.first_mention_message_id, sm.done_through_seq AS mention_done_through_seq, ((n.receiver_id IS NOT NULL AND n.latest_seq IS NOT NULL AND (n.done_at IS NULL OR n.latest_at > n.done_at) AND (n.joined_at IS NULL OR n.latest_at > n.joined_at) AND (sn.receiver_id IS NULL OR (sn.done_through_seq IS NOT NULL AND n.latest_seq > sn.done_through_seq) OR (sn.done_through_seq IS NULL AND n.latest_at > sn.sup_done_at))) OR (COALESCE(mn.mention_unread, 0) > 0 AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)) AND (sm.receiver_id IS NULL OR (sm.done_through_seq IS NOT NULL AND mn.max_mention_seq > sm.done_through_seq)))) AS present
  FROM n
  FULL JOIN rw_inbox_mention_v7 AS mn ON n.kind = mn.kind AND n.receiver_type = mn.receiver_type AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id
  LEFT JOIN sup AS sn ON sn.receiver_type = n.receiver_type AND sn.receiver_id = n.receiver_id AND sn.target_channel_id = n.target_id AND sn.target_kind = CASE n.kind WHEN 'thread' THEN 'followed_thread' WHEN 'dm' THEN 'dm' ELSE 'channel' END
  LEFT JOIN sup AS sm ON sm.receiver_type = mn.receiver_type AND sm.receiver_id = mn.receiver_id AND sm.target_channel_id = mn.target_id AND sm.target_kind = CASE mn.kind WHEN 'thread' THEN 'public_thread_mention' WHEN 'dm' THEN 'dm' ELSE 'public_channel_mention' END
)
SELECT b.* FROM b
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = b.target_id AND b.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_channel_humans AS pch
  ON b.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = b.receiver_id
LEFT JOIN rw_channel_agents AS pca
  ON b.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = b.receiver_id
WHERE b.kind <> 'thread'
   OR (pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
       AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL));

-- The previews the inbox shows, cut down from rw_message_preview_v1 (every
-- message) to the rows serving and conversation unread look up. The seq list
-- must cover every preview join by seq in those two views: lm (latest_seq of
-- items, of the arms, or of rw_target_latest_v4), fu (items first_unread_seq),
-- tfu (task conversation first_unread_seq) and ma (items max_mention_seq). A
-- new join by seq adds its column here.
CREATE MATERIALIZED VIEW rw_inbox_preview_need_v1 AS
SELECT seq FROM (
  SELECT latest_seq AS seq FROM rw_inbox_items_v13
  UNION ALL SELECT first_unread_seq AS seq FROM rw_inbox_items_v13
  UNION ALL SELECT max_mention_seq AS seq FROM rw_inbox_items_v13
  UNION ALL SELECT first_unread_seq AS seq FROM rw_task_conversation_unread_v1
  UNION ALL SELECT latest_seq AS seq FROM rw_target_latest_v4
  UNION ALL SELECT latest_seq AS seq FROM rw_inbox_normal_v5
  UNION ALL SELECT latest_seq AS seq FROM rw_inbox_muted_full_v1
) AS s
WHERE seq IS NOT NULL
GROUP BY seq;

CREATE MATERIALIZED VIEW rw_inbox_preview_seq_v1 AS
SELECT pv.seq, pv.id, pv.preview, pv.sender_type, pv.sender_id, pv.created_at
FROM rw_inbox_preview_need_v1 AS n
JOIN rw_message_preview_v1 AS pv ON pv.seq = n.seq;

-- The parent message previews (pm in serving), by id.
CREATE MATERIALIZED VIEW rw_inbox_preview_parent_v1 AS
SELECT pv.id, pv.seq, pv.preview, pv.sender_type, pv.sender_id, pv.created_at
FROM (
  SELECT parent_message_id FROM rw_conversation_parent_v1
  WHERE parent_message_id IS NOT NULL
  GROUP BY parent_message_id
) AS n
JOIN rw_message_preview_v1 AS pv ON pv.id = n.parent_message_id;

-- Beyond the upstream names: kind is 'task' for a task conversation (c.type),
-- whose reply_count is its chat messages (rw_task_conversation_replies_v1)
-- and whose unread_count / first_unread_message_id are on the same basis
-- (rw_task_conversation_unread_v1; mention_only and has_mention stay the arms').
-- the task columns come from the task itself, a task conversation's by
-- rw_conversation_parent_v1.task_id, a thread's by its parent message
-- (tasks.message_id is unique), as in the canonical Postgres read and
-- rw_followed_threads_v5, instead of the parent message's legacy task columns.
CREATE MATERIALIZED VIEW rw_inbox_serving_v9 AS SELECT p.server_id, p.receiver_type, p.receiver_id, CASE WHEN p.kind = 'thread' AND c.type = 'task' THEN 'task' ELSE p.kind END AS kind, CASE WHEN p.kind = 'thread' THEN NULL ELSE p.target_id END AS channel_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.name END AS channel_name, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.type END AS channel_type, lm.id AS last_message_id, CASE WHEN c.type = 'task' THEN tfu.id ELSE fu.id END AS first_unread_message_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE COALESCE(lm.created_at, p.latest_at) END AS last_message_at, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.preview END AS last_message_preview, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_type END AS last_message_sender_type, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_id END AS last_message_sender_id, CAST(COALESCE(CASE WHEN c.type = 'task' THEN tu.unread_count ELSE p.unread_count END, 0) AS INT) AS unread_count, CASE WHEN p.kind = 'thread' THEN p.target_id ELSE NULL END AS thread_channel_id, tp.parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type, pm.preview AS parent_message_preview, pm.sender_type AS parent_message_sender_type, pm.sender_id AS parent_message_sender_id, COALESCE(lm.preview, ma.preview) AS latest_activity_preview, COALESCE(lm.sender_type, ma.sender_type) AS latest_activity_sender_type, COALESCE(lm.sender_id, ma.sender_id) AS latest_activity_sender_id, COALESCE(lm.id, ma.id) AS latest_activity_message_id, COALESCE(lm.seq, ma.seq) AS latest_activity_seq, COALESCE(lm.created_at, p.latest_at) AS last_activity_at, CASE WHEN p.kind = 'thread' THEN COALESCE(lm.created_at, p.latest_at) ELSE NULL END AS last_reply_at, CASE WHEN p.kind = 'thread' THEN CASE WHEN c.type = 'task' THEN CAST(COALESCE(tr.reply_count, 0) AS INT) ELSE CAST(tl.msg_count AS INT) END ELSE NULL END AS reply_count, COALESCE(ctk.task_number, tk.task_number) AS task_number, COALESCE(ctk.status, tk.status) AS task_status, COALESCE(ctk.claimed_by_type, tk.claimed_by_type) AS task_claimed_by_type, COALESCE(ctk.claimed_by_id, tk.claimed_by_id) AS task_claimed_by_id, (p.mention_unread > 0) AS has_mention, (p.mention_unread > 0 AND p.unread_count IS NULL) AS mention_only, CAST(p.last_read_seq AS BIGINT) AS last_read_seq, COALESCE(lm.created_at, p.latest_at, ma.created_at) AS activity_at, (p.total_mentions > 0) AS has_any_mention, CASE WHEN p.mention_unread > 0 AND p.unread_count IS NULL THEN NULL ELSE p.first_mention_message_id END AS first_mention_message_id, CAST(p.mention_done_through_seq AS BIGINT) AS mention_done_through_seq FROM rw_inbox_items_v13 AS p LEFT JOIN rw_activity_watermark_v7 AS w ON w.receiver_type = p.receiver_type AND w.receiver_id = p.receiver_id AND w.server_id = p.server_id LEFT JOIN rw_channels AS c ON c.id = p.target_id LEFT JOIN rw_inbox_preview_seq_v1 AS lm ON lm.seq = p.latest_seq LEFT JOIN rw_inbox_preview_seq_v1 AS fu ON fu.seq = p.first_unread_seq LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = p.target_id AND p.kind = 'thread' LEFT JOIN rw_inbox_preview_parent_v1 AS pm ON pm.id = tp.parent_message_id LEFT JOIN rw_tasks AS tk ON tk.message_id = tp.parent_message_id LEFT JOIN rw_tasks AS ctk ON ctk.id = tp.task_id LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = p.target_id LEFT JOIN rw_task_conversation_replies_v1 AS tr ON tr.target_id = p.target_id LEFT JOIN rw_task_conversation_unread_v1 AS tu ON tu.receiver_type = p.receiver_type AND tu.receiver_id = p.receiver_id AND tu.target_id = p.target_id LEFT JOIN rw_inbox_preview_seq_v1 AS tfu ON tfu.seq = tu.first_unread_seq LEFT JOIN rw_inbox_preview_seq_v1 AS ma ON ma.seq = p.max_mention_seq WHERE p.present AND GREATEST(COALESCE(tl.latest_seq, 0), COALESCE(p.latest_seq, 0), COALESCE(p.max_mention_seq, 0)) >= COALESCE(w.watermark_seq, 0);

CREATE INDEX idx_rw_inbox_serving_v9_receiver ON rw_inbox_serving_v9(receiver_type, receiver_id, activity_at DESC);

CREATE MATERIALIZED VIEW rw_activity_totals_v7 AS WITH served AS (SELECT i.receiver_type, i.receiver_id, i.server_id, CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count FROM rw_inbox_serving_v9 AS i WHERE (i.kind IN ('thread', 'task') OR i.channel_type IN ('channel', 'private', 'joint', 'dm')) GROUP BY i.receiver_type, i.receiver_id, i.server_id), members AS (SELECT 'user' AS receiver_type, CAST(user_id AS CHARACTER VARYING) AS receiver_id, server_id FROM rw_server_members) SELECT COALESCE(m.receiver_type, s.receiver_type) AS receiver_type, COALESCE(m.receiver_id, s.receiver_id) AS receiver_id, COALESCE(m.server_id, s.server_id) AS server_id, COALESCE(s.total_unread_count, 0) AS total_unread_count FROM members AS m FULL JOIN served AS s ON s.receiver_type = m.receiver_type AND s.receiver_id = m.receiver_id AND s.server_id = m.server_id;

-- 076's agent inbox on mention v7 and the conversation parent; kind is 'task'
-- for a task conversation. A task conversation's parent_message_id is NULL
-- (COALESCE with its own channels.parent_message_id, NULL too).
CREATE MATERIALIZED VIEW rw_agent_inbox_v7 AS WITH proj AS (SELECT s.local_channel_id, j.canonical_channel_id FROM rw_joint_channel_servers AS s JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id WHERE s.status = 'active' AND j.status = 'active'), n AS (SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM rw_inbox_normal_v5 WHERE receiver_type = 'agent' UNION ALL SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM rw_inbox_muted_prefix_v2 WHERE receiver_type = 'agent'), u AS (SELECT COALESCE(n.kind, mn.kind) AS kind, COALESCE(n.receiver_id, mn.receiver_id) AS agent_id, COALESCE(n.target_id, mn.target_id) AS target_id, COALESCE(n.server_id, mn.server_id) AS server_id, COALESCE(n.unread_count, 0) AS unread_count, n.first_unread_seq, n.latest_seq, COALESCE(mn.mention_unread, 0) AS mention_unread, mn.max_mention_seq, (n.receiver_id IS NOT NULL) AS subscribed FROM n FULL JOIN (SELECT * FROM rw_inbox_mention_v7 WHERE receiver_type = 'agent') AS mn ON n.kind = mn.kind AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id WHERE (n.receiver_id IS NOT NULL AND COALESCE(n.unread_count, 0) > 0) OR (COALESCE(mn.mention_unread, 0) > 0 AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)))) SELECT u.agent_id, u.server_id, CASE WHEN u.kind = 'thread' AND c.type = 'task' THEN 'task' ELSE u.kind END AS kind, u.target_id, COALESCE(p.canonical_channel_id, u.target_id) AS storage_channel_id, c.name AS channel_name, c.type AS channel_type, COALESCE(tp.parent_message_id, c.parent_message_id) AS parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type, CAST(COALESCE(rc.last_read_seq, 0) AS BIGINT) AS last_read_seq, u.unread_count, u.first_unread_seq, u.latest_seq, u.mention_unread, u.max_mention_seq, u.subscribed, CASE WHEN u.subscribed THEN u.unread_count + CASE WHEN u.mention_unread > 0 AND u.max_mention_seq > COALESCE(u.latest_seq, 0) THEN 1 ELSE 0 END ELSE u.mention_unread END AS offered_unread, GREATEST(COALESCE(u.latest_seq, 0), COALESCE(u.max_mention_seq, 0)) AS activity_seq, CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END AS joined_at FROM u JOIN rw_channels AS c ON c.id = u.target_id AND c.deleted_at IS NULL LEFT JOIN proj AS p ON p.local_channel_id = u.target_id LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread' LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL LEFT JOIN rw_channel_agents AS pca ON pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS CHARACTER VARYING) = u.agent_id LEFT JOIN rw_receiver_cursors_v1 AS rc ON rc.receiver_type = 'agent' AND rc.receiver_id = u.agent_id AND rc.channel_id = u.target_id LEFT JOIN rw_channel_agents AS ca ON ca.channel_id = u.target_id AND CAST(ca.agent_id AS CHARACTER VARYING) = u.agent_id AND u.kind <> 'thread' LEFT JOIN rw_thread_follows AS tf ON tf.thread_channel_id = u.target_id AND tf.follower_type = 'agent' AND CAST(tf.follower_id AS CHARACTER VARYING) = u.agent_id AND tf.unfollowed_at IS NULL AND u.kind = 'thread' WHERE (CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END) IS NOT NULL AND (u.kind <> 'thread' OR (pc.id IS NOT NULL AND (pca.agent_id IS NOT NULL OR (pc.type = 'channel' AND pc.server_id = u.server_id))));

CREATE INDEX idx_rw_agent_inbox_v7_agent_activity ON rw_agent_inbox_v7(agent_id, activity_seq DESC);

-- The muted arm reads 066's rw_inbox_muted_full_v1, not 075's
-- rw_inbox_muted_full_v2: some environments no longer keep v2, and 075 gives
-- both the same output columns and semantics (only the write cost of a cursor
-- move differs). The user-only muted_full of the ordinal-based muted design
-- will replace v1 here; it must keep the same columns.
CREATE MATERIALIZED VIEW rw_conversation_unread_v4 AS
WITH subs AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_normal_v5
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_muted_full_v1
), u AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind,
         COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type,
         COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id,
         COALESCE(n.target_id, mn.target_id) AS target_id,
         COALESCE(n.server_id, mn.server_id) AS server_id,
         (n.receiver_id IS NOT NULL) AS subscribed,
         n.done_at,
         n.latest_seq,
         COALESCE(n.unread_count, 0) AS unread_count,
         COALESCE(mn.mention_unread, 0) AS mention_unread,
         COALESCE(mn.total_mentions, 0) AS total_mentions
  FROM subs AS n
  FULL JOIN rw_inbox_mention_v7 AS mn
    ON mn.receiver_type = n.receiver_type AND mn.receiver_id = n.receiver_id AND mn.target_id = n.target_id
)
SELECT u.receiver_type, u.receiver_id, u.server_id, u.target_id,
       CASE WHEN u.kind = 'thread' AND c.type = 'task' THEN 'task' ELSE u.kind END AS kind,
       u.subscribed,
       -- A task conversation's unread is on the reply basis (no lifecycle lines).
       CASE WHEN c.type = 'task' THEN COALESCE(tu.unread_count, 0) ELSE u.unread_count END AS unread_count,
       u.mention_unread, u.total_mentions,
       COALESCE(u.latest_seq, tl.latest_seq) AS latest_seq,
       lm.id AS latest_message_id,
       (COALESCE(uc.user_id, ac.agent_id) IS NOT NULL) AS cursor_present,
       COALESCE(CAST(uc.last_read_seq AS BIGINT), ac.last_read_seq8, CAST(ac.last_read_seq AS BIGINT)) AS last_read_seq,
       COALESCE(uc.read_state_version, ac.read_state_version) AS read_state_version
FROM u
LEFT JOIN rw_channels AS c ON c.id = u.target_id
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = u.target_id
LEFT JOIN rw_task_conversation_unread_v1 AS tu
  ON tu.receiver_type = u.receiver_type AND tu.receiver_id = u.receiver_id AND tu.target_id = u.target_id
LEFT JOIN rw_inbox_preview_seq_v1 AS lm ON lm.seq = COALESCE(u.latest_seq, tl.latest_seq)
LEFT JOIN rw_user_channel_read_cursors_v2 AS uc
  ON u.receiver_type = 'user' AND CAST(uc.user_id AS VARCHAR) = u.receiver_id AND uc.channel_id = u.target_id
LEFT JOIN rw_agent_channel_read_cursors AS ac
  ON u.receiver_type = 'agent' AND CAST(ac.agent_id AS VARCHAR) = u.receiver_id AND ac.channel_id = u.target_id
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_channel_humans AS pch
  ON u.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = u.receiver_id
LEFT JOIN rw_channel_agents AS pca
  ON u.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = u.receiver_id
-- A sub-conversation (thread or task conversation) has a sidebar slot only while
-- followed and not done, under a live parent the receiver can see (public, or a
-- member of private/DM/joint parent).
WHERE u.kind <> 'thread'
   OR (u.subscribed AND u.done_at IS NULL
       AND pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
       AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL));

CREATE INDEX idx_rw_conversation_unread_v4_receiver
  ON rw_conversation_unread_v4 (receiver_type, receiver_id, server_id);
