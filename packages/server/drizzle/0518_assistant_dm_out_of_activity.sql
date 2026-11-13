-- inbox_target_mute_states is on Activity's hot path: fail fast rather than
-- queue writes behind the lock. Adding a column with a constant DEFAULT only
-- changes the catalog (no table rewrite); the backfill touches one row per
-- live personal assistant.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "inbox_target_mute_states" ADD COLUMN "push_muted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Keep every live assistant's DM with its owner out of the owner's Activity,
-- as createMyAssistant now does for a new one (keepAssistantDmOutOfActivity):
-- an activity mute from the first message that keeps push. A row the owner
-- left muted stays theirs; one that is not muted is taken over.
INSERT INTO "inbox_target_mute_states" ("receiver_type", "receiver_id", "server_id", "source_channel_id", "activity_muted", "mute_from_seq", "push_muted", "prefs_version", "created_at", "updated_at")
SELECT 'user', a."assistant_owner_user_id", c."server_id", c."id", true, 0, false, 1, now(), now()
FROM "agents" a
JOIN "channel_agents" ca ON ca."agent_id" = a."id"
JOIN "channels" c ON c."id" = ca."channel_id" AND c."type" = 'dm'
JOIN "channel_humans" ch ON ch."channel_id" = c."id" AND ch."user_id" = a."assistant_owner_user_id"
WHERE a."assistant_owner_user_id" IS NOT NULL AND a."deleted_at" IS NULL
ON CONFLICT ("receiver_type", "receiver_id", "source_channel_id") DO UPDATE
SET "activity_muted" = true, "mute_from_seq" = 0, "push_muted" = false,
    "prefs_version" = "inbox_target_mute_states"."prefs_version" + 1, "updated_at" = now()
WHERE "inbox_target_mute_states"."activity_muted" = false;
