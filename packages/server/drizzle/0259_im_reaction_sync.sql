CREATE TABLE "external_reaction_command_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command_id" uuid NOT NULL,
	"desired_revision" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"io_phase" text NOT NULL,
	"outcome" text NOT NULL,
	"safe_reason_code" text NOT NULL,
	"retry_after_ms" integer,
	"observed_bot_presence" boolean,
	"observed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_reaction_attempt_valid" CHECK ("external_reaction_command_attempts"."desired_revision" > 0 AND "external_reaction_command_attempts"."attempt_number" > 0
      AND "external_reaction_command_attempts"."io_phase" IN ('before_send', 'after_send', 'unknown')
      AND "external_reaction_command_attempts"."outcome" IN (
        'accepted', 'already_satisfied', 'rate_limited', 'transient_failure', 'deterministic_failure',
        'outcome_unknown', 'reconciled_present', 'reconciled_absent', 'superseded', 'revoked', 'quarantined'
      )
      AND length(btrim("external_reaction_command_attempts"."safe_reason_code")) > 0 AND length("external_reaction_command_attempts"."safe_reason_code") <= 160
      AND ("external_reaction_command_attempts"."retry_after_ms" IS NULL OR "external_reaction_command_attempts"."retry_after_ms" >= 0)
      AND (("external_reaction_command_attempts"."observed_bot_presence" IS NULL AND "external_reaction_command_attempts"."observed_at" IS NULL)
        OR ("external_reaction_command_attempts"."observed_bot_presence" IS NOT NULL AND "external_reaction_command_attempts"."observed_at" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "external_reaction_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"message_link_id" uuid NOT NULL,
	"raft_message_id" uuid NOT NULL,
	"provider_conversation_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_reaction_key" text NOT NULL,
	"canonical_emoji" text NOT NULL,
	"mapping_revision" integer NOT NULL,
	"desired_revision" integer NOT NULL,
	"desired_present" boolean NOT NULL,
	"local_discussion_version" bigint NOT NULL,
	"local_aggregate_count" integer NOT NULL,
	"source_snapshot_digest" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_reaction_command_valid" CHECK (length(btrim("external_reaction_commands"."provider")) > 0 AND length("external_reaction_commands"."provider") <= 80
      AND length(btrim("external_reaction_commands"."provider_reaction_key")) > 0 AND length("external_reaction_commands"."provider_reaction_key") <= 160
      AND length(btrim("external_reaction_commands"."canonical_emoji")) > 0 AND length("external_reaction_commands"."canonical_emoji") <= 32
      AND "external_reaction_commands"."connection_epoch" > 0 AND "external_reaction_commands"."binding_epoch" > 0 AND "external_reaction_commands"."mapping_revision" > 0
      AND "external_reaction_commands"."desired_revision" > 0 AND "external_reaction_commands"."local_discussion_version" >= 0 AND "external_reaction_commands"."local_aggregate_count" >= 0
      AND "external_reaction_commands"."source_snapshot_digest" ~ '^[0-9a-f]{64}$'
      AND "external_reaction_commands"."state" IN (
        'queued', 'dispatching', 'retry_wait', 'outcome_unknown', 'accepted', 'superseded',
        'deterministic_failure', 'revoked', 'quarantined'
      )
      AND "external_reaction_commands"."attempts" >= 0 AND "external_reaction_commands"."lease_generation" >= 0
      AND ("external_reaction_commands"."state" = 'dispatching') = ("external_reaction_commands"."lease_owner" IS NOT NULL AND "external_reaction_commands"."lease_expires_at" IS NOT NULL)
      AND ("external_reaction_commands"."state" IN ('accepted', 'superseded', 'deterministic_failure', 'revoked', 'quarantined'))
        = ("external_reaction_commands"."terminal_at" IS NOT NULL)
      AND ("external_reaction_commands"."last_error_class" IS NULL OR (
        length(btrim("external_reaction_commands"."last_error_class")) > 0 AND length("external_reaction_commands"."last_error_class") <= 160
      )))
);
--> statement-breakpoint
CREATE TABLE "external_reaction_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inbound_event_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"message_link_id" uuid NOT NULL,
	"raft_message_id" uuid NOT NULL,
	"projection_id" uuid,
	"external_actor_id" text NOT NULL,
	"provider_reaction_key" text NOT NULL,
	"canonical_emoji" text,
	"mapping_revision" integer NOT NULL,
	"event_occurred_at" timestamp with time zone NOT NULL,
	"event_sequence" bigint NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_reaction_fact_valid" CHECK ("external_reaction_facts"."operation" IN ('add', 'remove')
      AND "external_reaction_facts"."outcome" IN ('applied', 'noop', 'stale', 'quarantined', 'bot_echo', 'unsupported')
      AND length(btrim("external_reaction_facts"."provider_event_id")) > 0 AND length("external_reaction_facts"."provider_event_id") <= 320
      AND length(btrim("external_reaction_facts"."provider_reaction_key")) > 0 AND length("external_reaction_facts"."provider_reaction_key") <= 160
      AND length(btrim("external_reaction_facts"."external_actor_id")) > 0 AND length("external_reaction_facts"."external_actor_id") <= 160
      AND ("external_reaction_facts"."canonical_emoji" IS NULL OR (
        length(btrim("external_reaction_facts"."canonical_emoji")) > 0 AND length("external_reaction_facts"."canonical_emoji") <= 32
      ))
      AND "external_reaction_facts"."connection_epoch" > 0 AND "external_reaction_facts"."binding_epoch" > 0 AND "external_reaction_facts"."mapping_revision" > 0
      AND "external_reaction_facts"."event_sequence" > 0
      AND (("external_reaction_facts"."outcome" IN ('bot_echo', 'unsupported') AND "external_reaction_facts"."projection_id" IS NULL)
        OR ("external_reaction_facts"."outcome" NOT IN ('bot_echo', 'unsupported') AND "external_reaction_facts"."projection_id" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "external_reaction_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"message_link_id" uuid NOT NULL,
	"raft_message_id" uuid NOT NULL,
	"projection_id" uuid NOT NULL,
	"provider_reaction_key" text NOT NULL,
	"canonical_emoji" text NOT NULL,
	"mapping_revision" integer NOT NULL,
	"present" boolean NOT NULL,
	"last_provider_event_id" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"last_event_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_reaction_state_valid" CHECK (length(btrim("external_reaction_states"."provider")) > 0 AND length("external_reaction_states"."provider") <= 80
      AND length(btrim("external_reaction_states"."app_registration_id")) > 0 AND length("external_reaction_states"."app_registration_id") <= 320
      AND length(btrim("external_reaction_states"."install_id")) > 0 AND length("external_reaction_states"."install_id") <= 160
      AND length(btrim("external_reaction_states"."workspace_id")) > 0 AND length("external_reaction_states"."workspace_id") <= 320
      AND length(btrim("external_reaction_states"."binding_id")) > 0 AND length("external_reaction_states"."binding_id") <= 160
      AND length(btrim("external_reaction_states"."provider_reaction_key")) > 0 AND length("external_reaction_states"."provider_reaction_key") <= 160
      AND length(btrim("external_reaction_states"."canonical_emoji")) > 0 AND length("external_reaction_states"."canonical_emoji") <= 32
      AND length(btrim("external_reaction_states"."last_provider_event_id")) > 0 AND length("external_reaction_states"."last_provider_event_id") <= 320
      AND "external_reaction_states"."connection_epoch" > 0 AND "external_reaction_states"."binding_epoch" > 0 AND "external_reaction_states"."mapping_revision" > 0
      AND "external_reaction_states"."last_event_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "external_inbound_events" DROP CONSTRAINT "external_inbound_event_coordinates_valid";--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" DROP CONSTRAINT "external_ingress_discard_coordinates_valid";--> statement-breakpoint
ALTER TABLE "external_reaction_command_attempts" ADD CONSTRAINT "external_reaction_command_attempts_command_id_external_reaction_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."external_reaction_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_commands" ADD CONSTRAINT "external_reaction_commands_message_link_id_external_message_links_id_fk" FOREIGN KEY ("message_link_id") REFERENCES "public"."external_message_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_commands" ADD CONSTRAINT "external_reaction_commands_raft_message_id_messages_id_fk" FOREIGN KEY ("raft_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_facts" ADD CONSTRAINT "external_reaction_facts_inbound_event_id_external_inbound_events_id_fk" FOREIGN KEY ("inbound_event_id") REFERENCES "public"."external_inbound_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_facts" ADD CONSTRAINT "external_reaction_facts_message_link_id_external_message_links_id_fk" FOREIGN KEY ("message_link_id") REFERENCES "public"."external_message_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_facts" ADD CONSTRAINT "external_reaction_facts_raft_message_id_messages_id_fk" FOREIGN KEY ("raft_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_facts" ADD CONSTRAINT "external_reaction_facts_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_states" ADD CONSTRAINT "external_reaction_states_message_link_id_external_message_links_id_fk" FOREIGN KEY ("message_link_id") REFERENCES "public"."external_message_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_states" ADD CONSTRAINT "external_reaction_states_raft_message_id_messages_id_fk" FOREIGN KEY ("raft_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_reaction_states" ADD CONSTRAINT "external_reaction_states_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_reaction_attempt_number" ON "external_reaction_command_attempts" USING btree ("command_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_reaction_command_revision" ON "external_reaction_commands" USING btree ("message_link_id","provider_reaction_key","desired_revision");--> statement-breakpoint
CREATE INDEX "idx_external_reaction_command_due" ON "external_reaction_commands" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_reaction_fact_event" ON "external_reaction_facts" USING btree ("provider","app_registration_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "idx_external_reaction_fact_message" ON "external_reaction_facts" USING btree ("raft_message_id","event_occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_reaction_state_identity" ON "external_reaction_states" USING btree ("binding_id","binding_epoch","message_link_id","projection_id","provider_reaction_key");--> statement-breakpoint
CREATE INDEX "idx_external_reaction_state_message" ON "external_reaction_states" USING btree ("raft_message_id","canonical_emoji","present");--> statement-breakpoint
ALTER TABLE "external_inbound_events" ADD CONSTRAINT "external_inbound_event_coordinates_valid" CHECK (length(btrim("external_inbound_events"."provider")) > 0
      AND length(btrim("external_inbound_events"."app_registration_id")) > 0
      AND length(btrim("external_inbound_events"."install_id")) > 0
      AND length(btrim("external_inbound_events"."workspace_id")) > 0
      AND length(btrim("external_inbound_events"."provider_authority_id")) > 0
      AND length(btrim("external_inbound_events"."provider_conversation_id")) > 0
      AND length(btrim("external_inbound_events"."provider_event_id")) > 0
      AND length(btrim("external_inbound_events"."binding_id")) > 0
      AND length(btrim("external_inbound_events"."runtime_revision")) > 0
      AND length("external_inbound_events"."provider") <= 80
      AND length("external_inbound_events"."app_registration_id") <= 320
      AND length("external_inbound_events"."install_id") <= 160
      AND length("external_inbound_events"."workspace_id") <= 320
      AND length("external_inbound_events"."provider_authority_id") <= 160
      AND length("external_inbound_events"."provider_conversation_id") <= 160
      AND length("external_inbound_events"."provider_event_id") <= 320
      AND length("external_inbound_events"."binding_id") <= 160
      AND length("external_inbound_events"."runtime_revision") <= 320
      AND "external_inbound_events"."binding_epoch" > 0 AND "external_inbound_events"."connection_epoch" > 0
      AND "external_inbound_events"."privacy_class" IN ('public', 'private')
      AND "external_inbound_events"."environment" IN ('test', 'production')
      AND "external_inbound_events"."normalized_payload_digest" ~ '^[0-9a-f]{64}$'
      AND "external_inbound_events"."payload_aad_purpose" = 'external-inbound-normalized-event'
      AND "external_inbound_events"."payload_aad_version" = 1 AND "external_inbound_events"."payload_schema_version" IN (1, 2, 3));--> statement-breakpoint
ALTER TABLE "external_ingress_discard_receipts" ADD CONSTRAINT "external_ingress_discard_coordinates_valid" CHECK (length(btrim("external_ingress_discard_receipts"."provider")) > 0
      AND length("external_ingress_discard_receipts"."provider") <= 80
      AND "external_ingress_discard_receipts"."provider" = 'slack'
      AND "external_ingress_discard_receipts"."environment" IN ('test', 'production')
      AND "external_ingress_discard_receipts"."endpoint_revision" > 0
      AND "external_ingress_discard_receipts"."signing_secret_revision" > 0
      AND length(btrim("external_ingress_discard_receipts"."provider_authority_id")) > 0
      AND length("external_ingress_discard_receipts"."provider_authority_id") <= 160
      AND ("external_ingress_discard_receipts"."provider_conversation_id" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."provider_conversation_id")) > 0
        AND length("external_ingress_discard_receipts"."provider_conversation_id") <= 160
      ))
      AND length(btrim("external_ingress_discard_receipts"."provider_event_id")) > 0
      AND length("external_ingress_discard_receipts"."provider_event_id") <= 320
      AND length(btrim("external_ingress_discard_receipts"."outcome_reason")) > 0
      AND length("external_ingress_discard_receipts"."outcome_reason") <= 160
      AND "external_ingress_discard_receipts"."outcome_reason" IN (
        'unsupported_event',
        'provider_tokens_unrelated',
        'provider_loop_suppressed',
        'unsupported_message_subtype',
        'capability_disabled'
      )
      AND ("external_ingress_discard_receipts"."slack_retry_num" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_num")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_num") <= 32
      ))
      AND ("external_ingress_discard_receipts"."slack_retry_reason" IS NULL OR (
        length(btrim("external_ingress_discard_receipts"."slack_retry_reason")) > 0
        AND length("external_ingress_discard_receipts"."slack_retry_reason") <= 160
      ))
      AND "external_ingress_discard_receipts"."payload_digest" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
-- Reaction sync remains operator-owned and fail closed. Seed only the flag
-- definition; no allow rule or default-on behavior is created here.
INSERT INTO "feature_flags" (
	"key",
	"description",
	"enabled",
	"kill_switch",
	"randomization_unit",
	"default_enabled",
	"default_variant",
	"salt"
) VALUES (
	'slack_reaction_sync',
	'Slack Bridge bidirectional reaction synchronization',
	true,
	false,
	'server',
	false,
	NULL,
	'slack_reaction_sync'
) ON CONFLICT ("key") DO NOTHING;
