-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_preview_need_jcm_v1 AS
SELECT seq FROM (
  SELECT latest_seq AS seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT first_unread_seq AS seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT max_mention_seq AS seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT first_unread_seq AS seq FROM rw_task_conversation_unread_jcm_v1
  UNION ALL SELECT latest_seq AS seq FROM rw_target_latest_v4
  UNION ALL SELECT latest_seq AS seq FROM rw_inbox_normal_jcm_v1
  UNION ALL SELECT latest_seq AS seq FROM rw_inbox_muted_full_jcm_v1
) AS s
WHERE seq IS NOT NULL
GROUP BY seq;
