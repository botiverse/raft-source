-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_conversation_unread_jcm_v1 AS
WITH subs AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_normal_jcm_v1
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_muted_full_jcm_v1
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
  FULL JOIN rw_inbox_mention_jcm_v1 AS mn
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
LEFT JOIN rw_task_conversation_unread_jcm_v1 AS tu
  ON tu.receiver_type = u.receiver_type AND tu.receiver_id = u.receiver_id AND tu.target_id = u.target_id
LEFT JOIN rw_inbox_preview_seq_jcm_v1 AS lm ON lm.seq = COALESCE(u.latest_seq, tl.latest_seq)
LEFT JOIN rw_user_channel_read_cursors_v2 AS uc
  ON u.receiver_type = 'user' AND CAST(uc.user_id AS VARCHAR) = u.receiver_id AND uc.channel_id = u.target_id
LEFT JOIN rw_agent_channel_read_cursors AS ac
  ON u.receiver_type = 'agent' AND CAST(ac.agent_id AS VARCHAR) = u.receiver_id AND ac.channel_id = u.target_id
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_human_channel_members_v1 AS pch
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
