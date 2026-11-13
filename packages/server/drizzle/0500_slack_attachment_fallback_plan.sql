SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "slack_attachment_fallback_plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"delivery_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot_digest" text NOT NULL,
	"transport" text NOT NULL,
	"unavailable_marker" text DEFAULT '[One or more attachments unavailable]' NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_attachment_fallback_plan_shape" CHECK (
    "slack_attachment_fallback_plans"."revision" > 0 AND "slack_attachment_fallback_plans"."snapshot_digest" ~ '^[0-9a-f]{64}$'
    AND "slack_attachment_fallback_plans"."transport" IN ('text', 'files')
    AND "slack_attachment_fallback_plans"."unavailable_marker" = '[One or more attachments unavailable]'
    AND jsonb_typeof("slack_attachment_fallback_plans"."items") = 'array'
    AND jsonb_array_length("slack_attachment_fallback_plans"."items") BETWEEN 1 AND 10
    AND octet_length("slack_attachment_fallback_plans"."items"::text) <= 10000)
);
--> statement-breakpoint
CREATE TABLE "slack_attachment_plan_rollout" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"minimum_writer_version" integer DEFAULT 0 NOT NULL,
	"config_generation" integer DEFAULT 0 NOT NULL,
	"config_digest" text,
	"verified_release" text,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_attachment_plan_rollout_shape" CHECK (
  "slack_attachment_plan_rollout"."id" = 'slack-attachment-plan-v1'
  AND "slack_attachment_plan_rollout"."minimum_writer_version" IN (0, 1)
  AND "slack_attachment_plan_rollout"."config_generation" >= 0
  AND (("slack_attachment_plan_rollout"."config_generation" = 0 AND "slack_attachment_plan_rollout"."config_digest" IS NULL)
    OR ("slack_attachment_plan_rollout"."config_generation" > 0 AND "slack_attachment_plan_rollout"."config_digest" IS NOT NULL AND "slack_attachment_plan_rollout"."config_digest" ~ '^[0-9a-f]{64}$'))
  AND (NOT "slack_attachment_plan_rollout"."enabled" OR ("slack_attachment_plan_rollout"."minimum_writer_version" = 1 AND "slack_attachment_plan_rollout"."verified_release" IS NOT NULL AND "slack_attachment_plan_rollout"."verified_by" IS NOT NULL AND "slack_attachment_plan_rollout"."verified_release" ~ '^[0-9a-f]{40}$'
    AND length("slack_attachment_plan_rollout"."verified_by") BETWEEN 1 AND 160 AND "slack_attachment_plan_rollout"."verified_at" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD COLUMN "attachment_fallback_plan_revision" integer;--> statement-breakpoint
ALTER TABLE "slack_attachment_fallback_plans" ADD CONSTRAINT "slack_attachment_fallback_plans_delivery_id_external_outbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."external_outbound_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_attachment_fallback_plan_revision" ON "slack_attachment_fallback_plans" USING btree ("delivery_id","revision");--> statement-breakpoint
CREATE INDEX "idx_slack_attachment_fallback_plan_created" ON "slack_attachment_fallback_plans" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "external_outbound_deliveries" ADD CONSTRAINT "slack_attachment_fallback_revision_valid" CHECK ("external_outbound_deliveries"."attachment_fallback_plan_revision" IS NULL
    OR "external_outbound_deliveries"."attachment_fallback_plan_revision" > 0) NOT VALID;
--> statement-breakpoint
CREATE FUNCTION slack_attachment_plan_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Preserve an accepted receipt when a deleted destination advances its
  -- cursor. A previously unrecorded receipt is usable only when the immutable
  -- accepted link has the same full frozen delivery coordinates.
  IF TG_OP = 'UPDATE' AND OLD.attachment_fallback_plan_revision IS NOT NULL
     AND NEW.attachment_fallback_plan_revision = OLD.attachment_fallback_plan_revision
     AND NEW.state = 'accepted' AND OLD.provider_attempts > 0
     AND NEW.provider_message_id IS NOT NULL AND NEW.accepted_at IS NOT NULL
     AND NEW.accepted_at = coalesce(OLD.accepted_at, NEW.updated_at)
     AND NEW.state_reason IS NOT DISTINCT FROM OLD.state_reason
     AND (OLD.state <> 'dispatching' OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at <= clock_timestamp()))
     AND NEW.lease_generation = OLD.lease_generation + 1
     AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NEW.lease_origin_state IS NULL AND NEW.lease_origin_next_attempt_at IS NULL
     AND NEW.next_attempt_at IS NULL
     AND (to_jsonb(NEW) - ARRAY['state','lease_generation','lease_owner','lease_expires_at',
           'lease_origin_state','lease_origin_next_attempt_at','next_attempt_at','provider_message_id','accepted_at','updated_at'])
       = (to_jsonb(OLD) - ARRAY['state','lease_generation','lease_owner','lease_expires_at',
           'lease_origin_state','lease_origin_next_attempt_at','next_attempt_at','provider_message_id','accepted_at','updated_at'])
     AND OLD.render_snapshot->'bindingAuthority'->>'provider' = 'slack'
     AND EXISTS (
       SELECT 1 FROM slack_channel_deletions d
       JOIN external_app_registrations r ON r.id = d.registration_id
       WHERE r.id::text = OLD.render_snapshot->'bindingAuthority'->>'appRegistrationId'
         AND r.provider = 'slack' AND r.environment = d.environment AND r.provider_app_id = d.provider_app_id
         AND d.environment = OLD.render_snapshot->'bindingAuthority'->>'environment'
         AND d.provider_authority_id = OLD.render_snapshot->'bindingAuthority'->>'providerAuthorityId'
         AND d.provider_conversation_id = OLD.render_snapshot->'bindingAuthority'->>'providerConversationId'
     )
     AND ((OLD.state = 'accepted' AND OLD.provider_message_id = NEW.provider_message_id)
       OR (OLD.state <> 'accepted' AND OLD.provider_message_id IS NULL AND EXISTS (
         SELECT 1 FROM external_message_links l WHERE l.delivery_id = OLD.id AND l.outcome_state = 'accepted'
           AND l.provider = 'slack' AND l.install_id = OLD.render_snapshot->'bindingAuthority'->>'installId'
           AND l.provider_authority_id = OLD.render_snapshot->'bindingAuthority'->>'providerAuthorityId'
           AND l.provider_conversation_id = OLD.render_snapshot->'bindingAuthority'->>'providerConversationId'
           AND l.provider_message_id = NEW.provider_message_id AND l.binding_id = OLD.binding_id
           AND l.binding_epoch = OLD.binding_epoch
           AND l.connection_epoch::text = OLD.render_snapshot->'bindingAuthority'->>'connectionEpoch'
           AND l.raft_message_id = OLD.source_message_id
           AND l.raft_canonical_root_message_id::text IS NOT DISTINCT FROM OLD.render_snapshot->>'canonicalRootMessageId'
           AND l.first_direction = 'raft_outbound' AND l.payload_fingerprint = OLD.render_snapshot_digest
       ))) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.attachment_fallback_plan_revision IS NOT NULL
     AND NEW.attachment_fallback_plan_revision = OLD.attachment_fallback_plan_revision
     AND NEW.state = 'skipped'
     AND OLD.state <> 'accepted' AND OLD.provider_message_id IS NULL AND OLD.accepted_at IS NULL
     AND ((NEW.state_reason = 'destination_deleted' AND OLD.provider_attempts = 0
           AND OLD.first_dispatched_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM external_delivery_attempts a WHERE a.delivery_id = OLD.id))
       OR (NEW.state_reason = 'destination_deleted_outcome_unconfirmed'
           AND (OLD.provider_attempts > 0 OR EXISTS (SELECT 1 FROM external_delivery_attempts a WHERE a.delivery_id = OLD.id))))
     AND (OLD.state <> 'dispatching' OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at <= clock_timestamp()))
     AND NEW.lease_generation = OLD.lease_generation + 1
     AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL
     AND NEW.lease_origin_state IS NULL AND NEW.lease_origin_next_attempt_at IS NULL
     AND NEW.next_attempt_at IS NULL AND NEW.provider_message_id IS NULL AND NEW.accepted_at IS NULL
     AND (to_jsonb(NEW) - ARRAY['state','state_reason','lease_generation','lease_owner','lease_expires_at',
           'lease_origin_state','lease_origin_next_attempt_at','next_attempt_at','provider_message_id','accepted_at','updated_at'])
       = (to_jsonb(OLD) - ARRAY['state','state_reason','lease_generation','lease_owner','lease_expires_at',
           'lease_origin_state','lease_origin_next_attempt_at','next_attempt_at','provider_message_id','accepted_at','updated_at'])
     AND NOT EXISTS (SELECT 1 FROM external_message_links l WHERE l.delivery_id = OLD.id AND l.outcome_state = 'accepted')
     AND OLD.render_snapshot->'bindingAuthority'->>'provider' = 'slack'
     AND EXISTS (
       SELECT 1 FROM slack_channel_deletions d
       JOIN external_app_registrations r ON r.id = d.registration_id
       WHERE r.id::text = OLD.render_snapshot->'bindingAuthority'->>'appRegistrationId'
         AND r.provider = 'slack' AND r.environment = d.environment
         AND r.provider_app_id = d.provider_app_id
         AND d.environment = OLD.render_snapshot->'bindingAuthority'->>'environment'
         AND d.provider_authority_id = OLD.render_snapshot->'bindingAuthority'->>'providerAuthorityId'
         AND d.provider_conversation_id = OLD.render_snapshot->'bindingAuthority'->>'providerConversationId'
     ) THEN
    RETURN NEW;
  END IF;
  IF (OLD.attachment_fallback_plan_revision IS NOT NULL
      OR (TG_OP = 'UPDATE' AND NEW.attachment_fallback_plan_revision IS NOT NULL))
     AND coalesce(current_setting('slock.attachment_plan', true), '') <> '1' THEN
    RAISE EXCEPTION 'Slack attachment plan requires a compatible writer' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER slack_attachment_plan_write_fence
BEFORE UPDATE OR DELETE ON external_outbound_deliveries
FOR EACH ROW EXECUTE FUNCTION slack_attachment_plan_write_fence();

--> statement-breakpoint
-- Old coordinator instances cannot change a planned file set, reclaim jobs or
-- enter completion without the new reader, even if they held an old lease.
CREATE FUNCTION slack_attachment_plan_job_write_fence() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE parent_id uuid;
BEGIN
  parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.outbound_delivery_id ELSE NEW.outbound_delivery_id END;
  IF (EXISTS (SELECT 1 FROM external_outbound_deliveries d
       WHERE d.id = parent_id AND d.attachment_fallback_plan_revision IS NOT NULL)
      OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM external_outbound_deliveries d
       WHERE d.id = OLD.outbound_delivery_id AND d.attachment_fallback_plan_revision IS NOT NULL)))
     AND coalesce(current_setting('slock.attachment_plan', true), '') <> '1' THEN
    RAISE EXCEPTION 'Slack attachment plan requires a compatible job writer' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER slack_attachment_plan_job_write_fence
BEFORE INSERT OR UPDATE OR DELETE ON external_attachment_transfer_jobs
FOR EACH ROW EXECUTE FUNCTION slack_attachment_plan_job_write_fence();
--> statement-breakpoint
CREATE FUNCTION slack_attachment_plan_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Slack attachment plans are immutable' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER slack_attachment_plan_immutable BEFORE UPDATE OR DELETE ON slack_attachment_fallback_plans
FOR EACH ROW EXECUTE FUNCTION slack_attachment_plan_immutable();
--> statement-breakpoint
CREATE FUNCTION slack_attachment_plan_rollback_floor() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.config_generation < OLD.config_generation
     OR (OLD.config_generation > 0 AND NEW.config_generation = OLD.config_generation
       AND (NEW.enabled IS DISTINCT FROM OLD.enabled OR NEW.config_digest IS DISTINCT FROM OLD.config_digest
         OR NEW.minimum_writer_version IS DISTINCT FROM OLD.minimum_writer_version
         OR NEW.verified_release IS DISTINCT FROM OLD.verified_release
         OR NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at))) THEN
    RAISE EXCEPTION 'Slack attachment control changes require a higher configuration generation' USING ERRCODE = '55000';
  END IF;
  IF OLD.minimum_writer_version = 1 AND (TG_OP = 'DELETE' OR NEW.minimum_writer_version <> 1) THEN
    RAISE EXCEPTION 'Slack attachment reader floor cannot be lowered' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER slack_attachment_plan_rollback_floor BEFORE UPDATE OR DELETE ON slack_attachment_plan_rollout
FOR EACH ROW EXECUTE FUNCTION slack_attachment_plan_rollback_floor();
