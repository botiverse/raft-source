-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_items_jcm_v1 AS
WITH n AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_normal_jcm_v1
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_muted_prefix_jcm_v1
), sup AS (
  SELECT receiver_type, receiver_id, target_kind, target_channel_id, MAX(done_through_seq) AS done_through_seq, MAX(done_at) AS sup_done_at
  FROM rw_inbox_suppression_states GROUP BY 1, 2, 3, 4
), b AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind, COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type, COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id, COALESCE(n.target_id, mn.target_id) AS target_id, COALESCE(n.server_id, mn.server_id) AS server_id, n.unread_count, n.first_unread_seq, n.latest_seq, n.latest_at, n.last_read AS last_read_seq, COALESCE(mn.mention_unread, 0) AS mention_unread, mn.max_mention_seq, COALESCE(mn.total_mentions, 0) AS total_mentions, mn.first_mention_message_id, sm.done_through_seq AS mention_done_through_seq, ((n.receiver_id IS NOT NULL AND n.latest_seq IS NOT NULL AND (n.done_at IS NULL OR n.latest_at > n.done_at) AND (n.joined_at IS NULL OR n.latest_at > n.joined_at) AND (sn.receiver_id IS NULL OR (sn.done_through_seq IS NOT NULL AND n.latest_seq > sn.done_through_seq) OR (sn.done_through_seq IS NULL AND n.latest_at > sn.sup_done_at))) OR (COALESCE(mn.mention_unread, 0) > 0 AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)) AND (sm.receiver_id IS NULL OR (sm.done_through_seq IS NOT NULL AND mn.max_mention_seq > sm.done_through_seq)))) AS present
  FROM n
  FULL JOIN rw_inbox_mention_jcm_v1 AS mn ON n.kind = mn.kind AND n.receiver_type = mn.receiver_type AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id
  LEFT JOIN sup AS sn ON sn.receiver_type = n.receiver_type AND sn.receiver_id = n.receiver_id AND sn.target_channel_id = n.target_id AND sn.target_kind = CASE n.kind WHEN 'thread' THEN 'followed_thread' WHEN 'dm' THEN 'dm' ELSE 'channel' END
  LEFT JOIN sup AS sm ON sm.receiver_type = mn.receiver_type AND sm.receiver_id = mn.receiver_id AND sm.target_channel_id = mn.target_id AND sm.target_kind = CASE mn.kind WHEN 'thread' THEN 'public_thread_mention' WHEN 'dm' THEN 'dm' ELSE 'public_channel_mention' END
)
SELECT b.* FROM b
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = b.target_id AND b.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_human_channel_members_v1 AS pch
  ON b.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = b.receiver_id
LEFT JOIN rw_channel_agents AS pca
  ON b.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = b.receiver_id
WHERE b.kind <> 'thread'
   OR (pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
       AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL));
