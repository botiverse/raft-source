-- Checks for 077. Run after 077 has finished backfilling, next to the
-- 076 generation it replaces. Both sides update concurrently, so a small
-- transient count can appear on a busy server: re-run; a real defect persists.
--
-- 077 is meant to differ from 076 in exactly one way: a thread whose parent is
-- deleted, archived, or not visible to the receiver (a non-public parent the
-- receiver is not a member of) is no longer served. Every query below must
-- report 0.

-- 1. Nothing appears in serving v8 that v7 did not have, except for a receiver
--    at the 500-target cap whose watermark moved: the removed threads freed
--    ranked slots, so an older row can come back into the window. That is the
--    intended effect of watermark v6, not a defect.
SELECT 'serving v8 rows not in v7 (watermark unchanged)' AS check_name,
  (SELECT COUNT(*)
     FROM (SELECT * FROM rw_inbox_serving_v8 EXCEPT SELECT * FROM rw_inbox_serving_v7) AS d
     LEFT JOIN rw_activity_watermark_v5 AS w5
       ON w5.receiver_type = d.receiver_type AND w5.receiver_id = d.receiver_id AND w5.server_id = d.server_id
     LEFT JOIN rw_activity_watermark_v6 AS w6
       ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
    WHERE w5.watermark_seq IS NOT DISTINCT FROM w6.watermark_seq) AS n;

-- 2. Every row v7 has and v8 does not is a thread below a parent that is
--    missing, deleted, archived, or not visible to the receiver.
SELECT 'serving v7-only rows that are not threads below an unavailable parent' AS check_name,
  (SELECT COUNT(*)
     FROM (SELECT * FROM rw_inbox_serving_v7 EXCEPT SELECT * FROM rw_inbox_serving_v8) AS d
     LEFT JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = d.thread_channel_id
     LEFT JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON d.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = d.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON d.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = d.receiver_id
    WHERE NOT (d.kind = 'thread'
               AND (pc.id IS NULL OR pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
                    OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL)))) AS n;

-- 3. Serving v8 has no thread below an unavailable parent: followed, or
--    mention-only (a leftover unread mention from before the parent went away).
SELECT 'serving v8 threads below an unavailable parent (followed)' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_serving_v8 AS i
     JOIN rw_channels AS pc ON pc.id = i.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON i.receiver_type = 'user' AND pch.channel_id = i.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = i.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON i.receiver_type = 'agent' AND pca.channel_id = i.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = i.receiver_id
    WHERE i.kind = 'thread' AND NOT i.mention_only
      AND (pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
           OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL))) AS n;
SELECT 'serving v8 threads below an unavailable parent (mention-only)' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_serving_v8 AS i
     JOIN rw_channels AS pc ON pc.id = i.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON i.receiver_type = 'user' AND pch.channel_id = i.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = i.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON i.receiver_type = 'agent' AND pca.channel_id = i.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = i.receiver_id
    WHERE i.kind = 'thread' AND i.mention_only
      AND (pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
           OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL))) AS n;

-- 4. (Skip where rw_conversation_unread_v3 is not built.)
--    The sidebar (rw_conversation_unread_v3, unchanged by 077) already drops them:
--    a thread there needs a live, unarchived parent the receiver can see.
SELECT 'sidebar threads below an unavailable parent' AS check_name,
  (SELECT COUNT(*) FROM rw_conversation_unread_v3 AS u
     JOIN rw_thread_parent_v3 AS tp ON tp.thread_channel_id = u.target_id
     JOIN rw_channels AS pc ON pc.id = tp.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON u.receiver_type = 'user' AND pch.channel_id = tp.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = u.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON u.receiver_type = 'agent' AND pca.channel_id = tp.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = u.receiver_id
    WHERE u.kind = 'thread'
      AND (pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
           OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL))) AS n;

-- 5. Totals change only for receivers who lost a served row (check 2's rows) or
--    whose watermark moved (check 1's exception).
SELECT 'totals v6 differences for receivers without a removed row' AS check_name,
  (SELECT COUNT(*)
     FROM (SELECT * FROM rw_activity_totals_v5 EXCEPT SELECT * FROM rw_activity_totals_v6) AS d
     LEFT JOIN rw_activity_watermark_v5 AS w5
       ON w5.receiver_type = d.receiver_type AND w5.receiver_id = d.receiver_id AND w5.server_id = d.server_id
     LEFT JOIN rw_activity_watermark_v6 AS w6
       ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
    -- Parenthesized: RisingWave binds IS NOT DISTINCT FROM looser than AND, so
    -- without them this parsed as seq IS NOT DISTINCT FROM (seq AND NOT EXISTS ...).
    WHERE (w5.watermark_seq IS NOT DISTINCT FROM w6.watermark_seq)
      AND NOT EXISTS (
      SELECT 1 FROM (SELECT * FROM rw_inbox_serving_v7 EXCEPT SELECT * FROM rw_inbox_serving_v8) AS r
       WHERE r.receiver_type = d.receiver_type AND r.receiver_id = d.receiver_id AND r.server_id = d.server_id)) AS n;
