-- Parity checks for 075/076 against the generation they replace. Run after both
-- generations have finished backfilling. Every row must report 0 in both
-- directions. Both sides update concurrently, so a small transient count can
-- appear on a busy server: re-run; a real defect persists across runs.

SELECT 'rw_inbox_normal_v4 vs rw_inbox_normal_v5' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_normal_v4 EXCEPT SELECT * FROM rw_inbox_normal_v5) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_normal_v5 EXCEPT SELECT * FROM rw_inbox_normal_v4) AS d) AS only_new;

-- Skip where rw_inbox_muted_full_v2 does not exist.
SELECT 'rw_inbox_muted_full_v1 vs rw_inbox_muted_full_v2' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_full_v1 EXCEPT SELECT * FROM rw_inbox_muted_full_v2) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_full_v2 EXCEPT SELECT * FROM rw_inbox_muted_full_v1) AS d) AS only_new;

SELECT 'rw_inbox_muted_prefix_v1 vs rw_inbox_muted_prefix_v2' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_prefix_v1 EXCEPT SELECT * FROM rw_inbox_muted_prefix_v2) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_muted_prefix_v2 EXCEPT SELECT * FROM rw_inbox_muted_prefix_v1) AS d) AS only_new;

SELECT 'rw_inbox_items_v10 vs rw_inbox_items_v11' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_items_v10 EXCEPT SELECT * FROM rw_inbox_items_v11) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_items_v11 EXCEPT SELECT * FROM rw_inbox_items_v10) AS d) AS only_new;

SELECT 'rw_inbox_serving_v6 vs rw_inbox_serving_v7' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_serving_v6 EXCEPT SELECT * FROM rw_inbox_serving_v7) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_inbox_serving_v7 EXCEPT SELECT * FROM rw_inbox_serving_v6) AS d) AS only_new;

SELECT 'rw_activity_totals_v4 vs rw_activity_totals_v5' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_totals_v4 EXCEPT SELECT * FROM rw_activity_totals_v5) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_activity_totals_v5 EXCEPT SELECT * FROM rw_activity_totals_v4) AS d) AS only_new;

SELECT 'rw_agent_inbox_v5 vs rw_agent_inbox_v6' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v5 EXCEPT SELECT * FROM rw_agent_inbox_v6) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_agent_inbox_v6 EXCEPT SELECT * FROM rw_agent_inbox_v5) AS d) AS only_new;

-- Skip where rw_conversation_unread_v3 is not built.
SELECT 'rw_conversation_unread_v2 vs rw_conversation_unread_v3' AS pair,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_conversation_unread_v2 EXCEPT SELECT * FROM rw_conversation_unread_v3) AS d) AS only_old,
  (SELECT COUNT(*) FROM (SELECT * FROM rw_conversation_unread_v3 EXCEPT SELECT * FROM rw_conversation_unread_v2) AS d) AS only_new;
