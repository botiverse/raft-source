-- Read-only. Bind $1 to the SAME 1–25 user ids used by ops:rw-joint-member-parity.
-- Save the ids/category matrix with that receipt. Missing coverage is NOT pass.
-- joint_two_servers must identify the reported person across both reported
-- servers/copies, not merely an unrelated joint channel with two projections.
WITH subscriptions AS (
 SELECT kind,receiver_type,receiver_id,target_id,server_id,FALSE AS muted FROM rw_subs_jcm_v1
 UNION ALL
 SELECT kind,receiver_type,receiver_id,target_id,server_id,TRUE AS muted FROM rw_muted_subs_jcm_v1
), sample AS (
 SELECT s.*,c.type AS channel_type,
  COALESCE(pc.type,c.type) AS parent_type,sm.role,
  (uc.user_id IS NULL) AS no_cursor,
  (legacy.user_id IS NOT NULL) AS legacy_ch_present
 FROM subscriptions s
 JOIN rw_channels c ON c.id=s.target_id
 LEFT JOIN rw_conversation_parent_v1 tp ON tp.thread_channel_id=c.id
 LEFT JOIN rw_channels pc ON pc.id=tp.parent_channel_id
 LEFT JOIN rw_joint_entry_server_members_v1 sm
  ON sm.user_id=s.receiver_id AND sm.server_id=s.server_id
 LEFT JOIN rw_user_channel_read_cursors_v2 uc
  ON uc.user_id=s.receiver_id AND uc.channel_id=COALESCE(pc.id,c.id)
 LEFT JOIN rw_channel_humans legacy
  ON legacy.user_id=s.receiver_id AND legacy.channel_id=COALESCE(pc.id,c.id)
 WHERE s.receiver_type='user' AND s.receiver_id=ANY($1::varchar[])
), joint_two AS (
 SELECT e.user_id,j.id AS joint_channel_id,COUNT(DISTINCT p.server_id) AS entry_servers
 FROM rw_human_channel_members_v1 e
 JOIN rw_joint_entry_projections_v1 p ON p.local_channel_id=e.channel_id
 JOIN rw_joint_channels j ON j.id=p.joint_channel_id AND j.status='active'
 -- Shared human membership has no server_id: use projection identity.
 WHERE e.user_id=ANY($1::varchar[]) AND p.status='active'
 GROUP BY e.user_id,j.id HAVING COUNT(DISTINCT p.server_id)>=2
), two_counts AS (
 SELECT user_id,COUNT(*) AS joint_two_servers FROM joint_two GROUP BY user_id
)
SELECT receiver_id,COUNT(*) AS subscription_rows,
 COUNT(*) FILTER(WHERE parent_type<>'joint') AS non_joint,
 COUNT(*) FILTER(WHERE parent_type='joint' AND role='guest' AND legacy_ch_present) AS retained_guest,
 COUNT(*) FILTER(WHERE muted) AS muted,
 COUNT(*) FILTER(WHERE kind='thread' AND channel_type<>'task') AS followed_thread,
 COUNT(*) FILTER(WHERE channel_type='task') AS task_conversation,
 COUNT(*) FILTER(WHERE parent_type='joint' AND no_cursor) AS joint_without_cursor,
 COALESCE(tc.joint_two_servers,0) AS joint_two_servers
FROM sample LEFT JOIN two_counts tc ON tc.user_id=sample.receiver_id
GROUP BY receiver_id,tc.joint_two_servers ORDER BY receiver_id;
