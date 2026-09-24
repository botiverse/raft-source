CREATE TABLE "attachment_object_charges" (
	"object_id" uuid PRIMARY KEY NOT NULL,
	"origin_server_id" uuid NOT NULL,
	"charge_month" date NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_charges_size_nonnegative" CHECK ("attachment_object_charges"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_objects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_server_id" uuid NOT NULL,
	"uploader_id" text NOT NULL,
	"uploader_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumbnail_key" text,
	"content_hash" text,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"gc_token" uuid,
	"gc_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_objects_uploader_type" CHECK ("attachment_objects"."uploader_type" IN ('user', 'agent')),
	CONSTRAINT "attachment_objects_lifecycle_state" CHECK ("attachment_objects"."lifecycle_state" IN ('active', 'gc_pending', 'deleted')),
	CONSTRAINT "attachment_objects_gc_consistency" CHECK (("attachment_objects"."lifecycle_state" = 'active' AND "attachment_objects"."gc_token" IS NULL AND "attachment_objects"."gc_started_at" IS NULL)
      OR ("attachment_objects"."lifecycle_state" = 'gc_pending' AND "attachment_objects"."gc_token" IS NOT NULL AND "attachment_objects"."gc_started_at" IS NOT NULL)
      OR ("attachment_objects"."lifecycle_state" = 'deleted' AND "attachment_objects"."gc_token" IS NOT NULL AND "attachment_objects"."gc_started_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "attachment_projection_revocations" (
	"projection_id" uuid PRIMARY KEY NOT NULL,
	"object_id" uuid NOT NULL,
	"host_message_id" uuid NOT NULL,
	"request_server_id" uuid NOT NULL,
	"revoked_by_id" text NOT NULL,
	"revoked_by_type" text NOT NULL,
	"reason" text,
	"revoked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attachment_projection_revocations_actor_type" CHECK ("attachment_projection_revocations"."revoked_by_type" IN ('user', 'agent', 'machine', 'system'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "pending_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "created_by_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "created_by_type" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revoked_by_id" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revoked_by_type" text;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "attachment_object_charges" ADD CONSTRAINT "attachment_object_charges_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_object_charges_server_month" ON "attachment_object_charges" USING btree ("origin_server_id","charge_month");--> statement-breakpoint
CREATE INDEX "idx_attachment_objects_storage_key" ON "attachment_objects" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_attachment_objects_gc" ON "attachment_objects" USING btree ("lifecycle_state","gc_started_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_projection_revocations_object" ON "attachment_projection_revocations" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "idx_attachment_projection_revocations_message" ON "attachment_projection_revocations" USING btree ("host_message_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_pending_channel_id_channels_id_fk" FOREIGN KEY ("pending_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachments_object" ON "attachments" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "idx_attachments_pending_channel" ON "attachments" USING btree ("pending_channel_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_consistency" CHECK (("attachments"."created_by_id" IS NULL AND "attachments"."created_by_type" IS NULL)
      OR ("attachments"."created_by_id" IS NOT NULL AND "attachments"."created_by_type" IN ('user', 'agent')));--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_revocation_consistency" CHECK (("attachments"."revoked_at" IS NULL AND "attachments"."revoked_by_id" IS NULL AND "attachments"."revoked_by_type" IS NULL)
      OR ("attachments"."revoked_at" IS NOT NULL AND "attachments"."revoked_by_id" IS NOT NULL
        AND "attachments"."revoked_by_type" IN ('user', 'agent', 'machine', 'system')));