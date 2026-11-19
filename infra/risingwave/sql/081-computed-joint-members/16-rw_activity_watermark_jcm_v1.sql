-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_activity_watermark_jcm_v1 AS
WITH structural AS (
  SELECT 'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id, c.id AS target_id, c.server_id
  FROM rw_human_channel_members_v1 AS ch
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
  LEFT JOIN rw_human_channel_members_v1 AS pch
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
