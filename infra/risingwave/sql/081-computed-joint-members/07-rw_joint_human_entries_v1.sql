-- RBAC #73: parallel generation. One object per execution step.
-- No serving switch or old-object drop in this build.
-- Production: reviewed DDL window, fresh capacity/watch baseline, clean checkout.
-- Before next object: rw_ddl_progress empty, this object catalog-visible,
-- direct dependencies bind, receipt records artifact SHA and Git commit.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

-- Strict subset of filterJointHumanMemberEntries: flags are NOT evaluated here.
-- Entry guests are excluded; a live current-generation source is always required.
-- Pending departures deny until completed_at, regardless of removal.completed_at.
-- All three GREATEST inputs are NOT NULL upstream: joint_channel_members
-- (0446_joint_human_membership.sql), server_members (0000_lyrical_arclight.sql),
-- joint_channel_servers (0092_damp_thor_girl.sql). Confirm on the target PG with
-- pg-preflight.sql and require CDC snapshot parity/no null join times before
-- building this view; no assumption about RW's nullable GREATEST is needed.
CREATE MATERIALIZED VIEW rw_joint_human_entries_v1 AS
WITH pending AS (
 SELECT DISTINCT d.joint_channel_id, r.user_id
 FROM rw_joint_membership_removals_v1 r
 JOIN rw_joint_membership_departures_v1 d ON d.id=r.departure_id
 WHERE d.completed_at IS NULL AND r.remove_membership AND r.user_id IS NOT NULL
), live_sources AS (
 SELECT DISTINCT m.joint_channel_id, m.user_id
 FROM rw_joint_channel_members_v1 m
 JOIN rw_joint_channel_admissions_v1 a ON a.joint_channel_id=m.joint_channel_id
   AND a.user_id=m.user_id AND a.generation=m.generation AND a.ended_at IS NULL
 JOIN rw_joint_entry_projections_v1 p ON p.joint_channel_id=a.joint_channel_id
   AND p.server_id=a.server_id AND p.status='active'
 JOIN rw_joint_channels j ON j.id=a.joint_channel_id AND j.status='active'
 JOIN rw_channels c ON c.id=p.local_channel_id AND c.type='joint' AND c.deleted_at IS NULL
 JOIN rw_servers s ON s.id=a.server_id AND s.deleted_at IS NULL
 JOIN rw_joint_entry_server_members_v1 sm ON sm.server_id=a.server_id AND sm.user_id=a.user_id
 WHERE sm.role<>'guest' OR (sm.role='guest' AND sm.guest_channel_id=p.local_channel_id AND p.role='host')
)
SELECT p.local_channel_id AS channel_id, m.user_id,
       GREATEST(m.joined_at, sm.joined_at, p.joined_at) AS joined_at
FROM rw_joint_entry_projections_v1 p
JOIN rw_joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
JOIN rw_channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id
  AND c.type='joint' AND c.deleted_at IS NULL
JOIN rw_servers s ON s.id=p.server_id AND s.deleted_at IS NULL
JOIN rw_joint_entry_server_members_v1 sm ON sm.server_id=p.server_id AND sm.role<>'guest'
JOIN rw_joint_channel_members_v1 m ON m.joint_channel_id=p.joint_channel_id AND m.user_id=sm.user_id
JOIN live_sources ls ON ls.joint_channel_id=m.joint_channel_id AND ls.user_id=m.user_id
LEFT JOIN pending deny ON deny.joint_channel_id=m.joint_channel_id AND deny.user_id=m.user_id
WHERE p.status='active' AND deny.user_id IS NULL;
