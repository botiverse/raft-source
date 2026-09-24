CREATE TABLE "attachment_artifact_inventory_observations" (
	"run_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"result" text NOT NULL,
	"size_bytes" bigint,
	"error_class" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_artifact_inventory_observations_run_id_artifact_id_pk" PRIMARY KEY("run_id","artifact_id"),
	CONSTRAINT "attachment_artifact_inventory_observations_result" CHECK ("attachment_artifact_inventory_observations"."result" IN ('exists', 'missing', 'unverified')),
	CONSTRAINT "attachment_artifact_inventory_observations_consistency" CHECK (("attachment_artifact_inventory_observations"."result" = 'exists' AND "attachment_artifact_inventory_observations"."size_bytes" IS NOT NULL AND "attachment_artifact_inventory_observations"."size_bytes" >= 0 AND "attachment_artifact_inventory_observations"."error_class" IS NULL)
      OR ("attachment_artifact_inventory_observations"."result" = 'missing' AND "attachment_artifact_inventory_observations"."size_bytes" IS NULL AND "attachment_artifact_inventory_observations"."error_class" IS NULL)
      OR ("attachment_artifact_inventory_observations"."result" = 'unverified' AND "attachment_artifact_inventory_observations"."size_bytes" IS NULL AND "attachment_artifact_inventory_observations"."error_class" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "attachment_artifact_inventory_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"evidence_source" text NOT NULL,
	"source_revision" text NOT NULL,
	"inventory_digest" text NOT NULL,
	"scope_server_id" uuid,
	"object_count" integer NOT NULL,
	"artifact_count" integer NOT NULL,
	"observation_count" integer NOT NULL,
	"classification_count" integer NOT NULL,
	"legacy_objectless_projection_count" integer NOT NULL,
	"dangling_projection_count" integer NOT NULL,
	"metadata_mismatch_count" integer NOT NULL,
	"deleted_origin_server_object_count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_artifact_inventory_runs_counts_nonnegative" CHECK ("attachment_artifact_inventory_runs"."object_count" >= 0
    AND "attachment_artifact_inventory_runs"."artifact_count" >= 0
    AND "attachment_artifact_inventory_runs"."observation_count" >= 0
    AND "attachment_artifact_inventory_runs"."classification_count" >= 0
    AND "attachment_artifact_inventory_runs"."legacy_objectless_projection_count" >= 0
    AND "attachment_artifact_inventory_runs"."dangling_projection_count" >= 0
    AND "attachment_artifact_inventory_runs"."metadata_mismatch_count" >= 0
    AND "attachment_artifact_inventory_runs"."deleted_origin_server_object_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_object_inventory_classifications" (
	"run_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"semantic_class" text NOT NULL,
	"bytes_evidence" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_object_inventory_classifications_run_id_object_id_pk" PRIMARY KEY("run_id","object_id"),
	CONSTRAINT "attachment_object_inventory_classifications_semantic" CHECK ("attachment_object_inventory_classifications"."semantic_class" IN ('live', 'pending_migratable', 'terminal_proven', 'shared_artifact_blocked', 'legacy_unknown')),
	CONSTRAINT "attachment_object_inventory_classifications_bytes" CHECK ("attachment_object_inventory_classifications"."bytes_evidence" IN ('bytes_verified', 'bytes_missing', 'bytes_unverified'))
);
--> statement-breakpoint
ALTER TABLE "attachment_artifact_inventory_observations" ADD CONSTRAINT "attachment_artifact_inventory_observations_run_id_attachment_artifact_inventory_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."attachment_artifact_inventory_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_artifact_inventory_observations" ADD CONSTRAINT "attachment_artifact_inventory_observations_artifact_id_attachment_storage_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."attachment_storage_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_object_inventory_classifications" ADD CONSTRAINT "attachment_object_inventory_classifications_run_id_attachment_artifact_inventory_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."attachment_artifact_inventory_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_object_inventory_classifications" ADD CONSTRAINT "attachment_object_inventory_classifications_object_id_attachment_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."attachment_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attachment_artifact_inventory_observations_artifact" ON "attachment_artifact_inventory_observations" USING btree ("artifact_id","observed_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_artifact_inventory_runs_observed" ON "attachment_artifact_inventory_runs" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_artifact_inventory_runs_scope" ON "attachment_artifact_inventory_runs" USING btree ("scope_server_id","observed_at");--> statement-breakpoint
CREATE INDEX "idx_attachment_object_inventory_classifications_object" ON "attachment_object_inventory_classifications" USING btree ("object_id","observed_at");