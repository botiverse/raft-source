-- Read-only staging checks; execute each SELECT separately after CDC settles.
-- No DDL, parameter changes, fixture writes or content values are returned.
-- Existing operator supplies a 30s query deadline; timeout is NOT success.
-- Every violations count must be zero, with meaningful rows checked.

-- 1. Preview joins must not multiply rows. Null identifiers also block.
SELECT 'full_preview_seq_key' AS check_name, COUNT(*) AS violations
FROM (SELECT seq FROM rw_message_preview_v1 GROUP BY seq
      HAVING seq IS NULL OR COUNT(*)<>1) d
UNION ALL
SELECT 'full_preview_id_key', COUNT(*)
FROM (SELECT id FROM rw_message_preview_v1 GROUP BY id
      HAVING id IS NULL OR COUNT(*)<>1) d
UNION ALL
SELECT 'new_preview_seq_key', COUNT(*)
FROM (SELECT seq FROM rw_inbox_preview_seq_jcm_v1 GROUP BY seq
      HAVING seq IS NULL OR COUNT(*)<>1) d
UNION ALL
SELECT 'parent_preview_id_key', COUNT(*)
FROM (SELECT id FROM rw_inbox_preview_parent_v1 GROUP BY id
      HAVING id IS NULL OR COUNT(*)<>1) d;

-- 2. Independently reconstruct ALL demanded sequences, including fallback
-- target_latest and muted/latest conversation paths, not just sampled users.
-- Equality plus check 1 proves the lookup preserves each full-preview join.
WITH needed AS (
 SELECT seq FROM (
  SELECT latest_seq AS seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT first_unread_seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT max_mention_seq FROM rw_inbox_items_jcm_v1
  UNION ALL SELECT first_unread_seq FROM rw_task_conversation_unread_jcm_v1
  UNION ALL SELECT latest_seq FROM rw_target_latest_v4
  UNION ALL SELECT latest_seq FROM rw_inbox_normal_jcm_v1
  UNION ALL SELECT latest_seq FROM rw_inbox_muted_full_jcm_v1
 ) s WHERE seq IS NOT NULL GROUP BY seq
), expected AS (
 SELECT p.seq,p.id,p.preview,p.sender_type,p.sender_id,p.created_at
 FROM needed n JOIN rw_message_preview_v1 p ON p.seq=n.seq
), compared AS (
 SELECT e.seq AS expected_seq,a.seq AS actual_seq,
  e.seq IS NULL OR a.seq IS NULL
  OR e.id IS DISTINCT FROM a.id OR e.preview IS DISTINCT FROM a.preview
  OR e.sender_type IS DISTINCT FROM a.sender_type
  OR e.sender_id IS DISTINCT FROM a.sender_id
  OR e.created_at IS DISTINCT FROM a.created_at AS mismatch
 FROM expected e FULL JOIN rw_inbox_preview_seq_jcm_v1 a ON a.seq=e.seq
)
SELECT 'sequence_preview_equivalence' AS check_name, COUNT(*) AS rows_checked,
 COUNT(*) FILTER (WHERE mismatch) AS violations FROM compared;

-- 3. Parent ids are deduplicated before joining the full message projection.
WITH ids AS (
 SELECT parent_message_id FROM rw_conversation_parent_v1
 WHERE parent_message_id IS NOT NULL GROUP BY parent_message_id
), expected AS (
 SELECT p.id,p.seq,p.preview,p.sender_type,p.sender_id,p.created_at
 FROM ids n JOIN rw_message_preview_v1 p ON p.id=n.parent_message_id
), compared AS (
 SELECT e.id IS NULL OR a.id IS NULL
  OR e.seq IS DISTINCT FROM a.seq OR e.preview IS DISTINCT FROM a.preview
  OR e.sender_type IS DISTINCT FROM a.sender_type
  OR e.sender_id IS DISTINCT FROM a.sender_id
  OR e.created_at IS DISTINCT FROM a.created_at AS mismatch
 FROM expected e FULL JOIN rw_inbox_preview_parent_v1 a ON a.id=e.id
)
SELECT 'parent_preview_equivalence' AS check_name, COUNT(*) AS rows_checked,
 COUNT(*) FILTER (WHERE mismatch) AS violations FROM compared;

-- 4. The live conversation still consumes muted_full_v1, whereas 081 uses
-- the v2 aggregate shape. Compare EXISTING v1/v2 over the SAME old subs first;
-- comparing new membership here would conflate the intentional membership fix.
SELECT 'muted_full_v1_key' AS check_name,COUNT(*) AS violations
FROM (SELECT kind,receiver_type,receiver_id,target_id FROM rw_inbox_muted_full_v1
 GROUP BY kind,receiver_type,receiver_id,target_id HAVING COUNT(*)<>1) d
UNION ALL
SELECT 'muted_full_v2_key',COUNT(*)
FROM (SELECT kind,receiver_type,receiver_id,target_id FROM rw_inbox_muted_full_v2
 GROUP BY kind,receiver_type,receiver_id,target_id HAVING COUNT(*)<>1) d;

WITH compared AS (
 SELECT o.receiver_id IS NULL OR n.receiver_id IS NULL
  OR o.server_id IS DISTINCT FROM n.server_id
  OR o.done_at IS DISTINCT FROM n.done_at
  OR o.joined_at IS DISTINCT FROM n.joined_at
  OR o.last_read IS DISTINCT FROM n.last_read
  OR o.latest_seq IS DISTINCT FROM n.latest_seq
  OR o.latest_at IS DISTINCT FROM n.latest_at
  OR o.unread_count IS DISTINCT FROM n.unread_count AS mismatch
 FROM rw_inbox_muted_full_v1 o FULL JOIN rw_inbox_muted_full_v2 n
 ON n.kind=o.kind AND n.receiver_type=o.receiver_type
 AND n.receiver_id=o.receiver_id AND n.target_id=o.target_id
)
SELECT 'muted_full_v1_v2_equivalence' AS check_name,COUNT(*) AS rows_checked,
 COUNT(*) FILTER (WHERE mismatch) AS violations FROM compared;
