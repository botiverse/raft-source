CREATE TABLE "attachment_transfer_artifacts" (
	"intent_id" uuid NOT NULL,
	"role" text NOT NULL,
	"backend" text NOT NULL,
	"storage_key" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"adopted_artifact_id" uuid,
	"delete_lease_id" uuid,
	"delete_lease_expires_at" timestamp with time zone,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_transfer_artifacts_intent_id_role_pk" PRIMARY KEY("intent_id","role"),
	CONSTRAINT "attachment_transfer_artifacts_role" CHECK ("attachment_transfer_artifacts"."role" IN ('original', 'thumbnail', 'svg_raster_preview')),
	CONSTRAINT "attachment_transfer_artifacts_backend" CHECK ("attachment_transfer_artifacts"."backend" IN ('attachment', 'cdn')),
	CONSTRAINT "attachment_transfer_artifacts_state" CHECK ("attachment_transfer_artifacts"."state" IN ('planned', 'adopted', 'deleting', 'deleted')),
	CONSTRAINT "attachment_transfer_artifacts_attempts_nonnegative" CHECK ("attachment_transfer_artifacts"."delete_attempts" >= 0),
	CONSTRAINT "attachment_transfer_artifacts_state_consistency" CHECK (("attachment_transfer_artifacts"."state" = 'planned' AND "attachment_transfer_artifacts"."adopted_artifact_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_expires_at" IS NULL)
      OR ("attachment_transfer_artifacts"."state" = 'adopted' AND "attachment_transfer_artifacts"."adopted_artifact_id" IS NOT NULL AND "attachment_transfer_artifacts"."delete_lease_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_expires_at" IS NULL)
      OR ("attachment_transfer_artifacts"."state" = 'deleting' AND "attachment_transfer_artifacts"."adopted_artifact_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_id" IS NOT NULL AND "attachment_transfer_artifacts"."delete_lease_expires_at" IS NOT NULL)
      OR ("attachment_transfer_artifacts"."state" = 'deleted' AND "attachment_transfer_artifacts"."adopted_artifact_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_id" IS NULL AND "attachment_transfer_artifacts"."delete_lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "attachment_transfer_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"reservation_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"uploader_id" text NOT NULL,
	"uploader_type" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"terminal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_transfer_intents_uploader_type" CHECK ("attachment_transfer_intents"."uploader_type" IN ('user', 'agent')),
	CONSTRAINT "attachment_transfer_intents_size_positive" CHECK ("attachment_transfer_intents"."declared_size_bytes" > 0),
	CONSTRAINT "attachment_transfer_intents_state" CHECK ("attachment_transfer_intents"."state" IN ('planned', 'completed', 'canceled', 'expired', 'failed')),
	CONSTRAINT "attachment_transfer_intents_terminal_consistency" CHECK (("attachment_transfer_intents"."state" = 'planned' AND "attachment_transfer_intents"."completed_at" IS NULL AND "attachment_transfer_intents"."terminal_reason" IS NULL)
      OR ("attachment_transfer_intents"."state" = 'completed' AND "attachment_transfer_intents"."completed_at" IS NOT NULL AND "attachment_transfer_intents"."terminal_reason" IS NULL)
      OR ("attachment_transfer_intents"."state" IN ('canceled', 'expired', 'failed') AND "attachment_transfer_intents"."completed_at" IS NULL AND "attachment_transfer_intents"."terminal_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD COLUMN "transfer_intent_id" uuid;--> statement-breakpoint
UPDATE "attachment_upload_sessions"
SET "object_id" = gen_random_uuid()
WHERE "state" IN ('pending', 'verifying')
  AND "object_id" IS NULL;--> statement-breakpoint
INSERT INTO "attachment_transfer_intents" (
	"id",
	"reservation_id",
	"object_id",
	"server_id",
	"channel_id",
	"uploader_id",
	"uploader_type",
	"filename",
	"mime_type",
	"declared_size_bytes",
	"state",
	"expires_at",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"attachment_id",
	"object_id",
	"server_id",
	"channel_id",
	"uploader_id",
	"uploader_type",
	"filename",
	"mime_type",
	"declared_size_bytes",
	'planned',
	"expires_at",
	"created_at",
	"updated_at"
FROM "attachment_upload_sessions"
WHERE "state" IN ('pending', 'verifying')
  AND "object_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "attachment_transfer_artifacts" (
	"intent_id",
	"role",
	"backend",
	"storage_key",
	"state",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	'original',
	'attachment',
	"storage_key",
	'planned',
	"created_at",
	"updated_at"
FROM "attachment_upload_sessions"
WHERE "state" IN ('pending', 'verifying')
  AND "object_id" IS NOT NULL;--> statement-breakpoint
UPDATE "attachment_upload_sessions"
SET "transfer_intent_id" = "id"
WHERE "state" IN ('pending', 'verifying')
  AND "object_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment_transfer_artifacts" ADD CONSTRAINT "attachment_transfer_artifacts_intent_id_attachment_transfer_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."attachment_transfer_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_transfer_artifacts" ADD CONSTRAINT "attachment_transfer_artifacts_adopted_artifact_id_attachment_storage_artifacts_id_fk" FOREIGN KEY ("adopted_artifact_id") REFERENCES "public"."attachment_storage_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_transfer_artifacts_backend_key" ON "attachment_transfer_artifacts" USING btree ("backend","storage_key");--> statement-breakpoint
CREATE INDEX "idx_attachment_transfer_artifacts_cleanup" ON "attachment_transfer_artifacts" USING btree ("state","delete_lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_transfer_intents_reservation" ON "attachment_transfer_intents" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_transfer_intents_object" ON "attachment_transfer_intents" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "idx_attachment_transfer_intents_expiry" ON "attachment_transfer_intents" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "attachment_upload_sessions" ADD CONSTRAINT "attachment_upload_sessions_transfer_intent_id_attachment_transfer_intents_id_fk" FOREIGN KEY ("transfer_intent_id") REFERENCES "public"."attachment_transfer_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attachment_upload_sessions_transfer_intent" ON "attachment_upload_sessions" USING btree ("transfer_intent_id");
