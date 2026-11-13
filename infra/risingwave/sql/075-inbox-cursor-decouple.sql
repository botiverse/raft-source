-- 075: inbox arms with the read cursor as a JOIN CONDITION instead of a GROUP BY key.
-- Same output columns/semantics as
-- rw_inbox_normal_v4 / rw_inbox_muted_full_v1 / rw_inbox_muted_prefix_v1.
-- A cursor move now retracts/emits only unread rows (seq > cursor) instead of
-- every message of the target. latest_seq/latest_at come from
-- rw_target_latest_v4 (same MAX semantics) joined AFTER the aggregate, so a new
-- message does not re-key subscriber groups.
-- EXPLAIN confirms: StreamHashJoin [LeftOuter] with equi key target_id and
-- condition `seq > COALESCE(last_read_seq, 0)`, no StreamFilter above it. The
-- cursor-free "admitted" join in muted_prefix_v2 is planned as Inner join +
-- stateless Filter (optimizer choice for inner joins; nothing passes it, no writes).

CREATE MATERIALIZED VIEW rw_inbox_normal_v5 AS
WITH unread AS (
  SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
         COALESCE(rc.last_read_seq, 0) AS last_read,
         COUNT(u.seq) FILTER (WHERE NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = s.receiver_type AND u.causal_actor_id = s.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS unread_count,
         MIN(u.seq) FILTER (WHERE NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = s.receiver_type AND u.causal_actor_id = s.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS first_unread_seq
  FROM rw_subs_v2 AS s
  JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
  LEFT JOIN rw_receiver_cursors_v1 AS rc
    ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
  LEFT JOIN rw_message_target_v3 AS u
    ON u.target_id = s.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
  GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq
)
SELECT x.kind, x.receiver_type, x.receiver_id, x.target_id, x.server_id, x.done_at, x.joined_at,
       x.last_read, tl.latest_seq, tl.latest_at, x.unread_count, x.first_unread_seq
FROM unread AS x
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = x.target_id;

-- Muted, full count (sidebar). Same as normal_v5 over rw_muted_subs_v1.
-- Not every environment keeps it.
CREATE MATERIALIZED VIEW rw_inbox_muted_full_v2 AS
WITH unread AS (
  SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
         COALESCE(rc.last_read_seq, 0) AS last_read,
         COUNT(u.seq) FILTER (WHERE NOT (u.sender_type = s.receiver_type AND u.sender_id = s.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = s.receiver_type AND u.causal_actor_id = s.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS unread_count
  FROM rw_muted_subs_v1 AS s
  JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
  LEFT JOIN rw_receiver_cursors_v1 AS rc
    ON rc.receiver_type = s.receiver_type AND rc.receiver_id = s.receiver_id AND rc.channel_id = s.target_id
  LEFT JOIN rw_message_target_v3 AS u
    ON u.target_id = s.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
  GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, rc.last_read_seq
)
SELECT x.kind, x.receiver_type, x.receiver_id, x.target_id, x.server_id, x.done_at, x.joined_at,
       x.last_read, tl.latest_seq, tl.latest_at, x.unread_count
FROM unread AS x
LEFT JOIN rw_target_latest_v4 AS tl ON tl.target_id = x.target_id;

-- Muted, admitted prefix only (seq < mute_from_seq; NULL admits all).
-- Keeps v1's INNER-JOIN rule: no admitted message => NO row (so a mention after
-- the mute surfaces as mention-only). Latest-admitted is cursor-free and, for a
-- non-NULL mute_from_seq, frozen (new messages are past the boundary).
CREATE MATERIALIZED VIEW rw_inbox_muted_prefix_v2 AS
WITH admitted AS (
  SELECT s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at,
         s.mute_from_seq, MAX(m.seq) AS latest_seq, MAX(m.created_at) AS latest_at
  FROM rw_muted_subs_v1 AS s
  JOIN rw_target_eligible_v1 AS g ON g.target_id = s.target_id
  JOIN rw_message_target_v3 AS m
    ON m.target_id = s.target_id AND m.seq < COALESCE(s.mute_from_seq, 9223372036854775807)
  GROUP BY s.kind, s.receiver_type, s.receiver_id, s.target_id, s.server_id, s.done_at, s.joined_at, s.mute_from_seq
), unread AS (
  SELECT a.receiver_type, a.receiver_id, a.target_id,
         COALESCE(rc.last_read_seq, 0) AS last_read,
         COUNT(u.seq) FILTER (WHERE NOT (u.sender_type = a.receiver_type AND u.sender_id = a.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = a.receiver_type AND u.causal_actor_id = a.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS unread_count,
         MIN(u.seq) FILTER (WHERE NOT (u.sender_type = a.receiver_type AND u.sender_id = a.receiver_id)
           AND NOT COALESCE(u.message_type = 'system' AND u.causal_actor_type = a.receiver_type AND u.causal_actor_id = a.receiver_id, FALSE)
           AND (u.system_subtype IS NULL OR u.system_subtype NOT IN ('channel.self_unfollow_thread', 'task.deleted_summary'))
         ) AS first_unread_seq
  FROM rw_muted_subs_v1 AS a
  LEFT JOIN rw_receiver_cursors_v1 AS rc
    ON rc.receiver_type = a.receiver_type AND rc.receiver_id = a.receiver_id AND rc.channel_id = a.target_id
  LEFT JOIN rw_message_target_v3 AS u
    ON u.target_id = a.target_id AND u.seq > COALESCE(rc.last_read_seq, 0)
   AND (a.mute_from_seq IS NULL OR u.seq < a.mute_from_seq)
  GROUP BY a.receiver_type, a.receiver_id, a.target_id, rc.last_read_seq
)
SELECT p.kind, p.receiver_type, p.receiver_id, p.target_id, p.server_id, p.done_at, p.joined_at,
       COALESCE(x.last_read, 0) AS last_read, p.latest_seq, p.latest_at,
       COALESCE(x.unread_count, 0) AS unread_count, x.first_unread_seq
FROM admitted AS p
LEFT JOIN unread AS x
  ON x.receiver_type = p.receiver_type AND x.receiver_id = p.receiver_id AND x.target_id = p.target_id;
