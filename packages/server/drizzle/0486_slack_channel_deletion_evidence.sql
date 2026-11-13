SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "slack_channel_deletions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"registration_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"source_install_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"source_binding_id" uuid,
	"provider_event_id" text,
	"provider_event_type" text,
	"signing_secret_revision" integer,
	"payload_sha256" text,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_channel_deletion_evidence_valid" CHECK (
    "slack_channel_deletions"."environment" IN ('test', 'production')
    AND length(btrim("slack_channel_deletions"."source_key")) BETWEEN 1 AND 400
    AND (("slack_channel_deletions"."source_kind" = 'signed_event' AND "slack_channel_deletions"."provider_event_type" IS NOT NULL AND "slack_channel_deletions"."provider_event_type" IN ('channel_deleted', 'group_deleted')
      AND "slack_channel_deletions"."provider_event_id" IS NOT NULL AND length(btrim("slack_channel_deletions"."provider_event_id")) BETWEEN 1 AND 320
      AND "slack_channel_deletions"."signing_secret_revision" IS NOT NULL AND "slack_channel_deletions"."signing_secret_revision" > 0
      AND "slack_channel_deletions"."payload_sha256" IS NOT NULL AND "slack_channel_deletions"."payload_sha256" ~ '^[0-9a-f]{64}$')
      OR ("slack_channel_deletions"."source_kind" = 'legacy_binding' AND "slack_channel_deletions"."source_binding_id" IS NOT NULL
        AND "slack_channel_deletions"."provider_event_id" IS NULL AND "slack_channel_deletions"."provider_event_type" IS NULL
        AND "slack_channel_deletions"."signing_secret_revision" IS NULL AND "slack_channel_deletions"."payload_sha256" IS NULL))
    AND length(btrim("slack_channel_deletions"."provider_app_id")) BETWEEN 1 AND 160
    AND length(btrim("slack_channel_deletions"."provider_authority_id")) BETWEEN 1 AND 160
    AND length(btrim("slack_channel_deletions"."provider_conversation_id")) BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_slack_channel_deletion_source" ON "slack_channel_deletions" USING btree ("registration_id","environment","provider_app_id","provider_authority_id","provider_conversation_id","source_key");--> statement-breakpoint
CREATE INDEX "idx_slack_channel_deletion_scope" ON "slack_channel_deletions" USING btree ("registration_id","environment","provider_app_id","provider_authority_id","provider_conversation_id");
--> statement-breakpoint
-- Rolling compatibility only. This reads identity rows without row locks and
-- appends to the evidence table; it never modifies another table. Evidence has
-- no FKs that would acquire install/registration key locks in reverse order.
CREATE FUNCTION capture_legacy_slack_channel_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'paused' AND OLD.state_reason = 'provider_channel_deleted' THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO slack_channel_deletions (
    id, registration_id, environment, provider_app_id, provider_authority_id, provider_conversation_id,
    source_install_id, source_kind, source_key, source_binding_id, observed_at
  )
  SELECT gen_random_uuid(), NEW.registration_id, r.environment, i.provider_app_id, i.provider_authority_id,
    NEW.provider_conversation_id, i.id, 'legacy_binding', 'binding:' || NEW.id::text || ':' || NEW.binding_epoch::text,
    NEW.id, NEW.updated_at
  FROM external_app_installs i
  JOIN external_app_registrations r ON r.id = NEW.registration_id AND r.provider = 'slack'
  WHERE i.id = NEW.install_id AND i.registration_id = NEW.registration_id
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Failure is unknown evidence, never a reason to undo the original pause.
  RAISE WARNING 'Slack legacy deletion evidence capture failed';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER capture_legacy_slack_channel_deletion
AFTER INSERT OR UPDATE OF state, state_reason ON external_channel_bindings
FOR EACH ROW WHEN (NEW.state = 'paused' AND NEW.state_reason = 'provider_channel_deleted')
EXECUTE FUNCTION capture_legacy_slack_channel_deletion();

--> statement-breakpoint
-- Legacy facts have no per-event signature receipt. Keep that distinction.
INSERT INTO "slack_channel_deletions" (
  "id", "registration_id", "environment", "provider_app_id", "provider_authority_id", "provider_conversation_id",
  "source_install_id", "source_kind", "source_key", "source_binding_id", "observed_at"
)
SELECT gen_random_uuid(), b.registration_id, r.environment, i.provider_app_id, i.provider_authority_id,
  b.provider_conversation_id, i.id, 'legacy_binding', 'binding:' || b.id::text || ':' || b.binding_epoch::text, b.id, b.updated_at
FROM external_channel_bindings b
JOIN external_app_installs i ON i.id = b.install_id AND i.registration_id = b.registration_id
JOIN external_app_registrations r ON r.id = b.registration_id AND r.provider = 'slack'
WHERE b.state = 'paused' AND b.state_reason = 'provider_channel_deleted'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
