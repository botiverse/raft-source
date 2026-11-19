-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_normal_jcm_v1 AS
WITH unread AS (
  SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
         COALESCE(rc.last_read_seq, 0) AS last_read,
         COUNT(u.seq) FILTER (WHERE NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = s.receiver_type AND u.causal_actor_id = s.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS unread_count,
         MIN(u.seq) FILTER (WHERE NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = s.receiver_type AND u.causal_actor_id = s.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS first_unread_seq
  FROM rw_subs_jcm_v1 AS s
  JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
  LEFT JOIN rw_receiver_cursors_v1 AS rc
    ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
  LEFT JOIN rw_message_target_v3 AS u
    ON u.target_id = s.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
  GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq
)
SELECT x.kind, x.receiver_type, x.receiver_id, x.target_id, x.server_id, x.done_at, x.joined_at,
       x.last_read, tl.latest_seq, tl.latest_at, x.unread_count, x.first_unread_seq
FROM unread AS x
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = x.target_id;
