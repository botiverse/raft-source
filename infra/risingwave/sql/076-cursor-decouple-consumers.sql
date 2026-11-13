-- Consumer generation on the cursor-decoupled arms (075): the definitions of
-- 068-chain-mention-v6-consumers.sql with only the upstream/own names advanced
-- (normal_v4->v5, muted_prefix_v1->v2, muted_full_v1->v2, items_v10->v11,
-- serving_v6->v7, totals_v4->v5, agent_inbox_v5->v6, conversation_unread_v2->v3).
-- Apply after 075. Output columns are unchanged, so the server switch is a rename.

-- Chain generation on rw_inbox_mention_v6 (joint mentions keyed by message storage).

-- Definitions are the deployed ones with only the upstream names advanced.

CREATE MATERIALIZED VIEW rw_inbox_items_v11 AS WITH n AS (SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_normal_v5 UNION ALL SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, joined_at, last_read, latest_seq, latest_at, unread_count, first_unread_seq FROM rw_inbox_muted_prefix_v2), sup AS (SELECT receiver_type, receiver_id, target_kind, target_channel_id, MAX(done_through_seq) AS done_through_seq, MAX(done_at) AS sup_done_at FROM rw_inbox_suppression_states GROUP BY 1, 2, 3, 4) SELECT COALESCE(n.kind, mn.kind) AS kind, COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type, COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id, COALESCE(n.target_id, mn.target_id) AS target_id, COALESCE(n.server_id, mn.server_id) AS server_id, n.unread_count, n.first_unread_seq, n.latest_seq, n.latest_at, n.last_read AS last_read_seq, COALESCE(mn.mention_unread, 0) AS mention_unread, mn.max_mention_seq, COALESCE(mn.total_mentions, 0) AS total_mentions, ((n.receiver_id IS NOT NULL AND n.latest_seq IS NOT NULL AND (n.done_at IS NULL OR n.latest_at > n.done_at) AND (n.joined_at IS NULL OR n.latest_at > n.joined_at) AND (sn.receiver_id IS NULL OR (sn.done_through_seq IS NOT NULL AND n.latest_seq > sn.done_through_seq) OR (sn.done_through_seq IS NULL AND n.latest_at > sn.sup_done_at))) OR (COALESCE(mn.mention_unread, 0) > 0 AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)) AND (sm.receiver_id IS NULL OR (sm.done_through_seq IS NOT NULL AND mn.max_mention_seq > sm.done_through_seq)))) AS present FROM n FULL JOIN rw_inbox_mention_v6 AS mn ON n.kind = mn.kind AND n.receiver_type = mn.receiver_type AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id LEFT JOIN sup AS sn ON sn.receiver_type = n.receiver_type AND sn.receiver_id = n.receiver_id AND sn.target_channel_id = n.target_id AND sn.target_kind = CASE n.kind WHEN 'thread' THEN 'followed_thread' WHEN 'dm' THEN 'dm' ELSE 'channel' END LEFT JOIN sup AS sm ON sm.receiver_type = mn.receiver_type AND sm.receiver_id = mn.receiver_id AND sm.target_channel_id = mn.target_id AND sm.target_kind = CASE mn.kind WHEN 'thread' THEN 'public_thread_mention' WHEN 'dm' THEN 'dm' ELSE 'public_channel_mention' END;

CREATE MATERIALIZED VIEW rw_inbox_serving_v7 AS SELECT p.server_id, p.receiver_type, p.receiver_id, p.kind, CASE WHEN p.kind = 'thread' THEN NULL ELSE p.target_id END AS channel_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.name END AS channel_name, CASE WHEN p.kind = 'thread' THEN NULL ELSE c.type END AS channel_type, lm.id AS last_message_id, fu.id AS first_unread_message_id, CASE WHEN p.kind = 'thread' THEN NULL ELSE p.latest_at END AS last_message_at, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.preview END AS last_message_preview, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_type END AS last_message_sender_type, CASE WHEN p.kind = 'thread' THEN NULL ELSE lm.sender_id END AS last_message_sender_id, CAST(COALESCE(p.unread_count, 0) AS INT) AS unread_count, CASE WHEN p.kind = 'thread' THEN p.target_id ELSE NULL END AS thread_channel_id, tp.parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type, pm.preview AS parent_message_preview, pm.sender_type AS parent_message_sender_type, pm.sender_id AS parent_message_sender_id, COALESCE(lm.preview, ma.preview) AS latest_activity_preview, COALESCE(lm.sender_type, ma.sender_type) AS latest_activity_sender_type, COALESCE(lm.sender_id, ma.sender_id) AS latest_activity_sender_id, COALESCE(lm.id, ma.id) AS latest_activity_message_id, COALESCE(lm.seq, ma.seq) AS latest_activity_seq, p.latest_at AS last_activity_at, CASE WHEN p.kind = 'thread' THEN p.latest_at ELSE NULL END AS last_reply_at, CASE WHEN p.kind = 'thread' THEN CAST(tl.msg_count AS INT) ELSE NULL END AS reply_count, pm.task_number, pm.task_status, pm.task_assignee_type AS task_claimed_by_type, pm.task_assignee_id AS task_claimed_by_id, (p.mention_unread > 0) AS has_mention, (p.mention_unread > 0 AND p.unread_count IS NULL) AS mention_only, CAST(p.last_read_seq AS BIGINT) AS last_read_seq, COALESCE(p.latest_at, ma.created_at) AS activity_at, (p.total_mentions > 0) AS has_any_mention FROM rw_inbox_items_v11 AS p LEFT JOIN rw_activity_watermark_v5 AS w ON w.receiver_type = p.receiver_type AND w.receiver_id = p.receiver_id AND w.server_id = p.server_id LEFT JOIN rw_channels AS c ON c.id = p.target_id LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = p.latest_seq LEFT JOIN rw_message_preview_v1 AS fu ON fu.seq = p.first_unread_seq LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = p.target_id AND p.kind = 'thread' LEFT JOIN rw_message_preview_v1 AS pm ON pm.id = tp.parent_message_id LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = p.target_id LEFT JOIN rw_message_preview_v1 AS ma ON ma.seq = p.max_mention_seq WHERE p.present AND GREATEST(COALESCE(tl.latest_seq, 0), COALESCE(p.latest_seq, 0), COALESCE(p.max_mention_seq, 0)) >= COALESCE(w.watermark_seq, 0);

CREATE INDEX idx_rw_inbox_serving_v7_receiver ON rw_inbox_serving_v7(receiver_type, receiver_id, activity_at DESC);

CREATE MATERIALIZED VIEW rw_activity_totals_v5 AS WITH served AS (SELECT i.receiver_type, i.receiver_id, i.server_id, CAST(COALESCE(SUM(CASE WHEN i.mention_only THEN 0 ELSE i.unread_count END), 0) AS INT) AS total_unread_count FROM rw_inbox_serving_v7 AS i WHERE (i.kind = 'thread' OR i.channel_type IN ('channel', 'private', 'joint', 'dm')) GROUP BY i.receiver_type, i.receiver_id, i.server_id), members AS (SELECT 'user' AS receiver_type, CAST(user_id AS CHARACTER VARYING) AS receiver_id, server_id FROM rw_server_members) SELECT COALESCE(m.receiver_type, s.receiver_type) AS receiver_type, COALESCE(m.receiver_id, s.receiver_id) AS receiver_id, COALESCE(m.server_id, s.server_id) AS server_id, COALESCE(s.total_unread_count, 0) AS total_unread_count FROM members AS m FULL JOIN served AS s ON s.receiver_type = m.receiver_type AND s.receiver_id = m.receiver_id AND s.server_id = m.server_id;

CREATE MATERIALIZED VIEW rw_agent_inbox_v6 AS WITH proj AS (SELECT s.local_channel_id, j.canonical_channel_id FROM rw_joint_channel_servers AS s JOIN rw_joint_channels AS j ON j.id = s.joint_channel_id WHERE s.status = 'active' AND j.status = 'active'), n AS (SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM rw_inbox_normal_v5 WHERE receiver_type = 'agent' UNION ALL SELECT kind, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq FROM rw_inbox_muted_prefix_v2 WHERE receiver_type = 'agent'), u AS (SELECT COALESCE(n.kind, mn.kind) AS kind, COALESCE(n.receiver_id, mn.receiver_id) AS agent_id, COALESCE(n.target_id, mn.target_id) AS target_id, COALESCE(n.server_id, mn.server_id) AS server_id, COALESCE(n.unread_count, 0) AS unread_count, n.first_unread_seq, n.latest_seq, COALESCE(mn.mention_unread, 0) AS mention_unread, mn.max_mention_seq, (n.receiver_id IS NOT NULL) AS subscribed FROM n FULL JOIN (SELECT * FROM rw_inbox_mention_v6 WHERE receiver_type = 'agent') AS mn ON n.kind = mn.kind AND n.receiver_id = mn.receiver_id AND n.target_id = mn.target_id WHERE (n.receiver_id IS NOT NULL AND COALESCE(n.unread_count, 0) > 0) OR (COALESCE(mn.mention_unread, 0) > 0 AND (n.receiver_id IS NULL OR mn.max_mention_seq > COALESCE(n.latest_seq, 0)))) SELECT u.agent_id, u.server_id, u.kind, u.target_id, COALESCE(p.canonical_channel_id, u.target_id) AS storage_channel_id, c.name AS channel_name, c.type AS channel_type, COALESCE(tp.parent_message_id, c.parent_message_id) AS parent_message_id, tp.parent_channel_id, tp.parent_channel_name, tp.parent_channel_type, CAST(COALESCE(rc.last_read_seq, 0) AS BIGINT) AS last_read_seq, u.unread_count, u.first_unread_seq, u.latest_seq, u.mention_unread, u.max_mention_seq, u.subscribed, CASE WHEN u.subscribed THEN u.unread_count + CASE WHEN u.mention_unread > 0 AND u.max_mention_seq > COALESCE(u.latest_seq, 0) THEN 1 ELSE 0 END ELSE u.mention_unread END AS offered_unread, GREATEST(COALESCE(u.latest_seq, 0), COALESCE(u.max_mention_seq, 0)) AS activity_seq, CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END AS joined_at FROM u JOIN rw_channels AS c ON c.id = u.target_id AND c.deleted_at IS NULL LEFT JOIN proj AS p ON p.local_channel_id = u.target_id LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread' LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id AND pc.deleted_at IS NULL LEFT JOIN rw_channel_agents AS pca ON pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS CHARACTER VARYING) = u.agent_id LEFT JOIN rw_receiver_cursors_v1 AS rc ON rc.receiver_type = 'agent' AND rc.receiver_id = u.agent_id AND rc.channel_id = u.target_id LEFT JOIN rw_channel_agents AS ca ON ca.channel_id = u.target_id AND CAST(ca.agent_id AS CHARACTER VARYING) = u.agent_id AND u.kind <> 'thread' LEFT JOIN rw_thread_follows AS tf ON tf.thread_channel_id = u.target_id AND tf.follower_type = 'agent' AND CAST(tf.follower_id AS CHARACTER VARYING) = u.agent_id AND tf.unfollowed_at IS NULL AND u.kind = 'thread' WHERE (CASE WHEN u.kind = 'thread' THEN tf.created_at ELSE ca.added_at END) IS NOT NULL AND (u.kind <> 'thread' OR (pc.id IS NOT NULL AND (pca.agent_id IS NOT NULL OR (pc.type = 'channel' AND pc.server_id = u.server_id))));

CREATE INDEX idx_rw_agent_inbox_v6_agent_activity ON rw_agent_inbox_v6(agent_id, activity_seq DESC);

-- Sidebar unread on the v6 mention arm (rw_inbox_muted_full_v2 unchanged).
-- Build it only where rw_inbox_muted_full_v2 exists.
CREATE MATERIALIZED VIEW rw_conversation_unread_v3 AS
WITH subs AS (
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_normal_v5
  UNION ALL
  SELECT kind, receiver_type, receiver_id, target_id, server_id, done_at, latest_seq, unread_count
  FROM rw_inbox_muted_full_v2
), u AS (
  SELECT COALESCE(n.kind, mn.kind) AS kind,
         COALESCE(n.receiver_type, mn.receiver_type) AS receiver_type,
         COALESCE(n.receiver_id, mn.receiver_id) AS receiver_id,
         COALESCE(n.target_id, mn.target_id) AS target_id,
         COALESCE(n.server_id, mn.server_id) AS server_id,
         (n.receiver_id IS NOT NULL) AS subscribed,
         n.done_at,
         n.latest_seq,
         COALESCE(n.unread_count, 0) AS unread_count,
         COALESCE(mn.mention_unread, 0) AS mention_unread,
         COALESCE(mn.total_mentions, 0) AS total_mentions
  FROM subs AS n
  FULL JOIN rw_inbox_mention_v6 AS mn
    ON mn.receiver_type = n.receiver_type AND mn.receiver_id = n.receiver_id AND mn.target_id = n.target_id
)
SELECT u.receiver_type, u.receiver_id, u.server_id, u.target_id, u.kind, u.subscribed,
       u.unread_count, u.mention_unread, u.total_mentions,
       COALESCE(u.latest_seq, tl.latest_seq) AS latest_seq,
       lm.id AS latest_message_id,
       (COALESCE(uc.user_id, ac.agent_id) IS NOT NULL) AS cursor_present,
       COALESCE(CAST(uc.last_read_seq AS BIGINT), ac.last_read_seq8, CAST(ac.last_read_seq AS BIGINT)) AS last_read_seq,
       COALESCE(uc.read_state_version, ac.read_state_version) AS read_state_version
FROM u
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = u.target_id
LEFT JOIN rw_message_preview_v1 AS lm ON lm.seq = COALESCE(u.latest_seq, tl.latest_seq)
LEFT JOIN rw_user_channel_read_cursors_v2 AS uc
  ON u.receiver_type = 'user' AND CAST(uc.user_id AS VARCHAR) = u.receiver_id AND uc.channel_id = u.target_id
LEFT JOIN rw_agent_channel_read_cursors AS ac
  ON u.receiver_type = 'agent' AND CAST(ac.agent_id AS VARCHAR) = u.receiver_id AND ac.channel_id = u.target_id
LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id AND u.kind = 'thread'
LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
LEFT JOIN rw_channel_humans AS pch
  ON u.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = u.receiver_id
LEFT JOIN rw_channel_agents AS pca
  ON u.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = u.receiver_id
-- A thread has a sidebar slot only while followed and not done, under a live parent
-- the receiver can see (public, or a member of private/DM/joint parent).
WHERE u.kind <> 'thread'
   OR (u.subscribed AND u.done_at IS NULL
       AND pc.id IS NOT NULL AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
       AND (pc.type = 'channel' OR pch.user_id IS NOT NULL OR pca.agent_id IS NOT NULL));

CREATE INDEX idx_rw_conversation_unread_v3_receiver
  ON rw_conversation_unread_v3 (receiver_type, receiver_id, server_id);

