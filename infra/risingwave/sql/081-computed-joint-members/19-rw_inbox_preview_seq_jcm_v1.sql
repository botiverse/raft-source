-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_preview_seq_jcm_v1 AS
SELECT pv.seq, pv.id, pv.preview, pv.sender_type, pv.sender_id, pv.created_at
FROM rw_inbox_preview_need_jcm_v1 AS n
JOIN rw_message_preview_v1 AS pv ON pv.seq = n.seq;
