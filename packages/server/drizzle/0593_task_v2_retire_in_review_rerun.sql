-- Task v2: runs 0554_task_v2_retire_in_review again (#wg-task-v2:f7043517,
-- step 3). During 0554's rolling deploy the previous release could still store
-- in_review on a task v2 task after 0554 had run; this release moves those the
-- same way. The release before this one already stores in_progress, so nothing
-- writes them back. Same statements as 0554
-- (taskV2RetireInReviewMigration.test.ts pins that), same locks.
--
-- Idempotent: a run that finds no task v2 task in in_review inserts nothing.
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
