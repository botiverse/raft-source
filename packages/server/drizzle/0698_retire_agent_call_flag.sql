-- Retire agent_call_v0 (added by the previous migration, never ruled on): the
-- agent call stays inside Raft Deck for v0 and comes to Raft natively in v1
-- (artin, #wg-runtime-form). Nothing reads the flag; deleting its row (no
-- rules exist; they would cascade) and bumping the global config version as other retirements do.
SET LOCAL lock_timeout = '2s';--> statement-breakpoint
WITH "removed" AS (
  DELETE FROM "feature_flags" WHERE "key" = 'agent_call_v0' RETURNING "key"
)
INSERT INTO "feature_flag_config_versions" ("scope", "version", "updated_at", "updated_by", "last_audit_event_id")
SELECT 'global', 1, now(), 'migration:retire-agent-call', NULL FROM "removed"
ON CONFLICT ("scope") DO UPDATE SET
  "version" = "feature_flag_config_versions"."version" + 1,
  "updated_at" = now(),
  "updated_by" = 'migration:retire-agent-call',
  "last_audit_event_id" = NULL;
