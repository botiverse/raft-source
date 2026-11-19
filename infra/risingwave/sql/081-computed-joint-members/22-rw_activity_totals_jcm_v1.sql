-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_activity_totals_jcm_v1 AS WITH served AS (SELECT i.receiver_type, i.receiver_id, i.server_id, CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count FROM rw_inbox_serving_jcm_v1 AS i WHERE (i.kind IN ('thread', 'task') OR i.channel_type IN ('channel', 'private', 'joint', 'dm')) GROUP BY i.receiver_type, i.receiver_id, i.server_id), members AS (SELECT 'user' AS receiver_type, CAST(user_id AS CHARACTER VARYING) AS receiver_id, server_id FROM rw_server_members) SELECT COALESCE(m.receiver_type, s.receiver_type) AS receiver_type, COALESCE(m.receiver_id, s.receiver_id) AS receiver_id, COALESCE(m.server_id, s.server_id) AS server_id, COALESCE(s.total_unread_count, 0) AS total_unread_count FROM members AS m FULL JOIN served AS s ON s.receiver_type = m.receiver_type AND s.receiver_id = m.receiver_id AND s.server_id = m.server_id;
