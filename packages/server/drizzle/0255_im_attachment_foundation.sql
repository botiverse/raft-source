CREATE TABLE "external_attachment_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_direction" text NOT NULL,
	"provider" text NOT NULL,
	"app_registration_id" text NOT NULL,
	"install_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_authority_id" text NOT NULL,
	"provider_file_id" text NOT NULL,
	"filename" text,
	"declared_size_bytes" bigint,
	"mime_type" text,
	"provider_created_at" timestamp with time zone,
	"materialization_owner_job_id" uuid,
	"source_content_digest" text,
	"raft_object_id" uuid,
	"state" text DEFAULT 'observed' NOT NULL,
	"terminal_failure_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_attachment_asset_coordinates" CHECK (length(btrim("external_attachment_assets"."provider")) > 0 AND length("external_attachment_assets"."provider") <= 80
      AND length(btrim("external_attachment_assets"."app_registration_id")) > 0 AND length("external_attachment_assets"."app_registration_id") <= 320
      AND length(btrim("external_attachment_assets"."install_id")) > 0 AND length("external_attachment_assets"."install_id") <= 160
      AND length(btrim("external_attachment_assets"."workspace_id")) > 0 AND length("external_attachment_assets"."workspace_id") <= 320
      AND length(btrim("external_attachment_assets"."provider_authority_id")) > 0 AND length("external_attachment_assets"."provider_authority_id") <= 160
      AND length(btrim("external_attachment_assets"."provider_file_id")) > 0 AND length("external_attachment_assets"."provider_file_id") <= 320),
	CONSTRAINT "external_attachment_asset_origin" CHECK ("external_attachment_assets"."origin_direction" = 'provider_inbound'
      OR ("external_attachment_assets"."origin_direction" = 'raft_outbound' AND "external_attachment_assets"."raft_object_id" IS NOT NULL)),
	CONSTRAINT "external_attachment_asset_materialization" CHECK (("external_attachment_assets"."origin_direction" = 'raft_outbound' AND "external_attachment_assets"."materialization_owner_job_id" IS NULL)
      OR ("external_attachment_assets"."origin_direction" = 'provider_inbound' AND (
        ("external_attachment_assets"."state" = 'observed' AND "external_attachment_assets"."materialization_owner_job_id" IS NULL)
        OR "external_attachment_assets"."state" = 'metadata_ready'
        OR ("external_attachment_assets"."state" IN ('transferring', 'stored', 'linked')
          AND "external_attachment_assets"."materialization_owner_job_id" IS NOT NULL)
        OR "external_attachment_assets"."state" IN ('failed', 'revoked')
      ))),
	CONSTRAINT "external_attachment_asset_metadata" CHECK (("external_attachment_assets"."declared_size_bytes" IS NULL OR "external_attachment_assets"."declared_size_bytes" > 0)
      AND ("external_attachment_assets"."filename" IS NULL OR (length(btrim("external_attachment_assets"."filename")) > 0 AND length("external_attachment_assets"."filename") <= 1024))
      AND ("external_attachment_assets"."mime_type" IS NULL OR (length(btrim("external_attachment_assets"."mime_type")) > 0 AND length("external_attachment_assets"."mime_type") <= 255))
      AND ("external_attachment_assets"."source_content_digest" IS NULL OR "external_attachment_assets"."source_content_digest" ~ '^[0-9a-f]{64}$')
      AND ("external_attachment_assets"."state" = 'observed' OR "external_attachment_assets"."state" IN ('failed', 'revoked') OR (
        "external_attachment_assets"."filename" IS NOT NULL AND "external_attachment_assets"."declared_size_bytes" IS NOT NULL AND "external_attachment_assets"."mime_type" IS NOT NULL
      ))
      AND ("external_attachment_assets"."state" NOT IN ('stored', 'linked') OR (
        "external_attachment_assets"."raft_object_id" IS NOT NULL AND "external_attachment_assets"."source_content_digest" IS NOT NULL
      ))),
	CONSTRAINT "external_attachment_asset_state" CHECK ("external_attachment_assets"."state" IN ('observed', 'metadata_ready', 'transferring', 'stored', 'linked', 'failed', 'revoked')
      AND (("external_attachment_assets"."state" IN ('failed', 'revoked')
        AND "external_attachment_assets"."terminal_failure_class" IS NOT NULL
        AND length(btrim("external_attachment_assets"."terminal_failure_class")) > 0
        AND length("external_attachment_assets"."terminal_failure_class") <= 160)
      OR ("external_attachment_assets"."state" NOT IN ('failed', 'revoked') AND "external_attachment_assets"."terminal_failure_class" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "external_attachment_message_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"inbound_event_id" uuid,
	"message_link_id" uuid,
	"asset_id" uuid NOT NULL,
	"source_actor_projection_id" uuid,
	"provider_authority_id" text NOT NULL,
	"connection_epoch" integer NOT NULL,
	"binding_id" text NOT NULL,
	"binding_epoch" integer NOT NULL,
	"attachment_projection_id" uuid,
	"ordered_position" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"terminal_failure_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_attachment_message_coordinates" CHECK ("external_attachment_message_facts"."ordered_position" >= 0
      AND length(btrim("external_attachment_message_facts"."provider_authority_id")) > 0 AND length("external_attachment_message_facts"."provider_authority_id") <= 160
      AND length(btrim("external_attachment_message_facts"."binding_id")) > 0 AND length("external_attachment_message_facts"."binding_id") <= 160
      AND "external_attachment_message_facts"."connection_epoch" > 0 AND "external_attachment_message_facts"."binding_epoch" > 0
      AND (("external_attachment_message_facts"."direction" = 'provider_inbound' AND "external_attachment_message_facts"."inbound_event_id" IS NOT NULL
          AND "external_attachment_message_facts"."source_actor_projection_id" IS NOT NULL)
        OR ("external_attachment_message_facts"."direction" = 'raft_outbound' AND "external_attachment_message_facts"."inbound_event_id" IS NULL
          AND "external_attachment_message_facts"."source_actor_projection_id" IS NULL AND "external_attachment_message_facts"."message_link_id" IS NOT NULL))),
	CONSTRAINT "external_attachment_message_state" CHECK ("external_attachment_message_facts"."direction" IN ('provider_inbound', 'raft_outbound')
      AND "external_attachment_message_facts"."state" IN ('pending', 'stored', 'linked', 'unavailable', 'revoked')
      AND ("external_attachment_message_facts"."state" IN ('stored', 'linked')) = ("external_attachment_message_facts"."attachment_projection_id" IS NOT NULL)
      AND ("external_attachment_message_facts"."state" <> 'linked' OR "external_attachment_message_facts"."message_link_id" IS NOT NULL)
      AND (("external_attachment_message_facts"."state" IN ('unavailable', 'revoked')
        AND "external_attachment_message_facts"."terminal_failure_class" IS NOT NULL
        AND length(btrim("external_attachment_message_facts"."terminal_failure_class")) > 0
        AND length("external_attachment_message_facts"."terminal_failure_class") <= 160)
      OR ("external_attachment_message_facts"."state" IN ('pending', 'stored', 'linked') AND "external_attachment_message_facts"."terminal_failure_class" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "external_attachment_transfer_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"asset_id" uuid,
	"message_fact_id" uuid,
	"outbound_delivery_id" uuid,
	"source_attachment_id" uuid,
	"frozen_object_id" uuid,
	"frozen_origin_server_id" uuid,
	"frozen_storage_key" text,
	"frozen_filename" text,
	"frozen_mime_type" text,
	"frozen_size_bytes" bigint,
	"frozen_content_digest" text,
	"phase" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_generation" bigint DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"started_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_attachment_transfer_coordinates" CHECK (("external_attachment_transfer_jobs"."direction" = 'provider_inbound'
        AND "external_attachment_transfer_jobs"."asset_id" IS NOT NULL AND "external_attachment_transfer_jobs"."message_fact_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."outbound_delivery_id" IS NULL AND "external_attachment_transfer_jobs"."source_attachment_id" IS NULL)
      OR ("external_attachment_transfer_jobs"."direction" = 'raft_outbound'
        AND "external_attachment_transfer_jobs"."message_fact_id" IS NULL
        AND "external_attachment_transfer_jobs"."outbound_delivery_id" IS NOT NULL AND "external_attachment_transfer_jobs"."source_attachment_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_object_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_origin_server_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_storage_key" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_filename" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_mime_type" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" IS NOT NULL
        AND "external_attachment_transfer_jobs"."frozen_content_digest" IS NOT NULL)),
	CONSTRAINT "external_attachment_transfer_snapshot" CHECK (("external_attachment_transfer_jobs"."direction" = 'provider_inbound'
        AND "external_attachment_transfer_jobs"."frozen_object_id" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_origin_server_id" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_storage_key" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_filename" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_mime_type" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" IS NULL
        AND "external_attachment_transfer_jobs"."frozen_content_digest" IS NULL)
      OR ("external_attachment_transfer_jobs"."direction" = 'raft_outbound'
        AND length(btrim("external_attachment_transfer_jobs"."frozen_storage_key")) > 0 AND length("external_attachment_transfer_jobs"."frozen_storage_key") <= 1024
        AND length(btrim("external_attachment_transfer_jobs"."frozen_filename")) > 0 AND length("external_attachment_transfer_jobs"."frozen_filename") <= 1024
        AND length(btrim("external_attachment_transfer_jobs"."frozen_mime_type")) > 0 AND length("external_attachment_transfer_jobs"."frozen_mime_type") <= 255
        AND "external_attachment_transfer_jobs"."frozen_size_bytes" > 0
        AND "external_attachment_transfer_jobs"."frozen_content_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "external_attachment_transfer_state" CHECK ("external_attachment_transfer_jobs"."phase" IN ('metadata', 'download', 'store', 'ticket', 'upload', 'complete', 'correlate', 'link')
      AND "external_attachment_transfer_jobs"."state" IN ('queued', 'leased', 'retry_wait', 'outcome_unknown', 'completed', 'failed', 'revoked', 'quarantined')
      AND "external_attachment_transfer_jobs"."attempts" >= 0
      AND ("external_attachment_transfer_jobs"."last_error_class" IS NULL OR (
        length(btrim("external_attachment_transfer_jobs"."last_error_class")) > 0 AND length("external_attachment_transfer_jobs"."last_error_class") <= 160
      ))
      AND ("external_attachment_transfer_jobs"."direction" = 'provider_inbound' AND "external_attachment_transfer_jobs"."phase" IN ('metadata', 'download', 'store', 'link')
        OR "external_attachment_transfer_jobs"."direction" = 'raft_outbound' AND "external_attachment_transfer_jobs"."phase" IN ('ticket', 'upload', 'complete', 'correlate', 'link'))
      AND ("external_attachment_transfer_jobs"."state" IN ('retry_wait', 'outcome_unknown', 'failed', 'revoked', 'quarantined'))
        = ("external_attachment_transfer_jobs"."last_error_class" IS NOT NULL)
      AND ("external_attachment_transfer_jobs"."state" <> 'outcome_unknown' OR "external_attachment_transfer_jobs"."phase" IN ('upload', 'complete', 'correlate'))
      AND ("external_attachment_transfer_jobs"."state" <> 'completed' OR "external_attachment_transfer_jobs"."phase" = 'link')),
	CONSTRAINT "external_attachment_transfer_lease" CHECK (("external_attachment_transfer_jobs"."state" = 'leased'
        AND "external_attachment_transfer_jobs"."lease_id" IS NOT NULL
        AND "external_attachment_transfer_jobs"."lease_owner" IS NOT NULL
        AND length(btrim("external_attachment_transfer_jobs"."lease_owner")) > 0
        AND length("external_attachment_transfer_jobs"."lease_owner") <= 160
        AND "external_attachment_transfer_jobs"."lease_expires_at" IS NOT NULL
        AND "external_attachment_transfer_jobs"."lease_generation" > 0)
      OR ("external_attachment_transfer_jobs"."state" <> 'leased'
        AND "external_attachment_transfer_jobs"."lease_id" IS NULL
        AND "external_attachment_transfer_jobs"."lease_owner" IS NULL
        AND "external_attachment_transfer_jobs"."lease_expires_at" IS NULL
        AND "external_attachment_transfer_jobs"."lease_generation" >= 0)),
	CONSTRAINT "external_attachment_transfer_terminal" CHECK (("external_attachment_transfer_jobs"."state" IN ('completed', 'failed', 'revoked', 'quarantined')
        AND "external_attachment_transfer_jobs"."terminal_at" IS NOT NULL)
      OR ("external_attachment_transfer_jobs"."state" NOT IN ('completed', 'failed', 'revoked', 'quarantined')
        AND "external_attachment_transfer_jobs"."terminal_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attachment_objects" DROP CONSTRAINT "attachment_objects_uploader_type";--> statement-breakpoint
ALTER TABLE "attachment_transfer_intents" DROP CONSTRAINT "attachment_transfer_intents_uploader_type";--> statement-breakpoint
ALTER TABLE "attachment_upload_reservations" DROP CONSTRAINT "attachment_upload_reservations_creator_type";--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_created_by_consistency";--> statement-breakpoint
DROP INDEX "uq_attachment_upload_reservations_object";--> statement-breakpoint
ALTER TABLE "external_attachment_assets" ADD CONSTRAINT "external_attachment_assets_raft_object_id_attachment_objects_id_fk" FOREIGN KEY ("raft_object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_message_facts" ADD CONSTRAINT "external_attachment_message_facts_inbound_event_id_external_inbound_events_id_fk" FOREIGN KEY ("inbound_event_id") REFERENCES "public"."external_inbound_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_message_facts" ADD CONSTRAINT "external_attachment_message_facts_message_link_id_external_message_links_id_fk" FOREIGN KEY ("message_link_id") REFERENCES "public"."external_message_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_message_facts" ADD CONSTRAINT "external_attachment_message_facts_asset_id_external_attachment_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."external_attachment_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_message_facts" ADD CONSTRAINT "external_attachment_message_facts_source_actor_projection_id_external_actor_projections_id_fk" FOREIGN KEY ("source_actor_projection_id") REFERENCES "public"."external_actor_projections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_message_facts" ADD CONSTRAINT "external_attachment_message_facts_attachment_projection_id_attachments_id_fk" FOREIGN KEY ("attachment_projection_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_jobs_asset_id_external_attachment_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."external_attachment_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_jobs_message_fact_id_external_attachment_message_facts_id_fk" FOREIGN KEY ("message_fact_id") REFERENCES "public"."external_attachment_message_facts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_jobs_outbound_delivery_id_external_outbound_deliveries_id_fk" FOREIGN KEY ("outbound_delivery_id") REFERENCES "public"."external_outbound_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_jobs_source_attachment_id_attachments_id_fk" FOREIGN KEY ("source_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_attachment_transfer_jobs" ADD CONSTRAINT "external_attachment_transfer_jobs_frozen_object_id_attachment_objects_id_fk" FOREIGN KEY ("frozen_object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_provider_file" ON "external_attachment_assets" USING btree ("provider","app_registration_id","install_id","workspace_id","provider_file_id");--> statement-breakpoint
CREATE INDEX "idx_external_attachment_asset_state" ON "external_attachment_assets" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_external_attachment_asset_object" ON "external_attachment_assets" USING btree ("raft_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_inbound_event_asset" ON "external_attachment_message_facts" USING btree ("inbound_event_id","asset_id") WHERE "external_attachment_message_facts"."direction" = 'provider_inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_inbound_event_position" ON "external_attachment_message_facts" USING btree ("inbound_event_id","ordered_position") WHERE "external_attachment_message_facts"."direction" = 'provider_inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_outbound_message_asset" ON "external_attachment_message_facts" USING btree ("message_link_id","asset_id") WHERE "external_attachment_message_facts"."direction" = 'raft_outbound';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_outbound_message_position" ON "external_attachment_message_facts" USING btree ("message_link_id","ordered_position") WHERE "external_attachment_message_facts"."direction" = 'raft_outbound';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_message_projection" ON "external_attachment_message_facts" USING btree ("attachment_projection_id") WHERE "external_attachment_message_facts"."attachment_projection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_external_attachment_message_state" ON "external_attachment_message_facts" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_transfer_inbound" ON "external_attachment_transfer_jobs" USING btree ("message_fact_id") WHERE "external_attachment_transfer_jobs"."direction" = 'provider_inbound';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_external_attachment_transfer_outbound" ON "external_attachment_transfer_jobs" USING btree ("outbound_delivery_id","source_attachment_id") WHERE "external_attachment_transfer_jobs"."direction" = 'raft_outbound';--> statement-breakpoint
CREATE INDEX "idx_external_attachment_transfer_claim" ON "external_attachment_transfer_jobs" USING btree ("state","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_reservations_object" ON "attachment_upload_reservations" USING btree ("object_id");--> statement-breakpoint
ALTER TABLE "attachment_objects" ADD CONSTRAINT "attachment_objects_uploader_type" CHECK ("attachment_objects"."uploader_type" IN ('user', 'agent', 'external_projection'));--> statement-breakpoint
ALTER TABLE "attachment_transfer_intents" ADD CONSTRAINT "attachment_transfer_intents_uploader_type" CHECK ("attachment_transfer_intents"."uploader_type" IN ('user', 'agent', 'external_projection'));--> statement-breakpoint
ALTER TABLE "attachment_upload_reservations" ADD CONSTRAINT "attachment_upload_reservations_creator_type" CHECK ("attachment_upload_reservations"."creator_type" IN ('user', 'agent', 'external_projection'));--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_type" CHECK ("attachments"."uploader_type" IN ('user', 'agent', 'external_projection'));--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_consistency" CHECK (("attachments"."created_by_id" IS NULL AND "attachments"."created_by_type" IS NULL)
      OR ("attachments"."created_by_id" IS NOT NULL AND "attachments"."created_by_type" IN ('user', 'agent', 'external_projection')));