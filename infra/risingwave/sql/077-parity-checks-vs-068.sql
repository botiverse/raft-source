-- Checks for 077 when it replaces the 068 generation directly, with 076's
-- serving_v7 / totals_v5 never built: the same checks
-- as 077-parity-checks.sql with serving_v7 -> serving_v6 and totals_v5 ->
-- totals_v4. serving_v6 (068) and serving_v7 (076) both read
-- rw_activity_watermark_v5, so the watermark comparisons are unchanged.
--
-- This is only valid if the 068 chain and 076's base agree. Where 076 is built
-- in full, 076-parity-checks.sql shows it (serving v6 vs v7 = 0); a cluster
-- that skipped serving_v7 has not run that. Check 0 does it on the shared base
-- (075 arms, items_v10 vs items_v11), which such a cluster does have. Run it
-- first; if it is not
-- 0 in both directions (after a re-run), stop: a v8-vs-v6 difference could no
-- longer be attributed to 077.
--
-- Run BEFORE the rename, against the _build names (serving_v8_build,
-- totals_v6_build, watermark_v6_build, agent_inbox_v6_build): after the rename
-- the server already reads the new generation, so the check no longer gates
-- anything.
--
-- Every query is a full batch scan of both generations. On a cluster with real
-- data run them one at a time, with a statement_timeout, in the build window,
-- and stop when the cluster shows overload (>=3 rw_overloaded/min or barrier
-- p50 >1s for 2 min).
--
-- Both sides update concurrently, so a small transient count can appear on a
-- busy server: re-run; a real defect persists. Every query must report 0.

-- 0. 068 and 075/076 agree (what 076-parity-checks.sql checks where 076 is built in full):
--    the three 075 arms, then items (so a non-zero items count points at the
--    arm that differs), then agent_inbox, which is renamed first and so must
--    pass before that rename.
SELECT 'rw_inbox_normal_v4 vs rw_inbox_normal_v5' AS check_name,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_normal_v4 EXCEPT SELECT * FROM rw_inbox_normal_v5) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_normal_v5 EXCEPT SELECT * FROM rw_inbox_normal_v4) AS d) AS only_new;
-- Skip where rw_inbox_muted_full_v2 does not exist (077 does not read it).
SELECT 'rw_inbox_muted_full_v1 vs rw_inbox_muted_full_v2' AS check_name,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_full_v1 EXCEPT SELECT * FROM rw_inbox_muted_full_v2) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_full_v2 EXCEPT SELECT * FROM rw_inbox_muted_full_v1) AS d) AS only_new;
SELECT 'rw_inbox_muted_prefix_v1 vs rw_inbox_muted_prefix_v2' AS check_name,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_prefix_v1 EXCEPT SELECT * FROM rw_inbox_muted_prefix_v2) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_prefix_v2 EXCEPT SELECT * FROM rw_inbox_muted_prefix_v1) AS d) AS only_new;
SELECT 'rw_inbox_items_v10 vs rw_inbox_items_v11' AS check_name,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_items_v10 EXCEPT SELECT * FROM rw_inbox_items_v11) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_items_v11 EXCEPT SELECT * FROM rw_inbox_items_v10) AS d) AS only_new;
SELECT 'rw_agent_inbox_v5 vs rw_agent_inbox_v6_build' AS check_name,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v5 EXCEPT SELECT * FROM rw_agent_inbox_v6_build) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v6_build EXCEPT SELECT * FROM rw_agent_inbox_v5) AS d) AS only_new;

-- 1. Nothing appears in serving v8 that v6 did not have, except for a receiver
--    at the 500-target cap whose watermark moved: the removed threads freed
--    ranked slots, so an older row can come back into the window. That is the
--    intended effect of watermark v6, not a defect.
SELECT 'serving v8 rows not in v6 (watermark unchanged)' AS check_name,
  (SELECT COUNT(*)
     FROM (SELECT * FROM rw_inbox_serving_v8_build EXCEPT SELECT * FROM rw_inbox_serving_v6) AS d
     LEFT JOIN rw_activity_watermark_v5 AS w5
       ON w5.receiver_type = d.receiver_type AND w5.receiver_id = d.receiver_id AND w5.server_id = d.server_id
     LEFT JOIN rw_activity_watermark_v6_build AS w6
       ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
    WHERE w5.watermark_seq IS NOT DISTINCT FROM w6.watermark_seq) AS n;

-- 2. Every row v6 has and v8 does not is a thread below a parent that is
--    missing, deleted, archived, or not visible to the receiver.
SELECT 'serving v6-only rows that are not threads below an unavailable parent' AS check_name,
  (SELECT COUNT(*)
     FROM (SELECT * FROM rw_inbox_serving_v6 EXCEPT SELECT * FROM rw_inbox_serving_v8_build) AS d
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
  (SELECT COUNT(*) FROM rw_inbox_serving_v8_build AS i
     JOIN rw_channels AS pc ON pc.id = i.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON i.receiver_type = 'user' AND pch.channel_id = i.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = i.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON i.receiver_type = 'agent' AND pca.channel_id = i.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = i.receiver_id
    WHERE i.kind = 'thread' AND NOT i.mention_only
      AND (pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
           OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL))) AS n;
SELECT 'serving v8 threads below an unavailable parent (mention-only)' AS check_name,
  (SELECT COUNT(*) FROM rw_inbox_serving_v8_build AS i
     JOIN rw_channels AS pc ON pc.id = i.parent_channel_id
     LEFT JOIN rw_channel_humans AS pch
       ON i.receiver_type = 'user' AND pch.channel_id = i.parent_channel_id AND CAST(pch.user_id AS VARCHAR) = i.receiver_id
     LEFT JOIN rw_channel_agents AS pca
       ON i.receiver_type = 'agent' AND pca.channel_id = i.parent_channel_id AND CAST(pca.agent_id AS VARCHAR) = i.receiver_id
    WHERE i.kind = 'thread' AND i.mention_only
      AND (pc.deleted_at IS NOT NULL OR pc.archived_at IS NOT NULL
           OR (pc.type <> 'channel' AND pch.user_id IS NULL AND pca.agent_id IS NULL))) AS n;

-- 4. Only once rw_conversation_unread_v3 is built (it is built separately and
--    may not exist yet; skip this query until it does; before its own rename,
--    use rw_conversation_unread_v3_build). The sidebar
--    (unchanged by 077) already drops them:
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
     FROM (SELECT * FROM rw_activity_totals_v4 EXCEPT SELECT * FROM rw_activity_totals_v6_build) AS d
     LEFT JOIN rw_activity_watermark_v5 AS w5
       ON w5.receiver_type = d.receiver_type AND w5.receiver_id = d.receiver_id AND w5.server_id = d.server_id
     LEFT JOIN rw_activity_watermark_v6_build AS w6
       ON w6.receiver_type = d.receiver_type AND w6.receiver_id = d.receiver_id AND w6.server_id = d.server_id
    -- Parenthesized: RisingWave binds IS NOT DISTINCT FROM looser than AND, so
    -- without them this parsed as seq IS NOT DISTINCT FROM (seq AND NOT EXISTS ...).
    WHERE (w5.watermark_seq IS NOT DISTINCT FROM w6.watermark_seq)
      AND NOT EXISTS (
      SELECT 1 FROM (SELECT * FROM rw_inbox_serving_v6 EXCEPT SELECT * FROM rw_inbox_serving_v8_build) AS r
       WHERE r.receiver_type = d.receiver_type AND r.receiver_id = d.receiver_id AND r.server_id = d.server_id)) AS n;
