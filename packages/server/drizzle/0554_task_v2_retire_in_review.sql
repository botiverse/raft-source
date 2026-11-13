-- Task v2: in_review is retired for task v2 tasks (tygg + stdrc,
-- #wg-task-v2:f7043517, step 2). From this release a status write asking a
-- task v2 task for in_review stores in_progress (taskService
-- writeCanonicalStatus, taskV2Mode.taskV2StoredStatus); this moves the task v2
-- tasks already in in_review to in_progress the same way: assignee, claimed_at
-- and every other column unchanged, revision bumped and updated_at stamped as
-- every task write does, and one task_events row per task so the timeline
-- says why (actor 'system', actor_id NULL; seq comes from its bigserial).
--
-- A task v2 task here is taskV2Mode.isV2Task over the stored columns: created
-- the v2 way (own_conversation) or already has its conversation
-- (conversation_channel_id). Pre-v2 tasks keep in_review. (The write path also
-- treats a pre-v2 task as task v2 where the request's server has
-- task_v2_conversations_v0 on, since that write gives it its conversation; a
-- flag rollout cannot be read here, so such rows are left as they are.)
--
-- Idempotent: a second run finds no task v2 task in in_review and inserts
-- nothing. Rows written in_review by the previous release after this ran
-- (rolling deploy) are not covered; running the same statement again moves
-- them.
--
-- Locks: ROW EXCLUSIVE on tasks plus the row locks of the rows it updates
-- (only in_review task v2 tasks), and ROW EXCLUSIVE on task_events; the
-- task_events foreign key check's KEY SHARE is on those same tasks rows, already
-- held by this transaction. One scan of tasks, well inside statement_timeout.
--
-- schema-snapshot: unchanged (data only)
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
WITH "retired" AS (
  UPDATE "tasks"
     SET "status" = 'in_progress',
         "revision" = "revision" + 1,
         "updated_at" = now()
   WHERE "status" = 'in_review'
     AND ("own_conversation" OR "conversation_channel_id" IS NOT NULL)
  RETURNING "id"
)
INSERT INTO "task_events" ("id", "task_id", "event_type", "actor_type", "actor_id", "payload", "created_at")
SELECT gen_random_uuid(), "retired"."id", 'status_changed', 'system', NULL,
       '{"from":"in_review","to":"in_progress","reason":"in_review_retired_for_task_v2"}'::jsonb, now()
  FROM "retired"
 ORDER BY "retired"."id";
