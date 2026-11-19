-- Task v2 (#wg-task-v2:#24): servers.task_v2_on_since, when the server was
-- first seen with task_v2_conversations_v0 on. Feature flag rules keep no
-- per-server history, so this is its only record. The idle task reminder
-- writes it (only while NULL) the first time it finds the flag on, and chases
-- only tasks with activity since then, so turning task v2 on for everyone,
-- or the later backfill that makes every older task a task v2 task, does not
-- chase every open task at once.
--
-- Servers already on get it from their earliest task v2 task (created with
-- tasks.own_conversation = true): the first task made after the flag went on.
-- This must run before that backfill, which sets own_conversation on every
-- older task and would make this read meaningless. Only servers the flag's
-- `server` allow rules name are read: a whole-table scan of `tasks` (no index
-- on own_conversation) took 23 s on a cold replica (AndyLok,
-- #proj-data:24ef1041), too close to the 30 s statement timeout. Their
-- channels are found through the channels' server index and their tasks
-- through idx_tasks_channel_status. A server on by any other rule, or whose
-- flag went on without a task v2 task since, gets it from the reminder, as a
-- new one.
--
-- The column add is catalog-only. The seed updates at most one `servers` row
-- per allowed server; the lock wait is bounded so a long servers transaction
-- makes the deploy retry instead of queueing reads behind it. Rolling deploy:
-- an older replica neither reads nor writes the column.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "task_v2_on_since" timestamp with time zone;--> statement-breakpoint
UPDATE "servers" AS s
SET "task_v2_on_since" = first_v2."first_created_at"
FROM (
  SELECT c."server_id", min(t."created_at") AS "first_created_at"
  FROM "channels" c
  JOIN "tasks" t ON t."channel_id" = c."id"
  WHERE c."server_id" IN (
    SELECT v."value"::uuid
    FROM "feature_flag_rules" r
    CROSS JOIN LATERAL jsonb_array_elements_text(r."values") AS v("value")
    WHERE r."flag_key" = 'task_v2_conversations_v0' AND r."stage" = 'server' AND r."decision" = 'allow'
      AND v."value" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
    AND t."own_conversation"
  GROUP BY c."server_id"
) AS first_v2
WHERE s."id" = first_v2."server_id" AND s."task_v2_on_since" IS NULL;
