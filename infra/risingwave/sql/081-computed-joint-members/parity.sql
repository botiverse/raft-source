-- Read-only, parameterized sample. $1 is the exact user-id list recorded in
-- the receipt. Query both generations in one statement to reduce CDC skew.
WITH family AS (
 SELECT c.id,COALESCE(parent.id,c.id) AS copy_channel_id FROM rw_channels c
 LEFT JOIN rw_conversation_parent_v1 p ON p.thread_channel_id=c.id
 LEFT JOIN rw_channels parent ON parent.id=p.parent_channel_id
 WHERE c.type='joint' OR parent.type='joint'
), old_rows AS (
 SELECT 'conversation' AS surface, receiver_id, server_id, target_id,
   unread_count::bigint AS unread, mention_unread::bigint AS mentions
 FROM rw_conversation_unread_v4 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'activity',receiver_id,server_id,COALESCE(channel_id,thread_channel_id),
   unread_count::bigint, CASE WHEN has_mention THEN 1::bigint ELSE 0::bigint END
 FROM rw_inbox_serving_v9 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'mention',receiver_id,server_id,target_id,0::bigint,mention_unread::bigint
 FROM rw_inbox_mention_v7 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'totals',receiver_id,server_id,server_id,total_unread_count::bigint,0::bigint
 FROM rw_activity_totals_v7 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'totals-derived',receiver_id,server_id,server_id,
   SUM(CASE WHEN mention_only THEN 0 ELSE unread_count END)::bigint,0::bigint
 FROM rw_inbox_serving_v9 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
   AND (kind IN ('thread','task') OR channel_type IN ('channel','private','joint','dm'))
 GROUP BY receiver_id,server_id
), new_rows AS (
 SELECT 'conversation' AS surface, receiver_id, server_id, target_id,
   unread_count::bigint AS unread, mention_unread::bigint AS mentions
 FROM rw_conversation_unread_jcm_v1 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'activity',receiver_id,server_id,COALESCE(channel_id,thread_channel_id),
   unread_count::bigint, CASE WHEN has_mention THEN 1::bigint ELSE 0::bigint END
 FROM rw_inbox_serving_jcm_v1 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'mention',receiver_id,server_id,target_id,0::bigint,mention_unread::bigint
 FROM rw_inbox_mention_jcm_v1 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'totals',receiver_id,server_id,server_id,total_unread_count::bigint,0::bigint
 FROM rw_activity_totals_jcm_v1 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
 UNION ALL
 SELECT 'totals-derived',receiver_id,server_id,server_id,
   SUM(CASE WHEN mention_only THEN 0 ELSE unread_count END)::bigint,0::bigint
 FROM rw_inbox_serving_jcm_v1 WHERE receiver_type='user' AND receiver_id=ANY($1::varchar[])
   AND (kind IN ('thread','task') OR channel_type IN ('channel','private','joint','dm'))
 GROUP BY receiver_id,server_id
)
SELECT COALESCE(o.surface,n.surface) surface,COALESCE(o.receiver_id,n.receiver_id) receiver_id,
 COALESCE(o.server_id,n.server_id) server_id,COALESCE(o.target_id,n.target_id) target_id,
 (f.id IS NOT NULL) AS joint_family, f.copy_channel_id,
 (copy_cursor.user_id IS NOT NULL) AS copy_cursor_present,
 (f.id IS NOT NULL AND COALESCE(sm.role='guest',FALSE)) AS guest_entry,
 o.unread AS old_unread,n.unread AS new_unread,o.mentions AS old_mentions,n.mentions AS new_mentions,
 (o.receiver_id IS NOT NULL) AS old_present,(n.receiver_id IS NOT NULL) AS new_present
FROM old_rows o FULL JOIN new_rows n USING(surface,receiver_id,server_id,target_id)
LEFT JOIN family f ON f.id=COALESCE(o.target_id,n.target_id)
LEFT JOIN rw_joint_entry_server_members_v1 sm ON sm.user_id=COALESCE(o.receiver_id,n.receiver_id)
 AND sm.server_id=COALESCE(o.server_id,n.server_id)
LEFT JOIN rw_user_channel_read_cursors_v2 copy_cursor ON copy_cursor.user_id=COALESCE(o.receiver_id,n.receiver_id)
 AND copy_cursor.channel_id=f.copy_channel_id
ORDER BY 1,2,3,4;
