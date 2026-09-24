-- Matching RisingWave MVs live in infra/risingwave/sql/024-risingwave-unread-inbox-full-materialized.sql.
-- Any semantic change to these PG views must be mirrored there and parity-checked.
CREATE OR REPLACE VIEW pg_channel_latest_message_v1 AS
SELECT
  channel_id::text AS channel_id,
  id::text AS message_id,
  seq AS latest_seq,
  content,
  sender_type,
  sender_id,
  created_at
FROM (
  SELECT
    m.channel_id,
    m.id,
    m.seq,
    m.content,
    m.sender_type,
    m.sender_id,
    m.created_at,
    row_number() OVER (PARTITION BY m.channel_id ORDER BY m.seq DESC, m.id DESC) AS rn
  FROM messages AS m
) ranked
WHERE rn = 1;
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_thread_activity_stats_v1 AS
SELECT
  t.id::text AS thread_channel_id,
  count(m.id)::int AS reply_count,
  max(m.created_at) AS last_reply_at,
  latest.message_id AS latest_message_id,
  latest.content AS latest_preview,
  latest.sender_type AS latest_sender_type,
  latest.sender_id AS latest_sender_id
FROM channels AS t
LEFT JOIN messages AS m
  ON m.channel_id = t.id
LEFT JOIN pg_channel_latest_message_v1 AS latest
  ON latest.channel_id = t.id::text
WHERE t.type = 'thread'
  AND t.deleted_at IS NULL
GROUP BY
  t.id,
  latest.message_id,
  latest.content,
  latest.sender_type,
  latest.sender_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_user_channel_unread_v1 AS
SELECT
  ch.user_id::text AS user_id,
  c.server_id::text AS server_id,
  c.id::text AS channel_id,
  COALESCE(rc.last_read_seq, 0) AS last_read_seq,
  count(m.id)::int AS unread_count,
  min(m.seq) AS first_unread_seq
FROM channel_humans AS ch
JOIN channels AS c
  ON c.id = ch.channel_id
LEFT JOIN user_channel_read_cursors AS rc
  ON rc.channel_id = c.id
 AND rc.user_id = ch.user_id
LEFT JOIN messages AS m
  ON m.channel_id = c.id
 AND m.seq > COALESCE(rc.last_read_seq, 0)
 AND NOT (m.sender_type = 'user' AND m.sender_id = ch.user_id::text)
WHERE c.deleted_at IS NULL
  AND c.archived_at IS NULL
  AND c.type IN ('channel', 'private', 'dm')
GROUP BY ch.user_id, c.server_id, c.id, COALESCE(rc.last_read_seq, 0);
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_sidebar_unread_summary_v1 AS
SELECT
  user_id,
  server_id,
  sum(unread_count)::int AS unread_count
FROM pg_user_channel_unread_v1
WHERE unread_count > 0
GROUP BY user_id, server_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_user_thread_unread_v1 AS
SELECT
  tf.follower_id::text AS user_id,
  t.server_id::text AS server_id,
  t.id::text AS thread_channel_id,
  COALESCE(rc.last_read_seq, 0) AS last_read_seq,
  count(m.id)::int AS unread_count,
  min(m.seq) AS first_unread_seq
FROM thread_follows AS tf
JOIN channels AS t
  ON t.id = tf.thread_channel_id
LEFT JOIN user_channel_read_cursors AS rc
  ON rc.channel_id = t.id
 AND rc.user_id = tf.follower_id
LEFT JOIN messages AS m
  ON m.channel_id = t.id
 AND m.seq > COALESCE(rc.last_read_seq, 0)
 AND NOT (m.sender_type = 'user' AND m.sender_id = tf.follower_id::text)
WHERE tf.follower_type = 'user'
  AND tf.done_at IS NULL
  AND tf.unfollowed_at IS NULL
  AND t.type = 'thread'
  AND t.deleted_at IS NULL
GROUP BY tf.follower_id, t.server_id, t.id, COALESCE(rc.last_read_seq, 0);
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_user_channel_mentions_v1 AS
SELECT
  mm.target_id::text AS user_id,
  mm.channel_id::text AS channel_id,
  count(*)::int AS mention_count
FROM message_mentions AS mm
WHERE mm.target_type = 'user'
GROUP BY mm.target_id, mm.channel_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_user_channel_unread_mentions_v1 AS
SELECT
  mm.target_id::text AS user_id,
  mm.channel_id::text AS channel_id,
  COALESCE(rc.last_read_seq, 0) AS last_read_seq,
  count(*)::int AS mention_count
FROM message_mentions AS mm
LEFT JOIN user_channel_read_cursors AS rc
  ON rc.channel_id = mm.channel_id
 AND rc.user_id = mm.target_id
WHERE mm.target_type = 'user'
  AND mm.message_seq > COALESCE(rc.last_read_seq, 0)
GROUP BY mm.target_id, mm.channel_id, COALESCE(rc.last_read_seq, 0);
--> statement-breakpoint

CREATE OR REPLACE VIEW pg_inbox_items_v1 AS
WITH eligible_chats AS (
  SELECT
    c.server_id::text AS server_id,
    ch.user_id::text AS user_id,
    c.id::text AS channel_id,
    CASE WHEN c.type = 'dm' THEN 'dm' ELSE 'channel' END AS item_type
  FROM channels AS c
  JOIN channel_humans AS ch
    ON ch.channel_id = c.id
  LEFT JOIN user_channel_inbox_states AS inbox
    ON inbox.channel_id = c.id
   AND inbox.user_id = ch.user_id
  WHERE c.type IN ('channel', 'private', 'dm')
    AND c.deleted_at IS NULL
    AND c.archived_at IS NULL
    AND inbox.done_at IS NULL
),
followed_threads AS (
  SELECT
    t.server_id::text AS server_id,
    tf.follower_id::text AS user_id,
    t.id::text AS thread_channel_id,
    t.parent_message_id::text AS parent_message_id,
    pm.channel_id::text AS parent_channel_id
  FROM thread_follows AS tf
  JOIN channels AS t
    ON t.id = tf.thread_channel_id
   AND t.type = 'thread'
   AND t.deleted_at IS NULL
  JOIN messages AS pm
    ON pm.id = t.parent_message_id
  JOIN channels AS parent_ch
    ON parent_ch.id = pm.channel_id
   AND parent_ch.archived_at IS NULL
  WHERE tf.follower_type = 'user'
    AND tf.done_at IS NULL
    AND tf.unfollowed_at IS NULL
),
base_items AS (
  SELECT
    c.server_id,
    c.user_id,
    c.item_type AS kind,
    c.channel_id AS source_channel_id,
    NULL::text AS parent_message_id,
    NULL::text AS parent_channel_id,
    latest.latest_seq,
    latest.created_at AS activity_at
  FROM eligible_chats AS c
  JOIN pg_channel_latest_message_v1 AS latest
    ON latest.channel_id = c.channel_id
  UNION ALL
  SELECT
    t.server_id,
    t.user_id,
    'thread' AS kind,
    t.thread_channel_id AS source_channel_id,
    t.parent_message_id,
    t.parent_channel_id,
    latest.latest_seq,
    COALESCE(latest.created_at, pm.created_at) AS activity_at
  FROM followed_threads AS t
  JOIN messages AS pm
    ON pm.id::text = t.parent_message_id
  LEFT JOIN pg_channel_latest_message_v1 AS latest
    ON latest.channel_id = t.thread_channel_id
)
SELECT
  b.server_id,
  b.user_id,
  b.kind,
  CASE WHEN b.kind = 'thread' THEN NULL::text ELSE b.source_channel_id END AS channel_id,
  CASE WHEN b.kind = 'thread' THEN NULL::text ELSE source_ch.name END AS channel_name,
  CASE WHEN b.kind = 'thread' THEN NULL::text ELSE source_ch.type::text END AS channel_type,
  latest.message_id AS last_message_id,
  first_unread.id::text AS first_unread_message_id,
  latest.created_at AS last_message_at,
  latest.content AS last_message_preview,
  latest.sender_type AS last_message_sender_type,
  latest.sender_id AS last_message_sender_id,
  COALESCE(tu.unread_count, cu.unread_count, 0)::int AS unread_count,
  CASE WHEN b.kind = 'thread' THEN b.source_channel_id ELSE NULL::text END AS thread_channel_id,
  b.parent_message_id,
  b.parent_channel_id,
  parent_ch.name AS parent_channel_name,
  parent_ch.type::text AS parent_channel_type,
  parent_message.content AS parent_message_preview,
  parent_message.sender_type AS parent_message_sender_type,
  parent_message.sender_id AS parent_message_sender_id,
  COALESCE(latest.content, parent_message.content) AS latest_activity_preview,
  COALESCE(latest.sender_type, parent_message.sender_type) AS latest_activity_sender_type,
  COALESCE(latest.sender_id, parent_message.sender_id) AS latest_activity_sender_id,
  COALESCE(latest.message_id, parent_message.id::text) AS latest_activity_message_id,
  COALESCE(latest.created_at, parent_message.created_at) AS last_activity_at,
  CASE WHEN b.kind = 'thread' THEN latest.created_at ELSE NULL::timestamptz END AS last_reply_at,
  CASE WHEN b.kind = 'thread' THEN COALESCE(thread_stats.reply_count, 0)::int ELSE NULL::int END AS reply_count,
  legacy_task.task_number,
  legacy_task.status AS task_status,
  legacy_task.claimed_by_type AS task_claimed_by_type,
  legacy_task.claimed_by_id AS task_claimed_by_id,
  COALESCE(unread_mentions.mention_count, 0) > 0 AS has_mention,
  COALESCE(tu.last_read_seq, cu.last_read_seq, 0) AS last_read_seq,
  b.activity_at,
  COALESCE(all_mentions.mention_count, 0) > 0 AS has_any_mention
FROM base_items AS b
LEFT JOIN channels AS source_ch
  ON source_ch.id::text = b.source_channel_id
LEFT JOIN messages AS parent_message
  ON parent_message.id::text = b.parent_message_id
LEFT JOIN channels AS parent_ch
  ON parent_ch.id::text = b.parent_channel_id
LEFT JOIN pg_channel_latest_message_v1 AS latest
  ON latest.channel_id = b.source_channel_id
LEFT JOIN pg_user_channel_unread_v1 AS cu
  ON b.kind <> 'thread'
 AND cu.user_id = b.user_id
 AND cu.channel_id = b.source_channel_id
LEFT JOIN pg_user_thread_unread_v1 AS tu
  ON b.kind = 'thread'
 AND tu.user_id = b.user_id
 AND tu.thread_channel_id = b.source_channel_id
LEFT JOIN messages AS first_unread
  ON first_unread.channel_id::text = b.source_channel_id
 AND first_unread.seq = COALESCE(tu.first_unread_seq, cu.first_unread_seq)
LEFT JOIN pg_thread_activity_stats_v1 AS thread_stats
  ON b.kind = 'thread'
 AND thread_stats.thread_channel_id = b.source_channel_id
LEFT JOIN tasks AS legacy_task
  ON legacy_task.message_id::text = b.parent_message_id
LEFT JOIN pg_user_channel_mentions_v1 AS all_mentions
  ON all_mentions.user_id = b.user_id
 AND all_mentions.channel_id = b.source_channel_id
LEFT JOIN pg_user_channel_unread_mentions_v1 AS unread_mentions
  ON unread_mentions.user_id = b.user_id
 AND unread_mentions.channel_id = b.source_channel_id;
