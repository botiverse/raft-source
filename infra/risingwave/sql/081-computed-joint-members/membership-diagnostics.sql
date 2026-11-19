-- Read-only sampled entry diagnostics, not serving DDL. Flags are deliberately
-- not inferred: "strict_excluded" means a flag-off candidate lacks a live source,
-- not that the host currently has source-exit off. Review PG effective flags.
WITH pending AS (
 SELECT DISTINCT d.joint_channel_id,r.user_id
 FROM rw_joint_membership_departures_v1 d
 JOIN rw_joint_membership_removals_v1 r ON r.departure_id=d.id
 WHERE d.completed_at IS NULL AND r.remove_membership AND r.user_id IS NOT NULL
)
SELECT m.user_id AS receiver_id,p.server_id,p.local_channel_id AS channel_id,
 sm.role, (ch.user_id IS NOT NULL) AS legacy_ch_present,
 (strict.user_id IS NOT NULL) AS strict_present,
 (sm.role<>'guest' AND strict.user_id IS NULL) AS strict_excluded,
 (sm.role='guest' AND ch.user_id IS NOT NULL) AS legacy_guest_retained
FROM rw_joint_channel_members_v1 m
JOIN rw_joint_channels j ON j.id=m.joint_channel_id AND j.status='active'
JOIN rw_joint_entry_projections_v1 p ON p.joint_channel_id=m.joint_channel_id AND p.status='active'
JOIN rw_channels c ON c.id=p.local_channel_id AND c.server_id=p.server_id AND c.type='joint' AND c.deleted_at IS NULL
JOIN rw_servers s ON s.id=p.server_id AND s.deleted_at IS NULL
JOIN rw_joint_entry_server_members_v1 sm ON sm.server_id=p.server_id AND sm.user_id=m.user_id
LEFT JOIN pending deny ON deny.joint_channel_id=m.joint_channel_id AND deny.user_id=m.user_id
LEFT JOIN rw_joint_human_entries_v1 strict ON strict.channel_id=p.local_channel_id AND strict.user_id=m.user_id
LEFT JOIN rw_channel_humans ch ON ch.channel_id=p.local_channel_id AND ch.user_id=m.user_id
WHERE m.user_id=ANY($1::varchar[]) AND deny.user_id IS NULL
ORDER BY 1,2,3;
