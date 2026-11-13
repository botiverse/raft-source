-- Every personal assistant is named Ottie with the otter avatar (product
-- decision; assistantService ASSISTANT_DISPLAY_NAME / ASSISTANT_AVATAR_URL).
-- New ones are created that way and no route renames one any more; this
-- renames the live assistants made before. Data only.
--
-- One statement, so the provision rows bumped are exactly the agents renamed:
-- each gets the ordered profile PATCH noteProvisionedAgentProfileEdit queues
-- for a human edit (desired_revision + 1; an active row is due now with a
-- fresh backoff, provisioning/failed rows keep their schedule), so the cloud
-- runtime learns the new name.
--
-- Idempotent: an assistant already named Ottie with the otter avatar is left
-- alone, so a second run renames and queues nothing. Touches one agents row
-- and at most one agent_runtime_provisions row per live assistant (row locks
-- only); fail fast rather than queue behind a lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
WITH "renamed" AS (
  UPDATE "agents"
  SET "display_name" = 'Ottie', "avatar_url" = 'pixel:ottie', "updated_at" = now()
  WHERE "assistant_owner_user_id" IS NOT NULL
    AND "deleted_at" IS NULL
    AND ("display_name" IS DISTINCT FROM 'Ottie' OR "avatar_url" IS DISTINCT FROM 'pixel:ottie')
  RETURNING "id"
)
UPDATE "agent_runtime_provisions"
SET "desired_revision" = "desired_revision" + 1,
    "attempt_count" = CASE WHEN "state" = 'active' THEN 0 ELSE "attempt_count" END,
    "next_attempt_at" = CASE WHEN "state" = 'active' THEN now() ELSE "next_attempt_at" END,
    "updated_at" = now()
WHERE "agent_id" IN (SELECT "id" FROM "renamed")
  AND "state" IN ('provisioning', 'active', 'failed');
