-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_muted_prefix_jcm_v1 AS
WITH admitted AS (
  SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
         s.mute_from_seq, MAX(m.seq) AS latest_seq, MAX(m.created_at) AS latest_at
  FROM rw_muted_subs_jcm_v1 AS s
  JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
  JOIN rw_message_target_v3 AS m
    ON m.target_id = s.target_id AND m.seq < COALESCE(s.mute_from_seq, 9223372036854775807)
  GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, s.mute_from_seq
), unread AS (
  SELECT a.receiver_type, a.receiver_id, a.target_id,
         COALESCE(rc.last_read_seq, 0) AS last_read,
         COUNT(u.seq) FILTER (WHERE NOT (u.sender_type = a.receiver_type AND u.sender_id = a.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = a.receiver_type AND u.causal_actor_id = a.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS unread_count,
         MIN(u.seq) FILTER (WHERE NOT (u.sender_type = a.receiver_type AND u.sender_id = a.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = a.receiver_type AND u.causal_actor_id = a.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS first_unread_seq
  FROM rw_muted_subs_jcm_v1 AS a
  LEFT JOIN rw_receiver_cursors_v1 AS rc
    ON rc.receiver_type = a.receiver_type AND rc.receiver_id = a.receiver_id AND rc.channel_id = a.target_id
  LEFT JOIN rw_message_target_v3 AS u
    ON u.target_id = a.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
   AND (a.mute_from_seq IS NULL OR u.seq < a.mute_from_seq)
  GROUP BY a.receiver_type, a.receiver_id, a.target_id, rc.last_read_seq
)
SELECT p.kind, p.receiver_type, p.receiver_id, p.target_id, p.server_id, p.done_at, p.joined_at,
       COALESCE(x.last_read, 0) AS last_read, p.latest_seq, p.latest_at,
       COALESCE(x.unread_count, 0) AS unread_count, x.first_unread_seq
FROM admitted AS p
LEFT JOIN unread AS x
  ON x.receiver_type = p.receiver_type AND x.receiver_id = p.receiver_id AND x.target_id = p.target_id;
