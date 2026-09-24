CREATE TEMP TABLE "thread_channel_dedup" AS
WITH ranked_threads AS (
  SELECT
    c.id AS thread_channel_id,
    c.parent_message_id,
    ROW_NUMBER() OVER (
      PARTITION BY c.parent_message_id
      ORDER BY
        stats.last_reply_at DESC NULLS LAST,
        COALESCE(stats.reply_count, 0) DESC,
        c.created_at ASC,
        c.id ASC
    ) AS thread_rank
  FROM "channels" c
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS reply_count,
      MAX(m.created_at) AS last_reply_at
    FROM "messages" m
    WHERE m.channel_id = c.id
  ) stats ON TRUE
  WHERE c.type = 'thread'
    AND c.deleted_at IS NULL
    AND c.parent_message_id IS NOT NULL
)
SELECT
  dup.thread_channel_id AS duplicate_thread_channel_id,
  canon.thread_channel_id AS canonical_thread_channel_id,
  dup.parent_message_id
FROM ranked_threads dup
JOIN ranked_threads canon
  ON canon.parent_message_id = dup.parent_message_id
 AND canon.thread_rank = 1
WHERE dup.thread_rank > 1;--> statement-breakpoint

UPDATE "messages" m
SET "channel_id" = d.canonical_thread_channel_id
FROM "thread_channel_dedup" d
WHERE m.channel_id = d.duplicate_thread_channel_id;--> statement-breakpoint

UPDATE "messages" m
SET "thread_id" = d.canonical_thread_channel_id::text
FROM "thread_channel_dedup" d
WHERE m.thread_id = d.duplicate_thread_channel_id::text;--> statement-breakpoint

UPDATE "attachments" a
SET "channel_id" = d.canonical_thread_channel_id
FROM "thread_channel_dedup" d
WHERE a.channel_id = d.duplicate_thread_channel_id;--> statement-breakpoint

UPDATE "tasks" t
SET "channel_id" = d.canonical_thread_channel_id
FROM "thread_channel_dedup" d
WHERE t.channel_id = d.duplicate_thread_channel_id;--> statement-breakpoint

INSERT INTO "thread_follows" (
  "thread_channel_id",
  "follower_type",
  "follower_id",
  "parent_message_id",
  "reason",
  "created_at",
  "done_at"
)
SELECT
  grouped.thread_channel_id,
  grouped.follower_type,
  grouped.follower_id,
  grouped.parent_message_id,
  grouped.reason,
  grouped.created_at,
  grouped.done_at
FROM (
  SELECT
    d.canonical_thread_channel_id AS thread_channel_id,
    tf.follower_type,
    tf.follower_id,
    d.parent_message_id,
    (ARRAY_AGG(tf.reason ORDER BY tf.created_at ASC, tf.reason ASC))[1] AS reason,
    MIN(tf.created_at) AS created_at,
    CASE
      WHEN COUNT(*) FILTER (WHERE tf.done_at IS NULL) > 0 THEN NULL
      ELSE MAX(tf.done_at)
    END AS done_at
  FROM "thread_follows" tf
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = tf.thread_channel_id
  GROUP BY
    d.canonical_thread_channel_id,
    tf.follower_type,
    tf.follower_id,
    d.parent_message_id
) grouped
ON CONFLICT ("thread_channel_id", "follower_type", "follower_id") DO UPDATE
SET
  "parent_message_id" = EXCLUDED.parent_message_id,
  "created_at" = LEAST("thread_follows"."created_at", EXCLUDED.created_at),
  "done_at" = CASE
    WHEN "thread_follows"."done_at" IS NULL OR EXCLUDED.done_at IS NULL THEN NULL
    ELSE GREATEST("thread_follows"."done_at", EXCLUDED.done_at)
  END;--> statement-breakpoint

INSERT INTO "channel_humans" ("channel_id", "user_id", "joined_at")
SELECT
  grouped.channel_id,
  grouped.user_id,
  grouped.joined_at
FROM (
  SELECT
    d.canonical_thread_channel_id AS channel_id,
    ch.user_id,
    MIN(ch.joined_at) AS joined_at
  FROM "channel_humans" ch
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = ch.channel_id
  GROUP BY d.canonical_thread_channel_id, ch.user_id
) grouped
ON CONFLICT ("channel_id", "user_id") DO UPDATE
SET "joined_at" = LEAST("channel_humans"."joined_at", EXCLUDED.joined_at);--> statement-breakpoint

INSERT INTO "channel_agents" ("channel_id", "agent_id", "added_at")
SELECT
  grouped.channel_id,
  grouped.agent_id,
  grouped.added_at
FROM (
  SELECT
    d.canonical_thread_channel_id AS channel_id,
    ca.agent_id,
    MIN(ca.added_at) AS added_at
  FROM "channel_agents" ca
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = ca.channel_id
  GROUP BY d.canonical_thread_channel_id, ca.agent_id
) grouped
ON CONFLICT ("channel_id", "agent_id") DO UPDATE
SET "added_at" = LEAST("channel_agents"."added_at", EXCLUDED.added_at);--> statement-breakpoint

INSERT INTO "user_channel_read_cursors" ("user_id", "channel_id", "last_read_seq", "updated_at")
SELECT
  grouped.user_id,
  grouped.channel_id,
  grouped.last_read_seq,
  grouped.updated_at
FROM (
  SELECT
    ucrc.user_id,
    d.canonical_thread_channel_id AS channel_id,
    MAX(ucrc.last_read_seq) AS last_read_seq,
    MAX(ucrc.updated_at) AS updated_at
  FROM "user_channel_read_cursors" ucrc
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = ucrc.channel_id
  GROUP BY ucrc.user_id, d.canonical_thread_channel_id
) grouped
ON CONFLICT ("user_id", "channel_id") DO UPDATE
SET
  "last_read_seq" = GREATEST("user_channel_read_cursors"."last_read_seq", EXCLUDED.last_read_seq),
  "updated_at" = GREATEST("user_channel_read_cursors"."updated_at", EXCLUDED.updated_at);--> statement-breakpoint

INSERT INTO "agent_channel_read_cursors" ("agent_id", "channel_id", "last_read_seq", "updated_at")
SELECT
  grouped.agent_id,
  grouped.channel_id,
  grouped.last_read_seq,
  grouped.updated_at
FROM (
  SELECT
    acrc.agent_id,
    d.canonical_thread_channel_id AS channel_id,
    MAX(acrc.last_read_seq) AS last_read_seq,
    MAX(acrc.updated_at) AS updated_at
  FROM "agent_channel_read_cursors" acrc
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = acrc.channel_id
  GROUP BY acrc.agent_id, d.canonical_thread_channel_id
) grouped
ON CONFLICT ("agent_id", "channel_id") DO UPDATE
SET
  "last_read_seq" = GREATEST("agent_channel_read_cursors"."last_read_seq", EXCLUDED.last_read_seq),
  "updated_at" = GREATEST("agent_channel_read_cursors"."updated_at", EXCLUDED.updated_at);--> statement-breakpoint

INSERT INTO "user_channel_inbox_states" ("user_id", "channel_id", "done_at", "updated_at")
SELECT
  grouped.user_id,
  grouped.channel_id,
  grouped.done_at,
  grouped.updated_at
FROM (
  SELECT
    ucis.user_id,
    d.canonical_thread_channel_id AS channel_id,
    CASE
      WHEN COUNT(*) FILTER (WHERE ucis.done_at IS NULL) > 0 THEN NULL
      ELSE MAX(ucis.done_at)
    END AS done_at,
    MAX(ucis.updated_at) AS updated_at
  FROM "user_channel_inbox_states" ucis
  JOIN "thread_channel_dedup" d
    ON d.duplicate_thread_channel_id = ucis.channel_id
  GROUP BY ucis.user_id, d.canonical_thread_channel_id
) grouped
ON CONFLICT ("user_id", "channel_id") DO UPDATE
SET
  "done_at" = CASE
    WHEN "user_channel_inbox_states"."done_at" IS NULL OR EXCLUDED.done_at IS NULL THEN NULL
    ELSE GREATEST("user_channel_inbox_states"."done_at", EXCLUDED.done_at)
  END,
  "updated_at" = GREATEST("user_channel_inbox_states"."updated_at", EXCLUDED.updated_at);--> statement-breakpoint

UPDATE "messages" pm
SET "thread_id" = d.canonical_thread_channel_id::text
FROM "thread_channel_dedup" d
WHERE pm.id = d.parent_message_id;--> statement-breakpoint

UPDATE "channels" c
SET "deleted_at" = COALESCE(c.deleted_at, NOW())
FROM "thread_channel_dedup" d
WHERE c.id = d.duplicate_thread_channel_id;--> statement-breakpoint

DROP TABLE "thread_channel_dedup";--> statement-breakpoint

CREATE UNIQUE INDEX "idx_channels_active_thread_parent"
ON "channels" USING btree ("parent_message_id")
WHERE type = 'thread' AND deleted_at IS NULL;
