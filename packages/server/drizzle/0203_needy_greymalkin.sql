CREATE TABLE "agent_migration_chunk_receipts" (
	"migration_id" uuid NOT NULL,
	"transport_generation" text NOT NULL,
	"lease_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"source_etag" text,
	"source_receipt_at" timestamp with time zone,
	"target_receipt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_migration_chunk_receipts_migration_id_transport_generation_chunk_index_pk" PRIMARY KEY("migration_id","transport_generation","chunk_index")
);
--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_protocol" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_generation" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_lease_id" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_expected_migration_revision" integer;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_control_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_control_sha256" text;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_control_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "transport_upload_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_quiesce_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "agent_migrations" ADD COLUMN "source_quiesced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_migration_chunk_receipts" ADD CONSTRAINT "agent_migration_chunk_receipts_migration_id_agent_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."agent_migrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_migration_chunk_receipts_generation" ON "agent_migration_chunk_receipts" USING btree ("migration_id","transport_generation");