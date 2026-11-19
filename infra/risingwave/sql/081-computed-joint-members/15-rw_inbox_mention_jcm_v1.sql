-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_mention_jcm_v1 AS
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
LEFT JOIN rw_human_channel_members_v1 AS visu ON visu.channel_id = map.target_id AND mm.target_type = 'user' AND CAST(visu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS visa ON visa.channel_id = map.target_id AND mm.target_type = 'agent' AND CAST(visa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_conversation_parent_v1 AS tp ON tp.thread_channel_id = map.target_id
LEFT JOIN rw_human_channel_members_v1 AS pvisu ON pvisu.channel_id = tp.parent_channel_id AND mm.target_type = 'user' AND CAST(pvisu.user_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_channel_agents AS pvisa ON pvisa.channel_id = tp.parent_channel_id AND mm.target_type = 'agent' AND CAST(pvisa.agent_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR)
LEFT JOIN rw_thread_follows AS mf ON mf.thread_channel_id = map.target_id AND mf.follower_type = mm.target_type AND CAST(mf.follower_id AS VARCHAR) = CAST(mm.target_id AS VARCHAR) AND mf.unfollowed_at IS NULL
LEFT JOIN rw_receiver_cursors_v1 AS rc ON rc.receiver_type = mm.target_type AND rc.receiver_id = CAST(mm.target_id AS VARCHAR) AND rc.channel_id = map.target_id
WHERE (c.type NOT IN ('thread', 'task') AND (visu.user_id IS NOT NULL OR visa.agent_id IS NOT NULL))
   OR (c.type IN ('thread', 'task') AND (pvisu.user_id IS NOT NULL OR pvisa.agent_id IS NOT NULL OR mf.follower_id IS NOT NULL))
   OR (mm.notified_at IS NOT NULL AND NOT map.projected)
GROUP BY 1, 2, 3, 4, 5;
