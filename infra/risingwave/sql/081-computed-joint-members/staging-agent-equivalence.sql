-- Read-only after CDC settles. All agents; no message contents returned.
-- Execute each SELECT separately with an operator-supplied 30s query deadline.
SELECT 'old_agent_key' AS check_name,COUNT(*) AS violations
FROM (SELECT agent_id,server_id,kind,target_id FROM rw_agent_inbox_v7
 GROUP BY agent_id,server_id,kind,target_id HAVING COUNT(*)<>1) d
UNION ALL
SELECT 'new_agent_key',COUNT(*)
FROM (SELECT agent_id,server_id,kind,target_id FROM rw_agent_inbox_jcm_v1
 GROUP BY agent_id,server_id,kind,target_id HAVING COUNT(*)<>1) d;

WITH compared AS (
 SELECT o.agent_id IS NULL OR n.agent_id IS NULL
  OR o.storage_channel_id IS DISTINCT FROM n.storage_channel_id
  OR o.channel_name IS DISTINCT FROM n.channel_name
  OR o.channel_type IS DISTINCT FROM n.channel_type
  OR o.parent_message_id IS DISTINCT FROM n.parent_message_id
  OR o.parent_channel_id IS DISTINCT FROM n.parent_channel_id
  OR o.parent_channel_name IS DISTINCT FROM n.parent_channel_name
  OR o.parent_channel_type IS DISTINCT FROM n.parent_channel_type
  OR o.last_read_seq IS DISTINCT FROM n.last_read_seq
  OR o.unread_count IS DISTINCT FROM n.unread_count
  OR o.first_unread_seq IS DISTINCT FROM n.first_unread_seq
  OR o.latest_seq IS DISTINCT FROM n.latest_seq
  OR o.mention_unread IS DISTINCT FROM n.mention_unread
  OR o.max_mention_seq IS DISTINCT FROM n.max_mention_seq
  OR o.subscribed IS DISTINCT FROM n.subscribed
  OR o.offered_unread IS DISTINCT FROM n.offered_unread
  OR o.activity_seq IS DISTINCT FROM n.activity_seq
  OR o.joined_at IS DISTINCT FROM n.joined_at
 AS mismatch
 FROM rw_agent_inbox_v7 o FULL JOIN rw_agent_inbox_jcm_v1 n
 ON n.agent_id=o.agent_id AND n.server_id=o.server_id
 AND n.kind=o.kind AND n.target_id=o.target_id
)
SELECT 'agent_inbox_equivalence' AS check_name,COUNT(*) AS rows_checked,
 COUNT(*) FILTER (WHERE mismatch) AS violations FROM compared;
