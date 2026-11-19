-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_task_conversation_unread_jcm_v1 AS
SELECT s.receiver_type, s.receiver_id, s.target_id,
       COUNT(u.seq) FILTER (WHERE u.message_type = 'chat'
         AND NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)) AS unread_count,
       MIN(u.seq) FILTER (WHERE u.message_type = 'chat'
         AND NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)) AS first_unread_seq
FROM rw_subs_jcm_v1 AS s
JOIN rw_channels AS c ON c.id = s.target_id AND c.type = 'task'
LEFT JOIN rw_receiver_cursors_v1 AS rc
  ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
LEFT JOIN rw_message_target_v3 AS u
  ON u.target_id = s.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
GROUP BY s.receiver_type, s.receiver_id, s.target_id, rc.last_read_seq;
