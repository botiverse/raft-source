CREATE SEQUENCE "public"."slack_verified_ingress_served_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9007199254740991 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_dedupe" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_registration_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"raw_digest" text NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_verified_ingress_dedupe_digest" CHECK ("slack_verified_ingress_dedupe"."raw_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partition_id" uuid NOT NULL,
	"position" bigint NOT NULL,
	"app_registration_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_app_id" text NOT NULL,
	"raw_digest" text NOT NULL,
	"encrypted_payload" text,
	"envelope_key_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"parse_failure_count" integer DEFAULT 0 NOT NULL,
	"first_parse_failure_at" timestamp with time zone,
	"held_at" timestamp with time zone,
	"replay_count" integer DEFAULT 0 NOT NULL,
	"last_replayed_at" timestamp with time zone,
	"last_isolation_reason" text,
	"last_isolated_at" timestamp with time zone,
	"last_isolated_normalized_id" uuid,
	"last_isolated_normalized_digest" text,
	"outcome_reason" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"materialized_inbound_event_id" uuid,
	"normalization_source" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_verified_ingress_event_coordinates" CHECK (
    "slack_verified_ingress_events"."position" BETWEEN 1 AND 9007199254740991
    AND "slack_verified_ingress_events"."lease_generation" BETWEEN 0 AND 9007199254740991
    AND length(btrim("slack_verified_ingress_events"."app_registration_id")) BETWEEN 1 AND 320
    AND length(btrim("slack_verified_ingress_events"."provider_event_id")) BETWEEN 1 AND 320
    AND length(btrim("slack_verified_ingress_events"."provider_app_id")) BETWEEN 1 AND 160
    AND "slack_verified_ingress_events"."raw_digest" ~ '^[0-9a-f]{64}$'
    AND ("slack_verified_ingress_events"."outcome_reason" IS NULL OR "slack_verified_ingress_events"."outcome_reason" ~ '^[a-z][a-z0-9_]{0,159}$')),
	CONSTRAINT "slack_verified_ingress_event_custody" CHECK (
    "slack_verified_ingress_events"."state" IN ('queued', 'processing', 'materialized', 'held', 'quarantined', 'review_required', 'completed', 'discarded')
    AND (("slack_verified_ingress_events"."state" IN ('queued', 'processing', 'materialized', 'held', 'quarantined', 'review_required') AND "slack_verified_ingress_events"."encrypted_payload" IS NOT NULL
      AND octet_length("slack_verified_ingress_events"."encrypted_payload") BETWEEN 1 AND 1500000
      AND "slack_verified_ingress_events"."envelope_key_id" IS NOT NULL AND length(btrim("slack_verified_ingress_events"."envelope_key_id")) BETWEEN 1 AND 320)
      OR ("slack_verified_ingress_events"."state" IN ('completed', 'discarded') AND "slack_verified_ingress_events"."encrypted_payload" IS NULL
        AND "slack_verified_ingress_events"."envelope_key_id" IS NULL AND "slack_verified_ingress_events"."outcome_reason" IS NOT NULL
        AND length(btrim("slack_verified_ingress_events"."outcome_reason")) BETWEEN 1 AND 160))
    AND (("slack_verified_ingress_events"."state" IN ('materialized', 'completed') AND "slack_verified_ingress_events"."materialized_inbound_event_id" IS NOT NULL)
      OR ("slack_verified_ingress_events"."state" IN ('queued', 'processing', 'held', 'quarantined', 'review_required') AND "slack_verified_ingress_events"."materialized_inbound_event_id" IS NULL)
      OR "slack_verified_ingress_events"."state" = 'discarded')
    AND "slack_verified_ingress_events"."parse_failure_count" BETWEEN 0 AND 3
    AND "slack_verified_ingress_events"."replay_count" >= 0
    AND (("slack_verified_ingress_events"."replay_count" = 0 AND "slack_verified_ingress_events"."last_replayed_at" IS NULL)
      OR ("slack_verified_ingress_events"."replay_count" > 0 AND "slack_verified_ingress_events"."last_replayed_at" IS NOT NULL))
    AND (("slack_verified_ingress_events"."last_isolation_reason" IS NULL AND "slack_verified_ingress_events"."last_isolated_at" IS NULL)
      OR ("slack_verified_ingress_events"."last_isolation_reason" IS NOT NULL AND "slack_verified_ingress_events"."last_isolation_reason" ~ '^[a-z][a-z0-9_]{0,159}$' AND "slack_verified_ingress_events"."last_isolated_at" IS NOT NULL))
    AND (("slack_verified_ingress_events"."last_isolated_normalized_id" IS NULL AND "slack_verified_ingress_events"."last_isolated_normalized_digest" IS NULL)
      OR ("slack_verified_ingress_events"."last_isolated_normalized_id" IS NOT NULL AND "slack_verified_ingress_events"."last_isolated_normalized_digest" IS NOT NULL
        AND "slack_verified_ingress_events"."last_isolated_normalized_digest" ~ '^[0-9a-f]{64}$'))
    AND (("slack_verified_ingress_events"."parse_failure_count" = 0 AND "slack_verified_ingress_events"."first_parse_failure_at" IS NULL)
      OR ("slack_verified_ingress_events"."parse_failure_count" > 0 AND "slack_verified_ingress_events"."first_parse_failure_at" IS NOT NULL))
    AND (("slack_verified_ingress_events"."state" IN ('held', 'quarantined', 'review_required') AND "slack_verified_ingress_events"."held_at" IS NOT NULL AND "slack_verified_ingress_events"."parse_failure_count" = 3
      AND "slack_verified_ingress_events"."outcome_reason" IS NOT NULL) OR ("slack_verified_ingress_events"."state" NOT IN ('held', 'quarantined', 'review_required') AND "slack_verified_ingress_events"."held_at" IS NULL))),
	CONSTRAINT "slack_verified_ingress_event_lease" CHECK (
    (("slack_verified_ingress_events"."state" = 'processing' AND "slack_verified_ingress_events"."lease_owner" IS NOT NULL AND length(btrim("slack_verified_ingress_events"."lease_owner")) BETWEEN 1 AND 160
      AND "slack_verified_ingress_events"."lease_expires_at" IS NOT NULL AND "slack_verified_ingress_events"."lease_generation" > 0)
      OR ("slack_verified_ingress_events"."state" <> 'processing' AND "slack_verified_ingress_events"."lease_owner" IS NULL AND "slack_verified_ingress_events"."lease_expires_at" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_file_facts" (
	"fact_id" uuid PRIMARY KEY NOT NULL,
	"raw_event_id" uuid NOT NULL,
	"normalized_payload_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_verified_ingress_file_digest_valid" CHECK ("slack_verified_ingress_file_facts"."normalized_payload_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_partitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app_registration_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"partition_kind" text NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"last_position" bigint DEFAULT 0 NOT NULL,
	"last_served_at" timestamp with time zone,
	"last_served_ordinal" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_verified_ingress_partition_coordinates" CHECK (
    length(btrim("slack_verified_ingress_partitions"."app_registration_id")) BETWEEN 1 AND 320
    AND length(btrim("slack_verified_ingress_partitions"."provider_authority_id")) BETWEEN 1 AND 160
    AND "slack_verified_ingress_partitions"."environment" IN ('test', 'production')
    AND (("slack_verified_ingress_partitions"."partition_kind" = 'authority' AND "slack_verified_ingress_partitions"."provider_conversation_id" = '')
      OR ("slack_verified_ingress_partitions"."partition_kind" = 'conversation' AND length(btrim("slack_verified_ingress_partitions"."provider_conversation_id")) BETWEEN 1 AND 160))
    AND "slack_verified_ingress_partitions"."last_position" BETWEEN 0 AND 9007199254740991
    AND ("slack_verified_ingress_partitions"."last_served_ordinal" IS NULL OR "slack_verified_ingress_partitions"."last_served_ordinal" BETWEEN 1 AND 9007199254740991))
);
--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_replay_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"partition_id" uuid NOT NULL,
	"previous_position" bigint NOT NULL,
	"replay_position" bigint NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"isolation_reason" text NOT NULL,
	"replayed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_verified_ingress_replay_valid" CHECK ("slack_verified_ingress_replay_audits"."previous_position" > 0 AND "slack_verified_ingress_replay_audits"."replay_position" > "slack_verified_ingress_replay_audits"."previous_position"
    AND "slack_verified_ingress_replay_audits"."actor_kind" IN ('human','system') AND length(btrim("slack_verified_ingress_replay_audits"."actor_id")) BETWEEN 1 AND 160
    AND "slack_verified_ingress_replay_audits"."isolation_reason" ~ '^[a-z][a-z0-9_]{0,159}$')
);
--> statement-breakpoint
CREATE TABLE "slack_verified_ingress_rollout" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"minimum_writer_protocol" integer DEFAULT 0 NOT NULL,
	"consumers_enabled" boolean DEFAULT false NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"config_generation" integer DEFAULT 0 NOT NULL,
	"config_digest" text,
	"release_record" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_verified_ingress_rollout_shape" CHECK (
    "slack_verified_ingress_rollout"."id" = 1 AND "slack_verified_ingress_rollout"."minimum_writer_protocol" BETWEEN 0 AND 65535
    AND "slack_verified_ingress_rollout"."generation" BETWEEN 1 AND 9007199254740991
    AND "slack_verified_ingress_rollout"."config_generation" >= 0
    AND (("slack_verified_ingress_rollout"."config_generation" = 0 AND "slack_verified_ingress_rollout"."config_digest" IS NULL)
      OR ("slack_verified_ingress_rollout"."config_generation" > 0 AND "slack_verified_ingress_rollout"."config_digest" IS NOT NULL AND "slack_verified_ingress_rollout"."config_digest" ~ '^[0-9a-f]{64}$'))
    AND (NOT "slack_verified_ingress_rollout"."consumers_enabled" OR "slack_verified_ingress_rollout"."minimum_writer_protocol" > 0)
    AND ("slack_verified_ingress_rollout"."release_record" IS NULL OR "slack_verified_ingress_rollout"."release_record" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND ("slack_verified_ingress_rollout"."minimum_writer_protocol" = 0 OR "slack_verified_ingress_rollout"."release_record" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_events" ADD CONSTRAINT "slack_verified_ingress_events_materialized_inbound_event_id_external_inbound_events_id_fk" FOREIGN KEY ("materialized_inbound_event_id") REFERENCES "public"."external_inbound_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_partition_registration" ON "slack_verified_ingress_partitions" USING btree ("id","app_registration_id");--> statement-breakpoint

ALTER TABLE "slack_verified_ingress_events" ADD CONSTRAINT "slack_verified_ingress_partition_registration_fk" FOREIGN KEY ("partition_id","app_registration_id") REFERENCES "public"."slack_verified_ingress_partitions"("id","app_registration_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_file_facts" ADD CONSTRAINT "slack_verified_ingress_file_facts_fact_id_external_attachment_message_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."external_attachment_message_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_file_facts" ADD CONSTRAINT "slack_verified_ingress_file_facts_raw_event_id_slack_verified_ingress_events_id_fk" FOREIGN KEY ("raw_event_id") REFERENCES "public"."slack_verified_ingress_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_replay_audits" ADD CONSTRAINT "slack_verified_ingress_replay_audits_event_id_slack_verified_ingress_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."slack_verified_ingress_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_verified_ingress_replay_audits" ADD CONSTRAINT "slack_verified_ingress_replay_audits_partition_id_slack_verified_ingress_partitions_id_fk" FOREIGN KEY ("partition_id") REFERENCES "public"."slack_verified_ingress_partitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_event_partition" ON "slack_verified_ingress_events" USING btree ("id","partition_id");--> statement-breakpoint

ALTER TABLE "slack_verified_ingress_replay_audits" ADD CONSTRAINT "slack_verified_ingress_replay_event_partition_fk" FOREIGN KEY ("event_id","partition_id") REFERENCES "public"."slack_verified_ingress_events"("id","partition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_dedupe_identity" ON "slack_verified_ingress_dedupe" USING btree ("app_registration_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_identity" ON "slack_verified_ingress_events" USING btree ("app_registration_id","provider_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_position" ON "slack_verified_ingress_events" USING btree ("partition_id","position");--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_work" ON "slack_verified_ingress_events" USING btree ("partition_id","position","state");--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_active_head" ON "slack_verified_ingress_events" USING btree ("partition_id","position") WHERE "slack_verified_ingress_events"."state" IN ('queued', 'processing', 'materialized');--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_terminal_retention" ON "slack_verified_ingress_events" USING btree ("updated_at","id") WHERE "slack_verified_ingress_events"."state" IN ('completed', 'discarded');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_partition" ON "slack_verified_ingress_partitions" USING btree ("app_registration_id","environment","provider_authority_id","partition_kind","provider_conversation_id");--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_partition_fairness" ON "slack_verified_ingress_partitions" USING btree ("last_served_ordinal","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slack_verified_ingress_replay_position" ON "slack_verified_ingress_replay_audits" USING btree ("event_id","replay_position");--> statement-breakpoint
CREATE INDEX "idx_slack_verified_ingress_replay_event" ON "slack_verified_ingress_replay_audits" USING btree ("event_id","replayed_at");--> statement-breakpoint-- Large-table index is built concurrently by db:create-slack-inbound-head-index.--> statement-breakpoint
INSERT INTO slack_verified_ingress_rollout (id) VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.slack_ingress_writer_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_row_fence$
DECLARE required_protocol integer;
BEGIN
  IF TG_TABLE_NAME = 'external_inbound_events' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.provider <> 'slack' THEN RETURN NEW; END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD.provider <> 'slack' THEN RETURN OLD; END IF;
    ELSE
      IF OLD.provider <> 'slack' AND NEW.provider <> 'slack' THEN RETURN NEW; END IF;
    END IF;
  END IF;
  -- A locking read cannot silently use a pre-activation REPEATABLE READ snapshot.
  SELECT minimum_writer_protocol INTO required_protocol
    FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Slack ingress protocol state missing' USING ERRCODE = '55000'; END IF;
  IF required_protocol > 0 AND current_setting('raft.slack_ingress_protocol', true)
    IS DISTINCT FROM required_protocol::text THEN
    RAISE EXCEPTION 'Slack ingress writer protocol required' USING ERRCODE = '55000';
  END IF;
  IF required_protocol > 0 AND TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'slack_verified_ingress_events' THEN
      IF OLD.state NOT IN ('completed', 'discarded') THEN
        RAISE EXCEPTION 'Unresolved Slack receipt cannot be removed' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.status NOT IN ('committed', 'duplicate', 'echo')
      AND NOT (OLD.status = 'dead' AND OLD.outcome_reason IS NOT DISTINCT FROM 'confirmed_thread_root_missing') THEN
      RAISE EXCEPTION 'Unresolved Slack normalized receipt cannot be removed' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$slack_row_fence$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.slack_ingress_policy_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_policy_fence$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Slack ingress protocol floor cannot be removed' USING ERRCODE = '55000';
  END IF;
  IF NEW.minimum_writer_protocol < OLD.minimum_writer_protocol OR NEW.generation <= OLD.generation THEN
    RAISE EXCEPTION 'Slack ingress protocol floor or generation cannot go backwards' USING ERRCODE = '55000';
  END IF;
  IF NEW.config_generation < OLD.config_generation OR
    (OLD.config_generation > 0 AND NEW.config_generation = OLD.config_generation AND (
      NEW.config_digest IS DISTINCT FROM OLD.config_digest OR
      NEW.consumers_enabled IS DISTINCT FROM OLD.consumers_enabled OR
      NEW.minimum_writer_protocol IS DISTINCT FROM OLD.minimum_writer_protocol OR
      NEW.release_record IS DISTINCT FROM OLD.release_record)) THEN
    RAISE EXCEPTION 'Slack ingress deployment configuration cannot go backwards or conflict' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$slack_policy_fence$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.slack_ingress_truncate_fence_v1() RETURNS trigger
LANGUAGE plpgsql AS $slack_truncate_fence$
DECLARE required_protocol integer;
BEGIN
  SELECT minimum_writer_protocol INTO required_protocol
    FROM slack_verified_ingress_rollout WHERE id = 1 FOR SHARE;
  IF NOT FOUND OR required_protocol > 0 THEN
    RAISE EXCEPTION 'Bulk Slack ingress removal is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END
$slack_truncate_fence$;--> statement-breakpoint
CREATE TRIGGER slack_ingress_normalized_writer_fence
  BEFORE INSERT OR UPDATE OR DELETE ON external_inbound_events
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_writer_fence_v1();--> statement-breakpoint
CREATE TRIGGER slack_ingress_raw_writer_fence
  BEFORE INSERT OR UPDATE OR DELETE ON slack_verified_ingress_events
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_writer_fence_v1();--> statement-breakpoint
CREATE TRIGGER slack_ingress_policy_floor_fence
  BEFORE UPDATE OR DELETE ON slack_verified_ingress_rollout
  FOR EACH ROW EXECUTE FUNCTION public.slack_ingress_policy_fence_v1();--> statement-breakpoint
CREATE TRIGGER slack_ingress_policy_truncate_fence
  BEFORE TRUNCATE ON slack_verified_ingress_rollout
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_policy_fence_v1();--> statement-breakpoint
CREATE TRIGGER slack_ingress_normalized_truncate_fence
  BEFORE TRUNCATE ON external_inbound_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_truncate_fence_v1();--> statement-breakpoint
CREATE TRIGGER slack_ingress_raw_truncate_fence
  BEFORE TRUNCATE ON slack_verified_ingress_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.slack_ingress_truncate_fence_v1();--> statement-breakpoint
-- Acquire hot author-table locks last, after all other table locks.
ALTER TABLE "external_actor_projections" DROP CONSTRAINT "external_actor_projection_values_valid";--> statement-breakpoint
ALTER TABLE "external_message_author_facts" DROP CONSTRAINT "external_message_author_values_valid";--> statement-breakpoint
ALTER TABLE "external_actor_projections" ADD COLUMN "identity_kind" text DEFAULT 'provider_actor' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD COLUMN "identity_kind" text DEFAULT 'provider_actor' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD COLUMN "anonymous_display_id" text;--> statement-breakpoint
-- Existing rows satisfied the old checks and receive the constant provider_actor default.
-- NOT VALID avoids a scan while enforcing the new superset on every subsequent write.
ALTER TABLE "external_actor_projections" ADD CONSTRAINT "external_actor_projection_values_valid" CHECK (length(btrim("external_actor_projections"."provider")) > 0
      AND length(btrim("external_actor_projections"."app_registration_id")) > 0
      AND length(btrim("external_actor_projections"."install_id")) > 0
      AND length(btrim("external_actor_projections"."workspace_id")) > 0
      AND (("external_actor_projections"."identity_kind" = 'provider_actor' AND length(btrim("external_actor_projections"."external_actor_id")) > 0)
        OR ("external_actor_projections"."identity_kind" = 'anonymous' AND "external_actor_projections"."provider" = 'slack' AND "external_actor_projections"."external_actor_id" = ''
          AND "external_actor_projections"."actor_kind" = 'unknown' AND "external_actor_projections"."handles" = '[]'::jsonb AND "external_actor_projections"."avatar_artifact_id" IS NULL))
      AND length(btrim("external_actor_projections"."display_name")) > 0
      AND "external_actor_projections"."actor_kind" IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND "external_actor_projections"."state" IN ('active', 'tombstoned')) NOT VALID;--> statement-breakpoint
ALTER TABLE "external_message_author_facts" ADD CONSTRAINT "external_message_author_values_valid" CHECK (length(btrim("external_message_author_facts"."provider")) > 0
      AND length(btrim("external_message_author_facts"."app_registration_id")) > 0
      AND length(btrim("external_message_author_facts"."install_id")) > 0
      AND length(btrim("external_message_author_facts"."workspace_id")) > 0
      AND (("external_message_author_facts"."identity_kind" = 'provider_actor' AND length(btrim("external_message_author_facts"."external_actor_id")) > 0 AND "external_message_author_facts"."anonymous_display_id" IS NULL)
        OR ("external_message_author_facts"."identity_kind" = 'anonymous' AND "external_message_author_facts"."provider" = 'slack' AND "external_message_author_facts"."external_actor_id" = '' AND "external_message_author_facts"."actor_kind" = 'unknown'
          AND "external_message_author_facts"."anonymous_display_id" IS NOT NULL AND "external_message_author_facts"."anonymous_display_id" ~ '^slack-anonymous:[0-9a-f]{64}$'))
      AND length(btrim("external_message_author_facts"."external_conversation_id")) > 0
      AND length(btrim("external_message_author_facts"."external_message_id")) > 0
      AND length(btrim("external_message_author_facts"."display_name")) > 0
      AND "external_message_author_facts"."content_digest" ~ '^[0-9a-f]{64}$'
      AND "external_message_author_facts"."actor_kind" IN ('human', 'guest', 'remote', 'bot', 'unknown')
      AND "external_message_author_facts"."actor_projection_revision" > 0
      AND (("external_message_author_facts"."avatar_artifact_id" IS NULL AND "external_message_author_facts"."avatar_url" IS NULL AND "external_message_author_facts"."avatar_digest" IS NULL)
        OR ("external_message_author_facts"."avatar_artifact_id" IS NOT NULL AND "external_message_author_facts"."avatar_url" ~ '^https://' AND "external_message_author_facts"."avatar_digest" ~ '^[0-9a-f]{64}$'))) NOT VALID;
