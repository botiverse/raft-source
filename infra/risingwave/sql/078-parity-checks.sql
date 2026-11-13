-- Checks for 078. Run after 078 has finished backfilling, next to the
-- generation it replaces (067's mention v6, 076's agent inbox v6 / conversation
-- unread v3, 077's watermark v6 / items v12 / serving v8 / totals v6). Both
-- sides update concurrently, so a small transient count can appear on a busy
-- server: re-run; a real defect persists.
--
-- 078 is meant to differ from the previous generation only on task
-- conversations (rw_channels.type = 'task'), which the previous generation
-- dropped: rows the new views add for them, plus, for a receiver at the
-- 500-target cap, rows that the moved watermark (followed task conversations
-- now count as targets) brings into or out of the window; and serving's task
-- columns, which come from rw_tasks (check 7) rather than from the parent
-- message's legacy task columns, and task rows' reply_count counts chat
-- messages only (check 7b), and so do their unread_count (serving, conversation
-- unread; checks 7c, 7d). Checks 1-7d must report 0 in both columns;
-- check 8 must report 0; 9 is informational (what 078 adds).
--
-- More intended differences (the 078 add-on):
--   - mention_unread / max_mention_seq count only mentions that notify
--     (notifiable_at_send, or notified_at set later), so every column fed by
--     them (items' present, serving's has_mention / mention_only, agent inbox
--     offered_unread, conversation unread) differs for a receiver with a
--     mention that does not notify. Checks 1-6 and the totals leave those
--     receivers out (silent_receivers); check 10 sizes them.
--   - serving's display times (last_message_at, last_activity_at,
--     last_reply_at, activity_at) are the highest-seq message's created_at, so
--     check 6 leaves them out and check 6b checks them.
--   - New columns (mention v7 first_mention_message_id, items v13
--     first_mention_message_id / mention_done_through_seq, serving v9
--     first_mention_message_id / mention_done_through_seq) are not compared
--     with the previous generation; check 11 checks the anchor.

-- 1-5. Old vs new, outside task conversations and receivers with a mention
--      that does not notify.
WITH task_conv AS (SELECT id AS target_id FROM rw_channels WHERE type = 'task'),
silent_receivers AS (SELECT DISTINCT target_type AS receiver_type, CAST(target_id AS VARCHAR) AS receiver_id FROM rw_message_mentions_v2 WHERE NOT (notifiable_at_send OR notified_at IS NOT NULL)),
v7 AS (SELECT kind, receiver_type, receiver_id, target_id, server_id, mention_unread, max_mention_seq, total_mentions FROM rw_inbox_mention_v7)
SELECT 'rw_inbox_mention_v6 vs v7' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_mention_v6 EXCEPT SELECT * FROM v7) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM v7 EXCEPT SELECT * FROM rw_inbox_mention_v6) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_new;

WITH task_conv AS (SELECT id AS target_id FROM rw_channels WHERE type = 'task'),
silent_receivers AS (SELECT DISTINCT target_type AS receiver_type, CAST(target_id AS VARCHAR) AS receiver_id FROM rw_message_mentions_v2 WHERE NOT (notifiable_at_send OR notified_at IS NOT NULL)),
v13 AS (SELECT kind, receiver_type, receiver_id, target_id, server_id, unread_count, first_unread_seq, latest_seq, latest_at, last_read_seq, mention_unread, max_mention_seq, total_mentions, present FROM rw_inbox_items_v13)
SELECT 'rw_inbox_items_v12 vs v13' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_items_v12 EXCEPT SELECT * FROM v13) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM v13 EXCEPT SELECT * FROM rw_inbox_items_v12) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_new;

-- v4's muted arm is rw_inbox_muted_full_v1, v3's rw_inbox_muted_full_v2 (same
-- columns and semantics). Where v3 is not built, compare v4 the same way with the
-- conversation unread view the server reads (same columns).
WITH task_conv AS (SELECT id AS target_id FROM rw_channels WHERE type = 'task'),
silent_receivers AS (SELECT DISTINCT target_type AS receiver_type, CAST(target_id AS VARCHAR) AS receiver_id FROM rw_message_mentions_v2 WHERE NOT (notifiable_at_send OR notified_at IS NOT NULL))
SELECT 'rw_conversation_unread_v3 vs v4' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_conversation_unread_v3 EXCEPT SELECT * FROM rw_conversation_unread_v4) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_conversation_unread_v4 EXCEPT SELECT * FROM rw_conversation_unread_v3) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = d.receiver_type AND sr.receiver_id = d.receiver_id)) AS only_new;

WITH task_conv AS (SELECT id AS target_id FROM rw_channels WHERE type = 'task'),
silent_receivers AS (SELECT DISTINCT target_type AS receiver_type, CAST(target_id AS VARCHAR) AS receiver_id FROM rw_message_mentions_v2 WHERE NOT (notifiable_at_send OR notified_at IS NOT NULL))
SELECT 'rw_agent_inbox_v6 vs v7' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v6 EXCEPT SELECT * FROM rw_agent_inbox_v7) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = 'agent' AND sr.receiver_id = d.agent_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v7 EXCEPT SELECT * FROM rw_agent_inbox_v6) AS d WHERE d.target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = 'agent' AND sr.receiver_id = d.agent_id)) AS only_new;

-- The watermark moves only for receivers who follow a task conversation.
SELECT 'rw_activity_watermark_v6 vs v7 (receivers without a task follow)' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_watermark_v6 EXCEPT SELECT * FROM rw_activity_watermark_v7) AS d
    WHERE NOT EXISTS (SELECT 1 FROM rw_thread_follows AS tf JOIN rw_channels AS c ON c.id = tf.thread_channel_id AND c.type = 'task'
                       WHERE tf.follower_type = d.receiver_type AND CAST(tf.follower_id AS VARCHAR) = d.receiver_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_watermark_v7 EXCEPT SELECT * FROM rw_activity_watermark_v6) AS d
    WHERE NOT EXISTS (SELECT 1 FROM rw_thread_follows AS tf JOIN rw_channels AS c ON c.id = tf.thread_channel_id AND c.type = 'task'
                       WHERE tf.follower_type = d.receiver_type AND CAST(tf.follower_id AS VARCHAR) = d.receiver_id)) AS only_new;

-- 6. Serving: outside task conversations, for receivers whose watermark did not
--    move and who have no mention that does not notify, with the task columns
--    (now from rw_tasks, check 7) and the display times (check 6b) left out.
WITH task_conv AS (SELECT id AS target_id FROM rw_channels WHERE type = 'task'),
silent_receivers AS (SELECT DISTINCT target_type AS receiver_type, CAST(target_id AS VARCHAR) AS receiver_id FROM rw_message_mentions_v2 WHERE NOT (notifiable_at_send OR notified_at IS NOT NULL)),
v8 AS (SELECT server_id, receiver_type, receiver_id, kind, channel_id, channel_name, channel_type, last_message_id, first_unread_message_id, last_message_preview, last_message_sender_type, last_message_sender_id, unread_count, thread_channel_id, parent_message_id, parent_channel_id, parent_channel_name, parent_channel_type, parent_message_preview, parent_message_sender_type, parent_message_sender_id, latest_activity_preview, latest_activity_sender_type, latest_activity_sender_id, latest_activity_message_id, latest_activity_seq, reply_count, has_mention, mention_only, last_read_seq, has_any_mention FROM rw_inbox_serving_v8),
v9 AS (SELECT server_id, receiver_type, receiver_id, kind, channel_id, channel_name, channel_type, last_message_id, first_unread_message_id, last_message_preview, last_message_sender_type, last_message_sender_id, unread_count, thread_channel_id, parent_message_id, parent_channel_id, parent_channel_name, parent_channel_type, parent_message_preview, parent_message_sender_type, parent_message_sender_id, latest_activity_preview, latest_activity_sender_type, latest_activity_sender_id, latest_activity_message_id, latest_activity_seq, reply_count, has_mention, mention_only, last_read_seq, has_any_mention FROM rw_inbox_serving_v9),
same_wm AS (
  SELECT d.receiver_type, d.receiver_id, d.server_id, COALESCE(d.channel_id, d.thread_channel_id) AS target_id
  FROM (SELECT * FROM v8 EXCEPT SELECT * FROM v9) AS d
  LEFT JOIN rw_activity_watermark_v6 AS w6 ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
  LEFT JOIN rw_activity_watermark_v7 AS w7 ON w7.receiver_type = d.receiver_type AND w7.receiver_id = d.receiver_id AND w7.server_id = d.server_id
  WHERE (w6.watermark_seq IS NOT DISTINCT FROM w7.watermark_seq)
), same_wm_new AS (
  SELECT d.receiver_type, d.receiver_id, d.server_id, COALESCE(d.channel_id, d.thread_channel_id) AS target_id
  FROM (SELECT * FROM v9 EXCEPT SELECT * FROM v8) AS d
  LEFT JOIN rw_activity_watermark_v6 AS w6 ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
  LEFT JOIN rw_activity_watermark_v7 AS w7 ON w7.receiver_type = d.receiver_type AND w7.receiver_id = d.receiver_id AND w7.server_id = d.server_id
  WHERE (w6.watermark_seq IS NOT DISTINCT FROM w7.watermark_seq)
)
SELECT 'rw_inbox_serving_v8 vs v9 (watermark unchanged)' AS pair,
  (SELECT COUNT(*) FROM same_wm AS x WHERE target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = x.receiver_type AND sr.receiver_id = x.receiver_id)) AS only_old,
  (SELECT COUNT(*) FROM same_wm_new AS x WHERE target_id NOT IN (SELECT target_id FROM task_conv)
     AND NOT EXISTS (SELECT 1 FROM silent_receivers AS sr WHERE sr.receiver_type = x.receiver_type AND sr.receiver_id = x.receiver_id)) AS only_new;

-- 6b. Display times are the highest-seq message's created_at (last_message_id,
--     the preview's message), the mention's on a mention-only row with no
--     message of its own. Rows that disagree.
SELECT 'rw_inbox_serving_v9 display times that are not the latest message''s' AS pair,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
     LEFT JOIN rw_message_preview_v1 AS lm ON lm.id = i.last_message_id
    WHERE i.last_message_id IS NOT NULL
      AND ((i.last_activity_at IS DISTINCT FROM lm.created_at)
        OR (i.activity_at IS DISTINCT FROM lm.created_at)
        OR (i.last_message_at IS DISTINCT FROM CASE WHEN i.kind IN ('thread', 'task') THEN NULL ELSE lm.created_at END)
        OR (i.last_reply_at IS DISTINCT FROM CASE WHEN i.kind IN ('thread', 'task') THEN lm.created_at END))) AS only_old,
  0 AS only_new;

-- 7. Serving task columns: a thread row carries the task of its parent message,
--    a task conversation row its own task (rw_channels.task_id), any other row
--    none. Rows whose task columns disagree with rw_tasks.
SELECT 'rw_inbox_serving_v9 task columns that disagree with rw_tasks' AS pair,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
     LEFT JOIN rw_channels AS c ON i.kind = 'task' AND c.id = i.thread_channel_id
     LEFT JOIN rw_tasks AS ct ON ct.id = c.task_id
     LEFT JOIN rw_tasks AS t ON i.kind = 'thread' AND t.message_id = i.parent_message_id
    -- Parenthesized: RisingWave binds IS DISTINCT FROM looser than OR/AND.
    WHERE (i.task_number IS DISTINCT FROM COALESCE(ct.task_number, t.task_number))
       OR (i.task_status IS DISTINCT FROM COALESCE(ct.status, t.status))
       OR (i.task_claimed_by_type IS DISTINCT FROM COALESCE(ct.claimed_by_type, t.claimed_by_type))
       OR (i.task_claimed_by_id IS DISTINCT FROM COALESCE(ct.claimed_by_id, t.claimed_by_id))) AS only_old,
  0 AS only_new;

-- 7b. A task conversation row's reply_count is its chat messages only (lifecycle
--     lines are system messages), a thread row's every message.
SELECT 'rw_inbox_serving_v9 task rows whose reply_count is not their chat messages' AS pair,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
    WHERE i.kind = 'task'
      AND i.reply_count <> (SELECT COUNT(*) FROM rw_message_target_v3 AS m
                             WHERE m.target_id = i.thread_channel_id AND m.message_type = 'chat')) AS only_old,
  0 AS only_new;

-- 7c. A task conversation row's unread_count is on the reply basis: its chat
--     messages after the receiver's cursor, not the receiver's own (lifecycle
--     lines are not "new"). Mention-only rows (not followed) carry no unread.
SELECT 'rw_inbox_serving_v9 task rows whose unread_count is not their unread chat messages' AS pair,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
     LEFT JOIN rw_receiver_cursors_v1 AS rc
       ON rc.receiver_type = i.receiver_type AND rc.receiver_id = i.receiver_id AND rc.channel_id = i.thread_channel_id
    WHERE i.kind = 'task' AND NOT i.mention_only
      AND i.unread_count <> (SELECT COUNT(*) FROM rw_message_target_v3 AS m
                              WHERE m.target_id = i.thread_channel_id AND m.message_type = 'chat'
                                AND m.seq > COALESCE(rc.last_read_seq, 0)
                                AND NOT (m.sender_type = i.receiver_type AND m.sender_id = i.receiver_id))) AS only_old,
  0 AS only_new;

-- 7d. Same basis everywhere: no task row reads more "new" than replies, and the
--     sidebar's task rows agree with serving.
SELECT 'task rows with unread_count > reply_count (serving) / serving vs conversation unread' AS pair,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 WHERE kind = 'task' AND unread_count > reply_count) AS only_old,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
     JOIN rw_conversation_unread_v4 AS u
       ON u.receiver_type = i.receiver_type AND u.receiver_id = i.receiver_id AND u.target_id = i.thread_channel_id
    WHERE i.kind = 'task' AND u.kind = 'task' AND NOT i.mention_only AND u.unread_count <> i.unread_count) AS only_new;

-- Totals: only receivers with a serving difference (any reason above) may differ,
-- on the columns totals read.
WITH v8 AS (SELECT receiver_type, receiver_id, server_id, kind, channel_id, channel_type, thread_channel_id, unread_count, mention_only FROM rw_inbox_serving_v8),
v9 AS (SELECT receiver_type, receiver_id, server_id, kind, channel_id, channel_type, thread_channel_id, unread_count, mention_only FROM rw_inbox_serving_v9)
SELECT 'rw_activity_totals_v6 vs v7 (receivers without a serving difference)' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_totals_v6 EXCEPT SELECT * FROM rw_activity_totals_v7) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM ((SELECT * FROM v8 EXCEPT SELECT * FROM v9)
                     UNION ALL (SELECT * FROM v9 EXCEPT SELECT * FROM v8)) AS r
       WHERE r.receiver_type = d.receiver_type AND r.receiver_id = d.receiver_id AND r.server_id = d.server_id)) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_totals_v7 EXCEPT SELECT * FROM rw_activity_totals_v6) AS d
    WHERE NOT EXISTS (
      SELECT 1 FROM ((SELECT * FROM v8 EXCEPT SELECT * FROM v9)
                     UNION ALL (SELECT * FROM v9 EXCEPT SELECT * FROM v8)) AS r
       WHERE r.receiver_type = d.receiver_type AND r.receiver_id = d.receiver_id AND r.server_id = d.server_id)) AS only_new;

-- 8. Every task conversation row of the reader views says kind 'task', and no
--    other row does.
SELECT 'reader rows whose kind disagrees with the conversation type' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 AS i
     JOIN rw_channels AS c ON c.id = COALESCE(i.thread_channel_id, i.channel_id)
    WHERE (i.kind = 'task') <> (c.type = 'task'))
  + (SELECT COUNT(*) FROM rw_agent_inbox_v7 AS a
     JOIN rw_channels AS c ON c.id = a.target_id
    WHERE (a.kind = 'task') <> (c.type = 'task'))
  + (SELECT COUNT(*) FROM rw_conversation_unread_v4 AS u
     JOIN rw_channels AS c ON c.id = u.target_id
    WHERE (u.kind = 'task') <> (c.type = 'task')) AS n;

-- 9. Informational: task conversation rows 078 serves (absent from the previous generation).
SELECT 'task conversation rows: serving, agent inbox, conversation unread' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9 WHERE kind = 'task') AS serving,
  (SELECT COUNT(*) FROM rw_agent_inbox_v7 WHERE kind = 'task') AS agent_inbox,
  (SELECT COUNT(*) FROM rw_conversation_unread_v4 WHERE kind = 'task') AS conversation_unread;

-- 10. Informational: what counting only notifying mentions changes, reported
--     separately for users and agents (the proposal sized it at 193 user /
--     2,145 agent groups changed; 139 / 1,318 lose the @). Postgres delivery and
--     wake never act on these mentions either (live delivery and occurrence
--     records require notifiable_at_send; resume catch-up's mention flag
--     requires notifiable_at_send OR notified_at), so on agents this removes
--     rows the chain offered and the catch-up read never returned. The second
--     query is the agent-inbox side of it: rows whose offered unread changes or
--     that leave rw_agent_inbox_v7.
SELECT o.receiver_type,
  COUNT(*) FILTER (WHERE o.mention_unread <> COALESCE(n.mention_unread, 0)) AS changed,
  COUNT(*) FILTER (WHERE o.mention_unread > 0 AND COALESCE(n.mention_unread, 0) = 0) AS to_zero
FROM rw_inbox_mention_v6 AS o
LEFT JOIN rw_inbox_mention_v7 AS n USING (kind, receiver_type, receiver_id, target_id)
GROUP BY o.receiver_type;

SELECT 'agent inbox rows whose offered_unread changes / that leave the inbox' AS check_name,
  (SELECT COUNT(*) FROM rw_agent_inbox_v6 AS o JOIN rw_agent_inbox_v7 AS n USING (agent_id, target_id)
    WHERE o.offered_unread <> n.offered_unread) AS offered_changed,
  (SELECT COUNT(*) FROM rw_agent_inbox_v6 AS o LEFT JOIN rw_agent_inbox_v7 AS n USING (agent_id, target_id)
    WHERE n.agent_id IS NULL) AS left_inbox;

-- 11. The member anchor: a mention group has first_mention_message_id exactly
--     when it has an unread mention, and it is the lowest-seq one (its seq is
--     at most max_mention_seq). Serving v9 carries it on every row that is not
--     mention_only. Rows that disagree; must be 0.
SELECT 'mention v7 / serving v9 anchors that disagree' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_mention_v7
    WHERE (mention_unread > 0) <> (first_mention_message_id IS NOT NULL)) AS mention_v7,
  (SELECT COUNT(*) FROM rw_inbox_mention_v7 AS mn
     JOIN rw_message_preview_v1 AS m ON m.id = mn.first_mention_message_id
    WHERE m.seq > mn.max_mention_seq) AS mention_v7_order,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9
    WHERE has_mention AND NOT mention_only AND first_mention_message_id IS NULL) AS serving_member,
  (SELECT COUNT(*) FROM rw_inbox_serving_v9
    WHERE mention_only AND first_mention_message_id IS NOT NULL) AS serving_mention_only;
