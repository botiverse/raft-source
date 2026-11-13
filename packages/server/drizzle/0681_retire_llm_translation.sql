SET LOCAL lock_timeout = '2s';--> statement-breakpoint
WITH "removed" AS (
  DELETE FROM "feature_flags" WHERE "key" = 'llm_translation_v0' RETURNING "key"
)
INSERT INTO "feature_flag_config_versions" ("scope", "version", "updated_at", "updated_by", "last_audit_event_id")
SELECT 'global', 1, now(), 'migration:retire-llm-translation', NULL FROM "removed"
ON CONFLICT ("scope") DO UPDATE SET
  "version" = "feature_flag_config_versions"."version" + 1,
  "updated_at" = now(),
  "updated_by" = 'migration:retire-llm-translation',
  "last_audit_event_id" = NULL;
