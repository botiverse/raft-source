-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

-- All consumers share this relation. Non-guests cannot bypass computed access
-- through a legacy joint CH row. Preserve existing guest CH behaviour exactly
-- (Warden 89684dda / Tenny 48d1159d); host flag rollback remains a known gap.
-- The three arms are disjoint by channel type / server role.
CREATE MATERIALIZED VIEW rw_human_channel_members_v1 AS
SELECT ch.channel_id, ch.user_id, ch.joined_at
FROM rw_channel_humans ch
JOIN rw_channels c ON c.id=ch.channel_id AND c.type<>'joint'
UNION ALL
SELECT channel_id, user_id, joined_at FROM rw_joint_human_entries_v1
UNION ALL
SELECT ch.channel_id, ch.user_id, ch.joined_at
FROM rw_channel_humans ch
JOIN rw_channels c ON c.id=ch.channel_id AND c.type='joint'
JOIN rw_joint_entry_server_members_v1 sm ON sm.server_id=c.server_id
  AND sm.user_id=ch.user_id AND sm.role='guest';
