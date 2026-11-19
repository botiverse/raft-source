-- RBAC73 staging-only missing predecessor, separately reviewed before use.
-- Exact CREATE from 078; do not execute the rest of 078.
-- One object only. Require absent name, existing/binding direct predecessors,
-- reviewed SHA and fresh capacity/watch baseline. Tenny GO required.
SET BACKGROUND_DDL = true;
SET STREAMING_PARALLELISM = 1;
SET backfill_rate_limit = 1000;

CREATE MATERIALIZED VIEW rw_inbox_preview_parent_v1 AS
SELECT pv.id, pv.seq, pv.preview, pv.sender_type, pv.sender_id, pv.created_at
FROM (
  SELECT parent_message_id FROM rw_conversation_parent_v1
  WHERE parent_message_id IS NOT NULL
  GROUP BY parent_message_id
) AS n
JOIN rw_message_preview_v1 AS pv ON pv.id = n.parent_message_id;
