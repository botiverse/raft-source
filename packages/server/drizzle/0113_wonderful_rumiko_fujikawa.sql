ALTER TABLE "message_mentions" ADD COLUMN "notifiable_at_send" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD COLUMN "notified_by_type" text;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD COLUMN "notified_by_id" uuid;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD COLUMN "notified_action" text;--> statement-breakpoint
CREATE OR REPLACE VIEW pg_user_channel_mentions_v1 AS
SELECT
  mm.target_id::text AS user_id,
  mm.channel_id::text AS channel_id,
  count(*)::int AS mention_count
FROM message_mentions AS mm
WHERE mm.target_type = 'user'
  AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
GROUP BY mm.target_id, mm.channel_id;--> statement-breakpoint
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
  AND (mm.notifiable_at_send OR mm.notified_at IS NOT NULL)
  AND mm.message_seq > COALESCE(rc.last_read_seq, 0)
GROUP BY mm.target_id, mm.channel_id, COALESCE(rc.last_read_seq, 0);
--> statement-breakpoint
CREATE OR REPLACE VIEW pg_inbox_items_v2 AS
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
notified_public_mentions AS (
  SELECT
    c.server_id::text AS server_id,
    latest_mention.user_id::text AS user_id,
    c.id::text AS channel_id,
    latest_mention.latest_mention_seq
  FROM (
    SELECT
      mm.target_id AS user_id,
      mm.channel_id,
      max(mm.message_seq) AS latest_mention_seq
    FROM message_mentions AS mm
    JOIN channels AS mention_channel
      ON mention_channel.id = mm.channel_id
    LEFT JOIN channel_humans AS existing_member
      ON existing_member.channel_id = mm.channel_id
     AND existing_member.user_id = mm.target_id
    LEFT JOIN user_channel_inbox_states AS inbox
      ON inbox.channel_id = mm.channel_id
     AND inbox.user_id = mm.target_id
    WHERE mm.target_type = 'user'
      AND mm.notified_at IS NOT NULL
      AND mention_channel.type = 'channel'
      AND mention_channel.deleted_at IS NULL
      AND mention_channel.archived_at IS NULL
      AND existing_member.user_id IS NULL
      AND inbox.done_at IS NULL
    GROUP BY mm.target_id, mm.channel_id
  ) AS latest_mention
  JOIN channels AS c
    ON c.id = latest_mention.channel_id
),
notified_public_thread_mentions AS (
  SELECT
    t.server_id::text AS server_id,
    latest_mention.user_id::text AS user_id,
    t.id::text AS thread_channel_id,
    t.parent_message_id::text AS parent_message_id,
    pm.channel_id::text AS parent_channel_id,
    latest_mention.latest_mention_seq
  FROM (
    SELECT
      mm.target_id AS user_id,
      mm.channel_id,
      max(mm.message_seq) AS latest_mention_seq
    FROM message_mentions AS mm
    JOIN channels AS thread_channel
      ON thread_channel.id = mm.channel_id
    JOIN messages AS parent_message
      ON parent_message.id = thread_channel.parent_message_id
    JOIN channels AS parent_channel
      ON parent_channel.id = parent_message.channel_id
    LEFT JOIN thread_follows AS existing_follow
      ON existing_follow.thread_channel_id = mm.channel_id
     AND existing_follow.follower_type = 'user'
     AND existing_follow.follower_id = mm.target_id
     AND existing_follow.done_at IS NULL
     AND existing_follow.unfollowed_at IS NULL
    WHERE mm.target_type = 'user'
      AND mm.notified_at IS NOT NULL
      AND thread_channel.type = 'thread'
      AND thread_channel.deleted_at IS NULL
      AND parent_channel.type = 'channel'
      AND parent_channel.archived_at IS NULL
      AND parent_channel.deleted_at IS NULL
      AND existing_follow.thread_channel_id IS NULL
    GROUP BY mm.target_id, mm.channel_id
  ) AS latest_mention
  JOIN channels AS t
    ON t.id = latest_mention.channel_id
  JOIN messages AS pm
    ON pm.id = t.parent_message_id
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
    latest.created_at AS activity_at,
    false AS mention_only
  FROM eligible_chats AS c
  JOIN pg_channel_latest_message_v1 AS latest
    ON latest.channel_id = c.channel_id
  UNION ALL
  SELECT
    m.server_id,
    m.user_id,
    'channel' AS kind,
    m.channel_id AS source_channel_id,
    NULL::text AS parent_message_id,
    NULL::text AS parent_channel_id,
    m.latest_mention_seq AS latest_seq,
    mention_message.created_at AS activity_at,
    true AS mention_only
  FROM notified_public_mentions AS m
  JOIN messages AS mention_message
    ON mention_message.channel_id::text = m.channel_id
   AND mention_message.seq = m.latest_mention_seq
  UNION ALL
  SELECT
    t.server_id,
    t.user_id,
    'thread' AS kind,
    t.thread_channel_id AS source_channel_id,
    t.parent_message_id,
    t.parent_channel_id,
    t.latest_mention_seq AS latest_seq,
    mention_message.created_at AS activity_at,
    true AS mention_only
  FROM notified_public_thread_mentions AS t
  JOIN messages AS mention_message
    ON mention_message.channel_id::text = t.thread_channel_id
   AND mention_message.seq = t.latest_mention_seq
  UNION ALL
  SELECT
    t.server_id,
    t.user_id,
    'thread' AS kind,
    t.thread_channel_id AS source_channel_id,
    t.parent_message_id,
    t.parent_channel_id,
    latest.latest_seq,
    COALESCE(latest.created_at, pm.created_at) AS activity_at,
    false AS mention_only
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
  CASE WHEN b.mention_only THEN mention_message.id::text ELSE latest.message_id END AS last_message_id,
  CASE WHEN b.mention_only THEN mention_message.id::text ELSE first_unread.id::text END AS first_unread_message_id,
  CASE WHEN b.mention_only THEN mention_message.created_at ELSE latest.created_at END AS last_message_at,
  CASE WHEN b.mention_only THEN mention_message.content ELSE latest.content END AS last_message_preview,
  CASE WHEN b.mention_only THEN mention_message.sender_type ELSE latest.sender_type END AS last_message_sender_type,
  CASE WHEN b.mention_only THEN mention_message.sender_id ELSE latest.sender_id END AS last_message_sender_id,
  CASE WHEN b.mention_only THEN 0 ELSE COALESCE(tu.unread_count, cu.unread_count, 0)::int END AS unread_count,
  CASE WHEN b.kind = 'thread' THEN b.source_channel_id ELSE NULL::text END AS thread_channel_id,
  b.parent_message_id,
  b.parent_channel_id,
  parent_ch.name AS parent_channel_name,
  parent_ch.type::text AS parent_channel_type,
  parent_message.content AS parent_message_preview,
  parent_message.sender_type AS parent_message_sender_type,
  parent_message.sender_id AS parent_message_sender_id,
  CASE WHEN b.mention_only THEN mention_message.content ELSE COALESCE(latest.content, parent_message.content) END AS latest_activity_preview,
  CASE WHEN b.mention_only THEN mention_message.sender_type ELSE COALESCE(latest.sender_type, parent_message.sender_type) END AS latest_activity_sender_type,
  CASE WHEN b.mention_only THEN mention_message.sender_id ELSE COALESCE(latest.sender_id, parent_message.sender_id) END AS latest_activity_sender_id,
  CASE WHEN b.mention_only THEN mention_message.id::text ELSE COALESCE(latest.message_id, parent_message.id::text) END AS latest_activity_message_id,
  CASE WHEN b.mention_only THEN mention_message.created_at ELSE COALESCE(latest.created_at, parent_message.created_at) END AS last_activity_at,
  CASE WHEN b.kind = 'thread' THEN CASE WHEN b.mention_only THEN mention_message.created_at ELSE latest.created_at END ELSE NULL::timestamptz END AS last_reply_at,
  CASE WHEN b.kind = 'thread' THEN COALESCE(thread_stats.reply_count, 0)::int ELSE NULL::int END AS reply_count,
  legacy_task.task_number,
  legacy_task.status AS task_status,
  legacy_task.claimed_by_type AS task_claimed_by_type,
  legacy_task.claimed_by_id AS task_claimed_by_id,
  (b.mention_only OR COALESCE(unread_mentions.mention_count, 0) > 0) AS has_mention,
  b.mention_only,
  COALESCE(tu.last_read_seq, cu.last_read_seq, 0) AS last_read_seq,
  b.activity_at,
  (b.mention_only OR COALESCE(all_mentions.mention_count, 0) > 0) AS has_any_mention
FROM base_items AS b
LEFT JOIN channels AS source_ch
  ON source_ch.id::text = b.source_channel_id
LEFT JOIN messages AS parent_message
  ON parent_message.id::text = b.parent_message_id
LEFT JOIN channels AS parent_ch
  ON parent_ch.id::text = b.parent_channel_id
LEFT JOIN pg_channel_latest_message_v1 AS latest
  ON latest.channel_id = b.source_channel_id
LEFT JOIN messages AS mention_message
  ON b.mention_only
 AND mention_message.channel_id::text = b.source_channel_id
 AND mention_message.seq = b.latest_seq
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
