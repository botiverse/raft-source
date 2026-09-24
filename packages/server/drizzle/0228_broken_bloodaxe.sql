CREATE TABLE "attachment_object_artifacts" (
	"object_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_artifacts_object_id_role_pk" PRIMARY KEY("object_id","role"),
	CONSTRAINT "attachment_object_artifacts_role" CHECK ("attachment_object_artifacts"."role" IN ('original', 'thumbnail', 'svg_raster_preview', 'future_derived'))
);
--> statement-breakpoint
CREATE TABLE "attachment_object_gc_jobs" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"gc_token" uuid NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_gc_jobs_state" CHECK ("attachment_object_gc_jobs"."state" IN ('ready', 'leased', 'retry', 'blocked', 'completed', 'dead_letter')),
	CONSTRAINT "attachment_object_gc_jobs_attempts_nonnegative" CHECK ("attachment_object_gc_jobs"."attempts" >= 0),
	CONSTRAINT "attachment_object_gc_jobs_lease_consistency" CHECK (("attachment_object_gc_jobs"."state" = 'leased' AND "attachment_object_gc_jobs"."lease_id" IS NOT NULL AND "attachment_object_gc_jobs"."lease_expires_at" IS NOT NULL)
      OR ("attachment_object_gc_jobs"."state" <> 'leased' AND "attachment_object_gc_jobs"."lease_id" IS NULL AND "attachment_object_gc_jobs"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "attachment_storage_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"backend" text NOT NULL,
	"storage_key" text NOT NULL,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"availability_state" text DEFAULT 'unverified' NOT NULL,
	"availability_observed_at" timestamp with time zone,
	"delete_token" uuid,
	"delete_lease_id" uuid,
	"delete_lease_expires_at" timestamp with time zone,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_storage_artifacts_backend" CHECK ("attachment_storage_artifacts"."backend" IN ('attachment', 'cdn')),
	CONSTRAINT "attachment_storage_artifacts_lifecycle" CHECK ("attachment_storage_artifacts"."lifecycle_state" IN ('active', 'delete_pending', 'deleted')),
	CONSTRAINT "attachment_storage_artifacts_availability" CHECK ("attachment_storage_artifacts"."availability_state" IN ('unverified', 'verified', 'missing')),
	CONSTRAINT "attachment_storage_artifacts_delete_consistency" CHECK (("attachment_storage_artifacts"."lifecycle_state" = 'active' AND "attachment_storage_artifacts"."delete_token" IS NULL AND "attachment_storage_artifacts"."delete_lease_id" IS NULL AND "attachment_storage_artifacts"."delete_lease_expires_at" IS NULL)
      OR ("attachment_storage_artifacts"."lifecycle_state" = 'delete_pending' AND "attachment_storage_artifacts"."delete_token" IS NOT NULL)
      OR ("attachment_storage_artifacts"."lifecycle_state" = 'deleted' AND "attachment_storage_artifacts"."delete_token" IS NOT NULL AND "attachment_storage_artifacts"."delete_lease_id" IS NULL AND "attachment_storage_artifacts"."delete_lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "attachment_upload_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"origin_server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"creator_id" text NOT NULL,
	"creator_type" text NOT NULL,
	"filename" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text,
	"consumed_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_upload_reservations_creator_type" CHECK ("attachment_upload_reservations"."creator_type" IN ('user', 'agent')),
	CONSTRAINT "attachment_upload_reservations_state" CHECK ("attachment_upload_reservations"."state" IN ('pending', 'consumed', 'canceled', 'expired')),
	CONSTRAINT "attachment_upload_reservations_terminal_consistency" CHECK (("attachment_upload_reservations"."state" = 'pending' AND "attachment_upload_reservations"."terminal_at" IS NULL AND "attachment_upload_reservations"."terminal_reason" IS NULL AND "attachment_upload_reservations"."consumed_message_id" IS NULL)
      OR ("attachment_upload_reservations"."state" = 'consumed' AND "attachment_upload_reservations"."terminal_at" IS NOT NULL AND "attachment_upload_reservations"."consumed_message_id" IS NOT NULL)
      OR ("attachment_upload_reservations"."state" IN ('canceled', 'expired') AND "attachment_upload_reservations"."terminal_at" IS NOT NULL AND "attachment_upload_reservations"."terminal_reason" IS NOT NULL AND "attachment_upload_reservations"."consumed_message_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "attachment_object_artifacts" ADD CONSTRAINT "attachment_object_artifacts_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_object_artifacts" ADD CONSTRAINT "attachment_object_artifacts_artifact_id_attachment_storage_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."attachment_storage_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_object_gc_jobs" ADD CONSTRAINT "attachment_object_gc_jobs_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_upload_reservations" ADD CONSTRAINT "attachment_upload_reservations_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_object_artifacts_artifact" ON "attachment_object_artifacts" USING btree ("artifact_id");--> statement-breakpoint
CREATE INDEX "idx_attachment_object_gc_jobs_claim" ON "attachment_object_gc_jobs" USING btree ("state","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_storage_artifacts_backend_key" ON "attachment_storage_artifacts" USING btree ("backend","storage_key");--> statement-breakpoint
CREATE INDEX "idx_attachment_storage_artifacts_delete" ON "attachment_storage_artifacts" USING btree ("lifecycle_state","delete_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_upload_reservations_object" ON "attachment_upload_reservations" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_reservations_expiry" ON "attachment_upload_reservations" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_upload_reservations_creator" ON "attachment_upload_reservations" USING btree ("origin_server_id","creator_type","creator_id");