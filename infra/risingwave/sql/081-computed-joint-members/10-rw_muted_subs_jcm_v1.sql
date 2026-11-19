-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_muted_subs_jcm_v1 AS
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS kind,
       'user' AS receiver_type, CAST(ch.user_id AS VARCHAR) AS receiver_id,
       c.id AS target_id, c.server_id, st.done_at, ch.joined_at, mu.mute_from_seq
FROM rw_human_channel_members_v1 ch
JOIN rw_channels c ON ch.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'user' AND mu.receiver_id = CAST(ch.user_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted
LEFT JOIN rw_user_channel_inbox_states st
  ON st.user_id = ch.user_id AND st.channel_id = c.id
UNION ALL
SELECT CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END,
       'agent', CAST(ca.agent_id AS VARCHAR), c.id, c.server_id,
       CAST(NULL AS timestamptz), ca.added_at, mu.mute_from_seq
FROM rw_channel_agents ca
JOIN rw_channels c ON ca.channel_id = c.id AND c.type <> 'thread'
 AND c.deleted_at IS NULL AND c.archived_at IS NULL
JOIN rw_inbox_target_mute_states_v2 mu
  ON mu.receiver_type = 'agent' AND mu.receiver_id = CAST(ca.agent_id AS VARCHAR)
 AND mu.source_channel_id = c.id AND mu.activity_muted;
